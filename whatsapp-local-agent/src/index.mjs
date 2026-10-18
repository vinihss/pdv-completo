import http from "node:http";
import { spawnSync } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { chromium } from "playwright";
import lockfile from "proper-lockfile";
import { extractChatIdentityFromMetadata, extractDirectContactId, isConfiguredTestContact, isNewVerifiedTestMessage, isWithinLast24Hours, parseChatActivityTimestamp } from "./filters.mjs";
import { classifyIntent } from "./classifier.mjs";
import { createPdvApi } from "./pdvApi.mjs";
import { isDryRunEnabled, outboxOutcomeAfterError, planOutboxDispatch, recoverOutboxStatus } from "./outbox-policy.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PDV_WA_PORT || 8765);
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "pdv-whatsapp-test");
const STATE_FILE = path.join(DATA_DIR, "session.enc");
const HISTORY_FILE = path.join(DATA_DIR, "history.sqlite.enc");
const KEY_SERVICE = "pdv-whatsapp-local-prototype";
const KEY_ACCOUNT = "session-encryption-key";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const DRY_RUN = isDryRunEnabled(process.env.PDV_WA_DRY_RUN);
const MESSAGES = {
  noPending: "Não encontrei pedido em andamento no momento. Quer fazer um pedido?\n1 - Sim, abrir cardápio\n2 - Não agora",
  pendingChoice: (orderId, label, situation) => `Encontrei o pedido #${orderId.slice(0, 8)}.\nStatus: ${label}. ${situation}\n\nQuer fazer um novo pedido?\n1 - Sim, abrir cardápio\n2 - Não, acompanhar o pedido atual`,
  clarifyIntent: "Entendi que sua mensagem é sobre pedido, mas não consegui identificar o que você precisa. Você quer fazer um novo pedido ou acompanhar um pedido existente?",
  trackingLink: (orderId, link) => `Tudo bem. Acompanhe o pedido #${orderId.slice(0, 8)} por aqui: ${link}`,
  noNewOrder: "Tudo bem. Quando quiser pedir, envie uma mensagem falando sobre pedido, cardápio ou entrega.",
  orderConfirmed: (orderId, stage, situation, link) => `Pedido confirmado! O pedido #${orderId.slice(0, 8)} foi registrado.\nStatus atual: ${stage}. ${situation}\nAcompanhe as próximas etapas: ${link}`,
};
const STAGE_SITUATION = {
  received: "A loja recebeu o pedido e ainda vai iniciar o preparo.",
  preparing: "A cozinha está preparando o pedido.",
  ready: "O pedido está pronto e aguarda a próxima etapa de retirada ou entrega.",
  out_for_delivery: "O pedido saiu para entrega.",
  delivered: "O sistema registra o pedido como entregue.",
  failed: "Houve um problema na entrega; a equipe precisa verificar.",
  cancelled: "O pedido foi cancelado.",
};
const pdvApi = createPdvApi({ apiBaseUrl: process.env.PDV_API_BASE_URL, publicOrderUrl: process.env.PDV_PUBLIC_ORDER_URL });
const testPhone = String(process.env.PDV_WA_TEST_PHONE || "").replace(/\D/g, "");
let browser;
let context;
let page;
let browserStartPromise;
let connectionState = "desconectado";
let lastError = "";
let lastScanWarning = "";
let lastInbound = "";
let processing = false;
let browserNavigationInProgress = false;
let activeChat = "";
let baselineMessageKey = "";
let lastProcessedMessageKey = "";
let sessionKey;
let historyKey;
let historyDb;
let SQL;
let qrCapturedAt = 0;
let qrBuffer;
let inboundTimer;
let orderWatchTimer;
let lastSaveAt = 0;
let watchingOrders = false;
let watchCursor = 0;
let lastIdleScanLogAt = 0;
let lastTestMessageKey = "";
let lastTestChatScanAt = 0;
let releaseProcessLock;
const lastUnreadRowLogAt = new Map();

function logEvent(event, details = {}) {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), component: "pdv-whatsapp-agent", event, ...details }));
}

async function acquireProcessLock() {
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  await chmod(DATA_DIR, DIR_MODE);
  try {
    releaseProcessLock = await lockfile.lock(DATA_DIR, {
      realpath: false,
      stale: 120_000,
      update: 30_000,
      retries: 0,
      onCompromised(error) {
        logEvent("agent.lock_compromised", { errorName: error?.name || "Error" });
        process.kill(process.pid, "SIGTERM");
      },
    });
  } catch (error) {
    if (error.code === "ELOCKED") throw new Error("Outra instância do agente já está em execução para este usuário/diretório de dados.");
    throw error;
  }
  logEvent("agent.lock_acquired", { pid: process.pid });
}

function secretTool(args, input = "") {
  const result = spawnSync("secret-tool", args, { input, encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

async function loadKey() {
  const existing = secretTool(["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT]);
  if (existing && /^[a-f0-9]{64}$/i.test(existing)) return Buffer.from(existing, "hex");
  const generated = randomBytes(32).toString("hex");
  const saved = secretTool(["store", "--label=PDV WhatsApp prototype session key", "service", KEY_SERVICE, "account", KEY_ACCOUNT], `${generated}\n`);
  if (saved === null) throw new Error("Não foi possível acessar o keyring do Linux (secret-tool). Instale/ative o Secret Service e tente novamente; a chave não será gravada em arquivo.");
  const verified = secretTool(["lookup", "service", KEY_SERVICE, "account", KEY_ACCOUNT]);
  if (verified !== generated) throw new Error("O keyring não confirmou o armazenamento da chave de sessão.");
  return Buffer.from(generated, "hex");
}

function encryptJson(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sessionKey, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") });
}

function decryptJson(value) {
  const box = JSON.parse(value);
  if (box.v !== 1) throw new Error("Formato de sessão desconhecido.");
  const decipher = createDecipheriv("aes-256-gcm", sessionKey, Buffer.from(box.iv, "base64"));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8"));
}

function encryptBytes(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", historyKey, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from("PDWH1"), iv, cipher.getAuthTag(), encrypted]);
}

function decryptBytes(value) {
  const box = Buffer.from(value);
  if (box.subarray(0, 5).toString() !== "PDWH1" || box.length < 33) throw new Error("Arquivo de histórico inválido.");
  const iv = box.subarray(5, 17);
  const tag = box.subarray(17, 33);
  const decipher = createDecipheriv("aes-256-gcm", historyKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(box.subarray(33)), decipher.final()]);
}

async function initializeHistory() {
  const wasmPath = fileURLToPath(new URL("../node_modules/sql.js/dist/sql-wasm.wasm", import.meta.url));
  SQL = await initSqlJs({ locateFile: () => wasmPath });
  let bytes;
  try {
    bytes = decryptBytes(await readFile(HISTORY_FILE));
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error(`Não foi possível abrir o histórico cifrado: ${error.message}`);
  }
  historyDb = bytes ? new SQL.Database(bytes) : new SQL.Database();
  historyDb.run("PRAGMA foreign_keys = ON");
  historyDb.run(`
    CREATE TABLE IF NOT EXISTS contacts (
      contact_id TEXT PRIMARY KEY,
      phone TEXT NOT NULL,
      display_name TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      flow_state TEXT NOT NULL DEFAULT '',
      active_order_id TEXT,
      baseline_order_id TEXT,
      flow_updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      message_id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      display_name TEXT NOT NULL,
      body TEXT NOT NULL,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_error_name TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_contact_created ON messages(contact_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_outbox_status_updated ON outbox(status, updated_at);
  `);
  const contactColumns = new Set(query("PRAGMA table_info(contacts)").map((row) => row.name));
  for (const [name, type] of [["active_order_id", "TEXT"], ["baseline_order_id", "TEXT"], ["flow_updated_at", "TEXT"]]) {
    if (!contactColumns.has(name)) historyDb.run(`ALTER TABLE contacts ADD COLUMN ${name} ${type}`);
  }
  const interruptedAt = new Date().toISOString();
  const interruptedOutbox = query("SELECT message_id, status FROM outbox WHERE status='sending'");
  for (const item of interruptedOutbox) {
    historyDb.run("UPDATE outbox SET status=?, updated_at=? WHERE message_id=?", [recoverOutboxStatus(item.status), interruptedAt, item.message_id]);
  }
  if (interruptedOutbox.length) logEvent("outbox.recovered_uncertain", { count: interruptedOutbox.length });
  await saveHistory();
}

async function saveHistory() {
  if (!historyDb) return;
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  await chmod(DATA_DIR, DIR_MODE);
  const temp = `${HISTORY_FILE}.tmp`;
  await writeFile(temp, encryptBytes(Buffer.from(historyDb.export())), { mode: FILE_MODE });
  await chmod(temp, FILE_MODE);
  await rename(temp, HISTORY_FILE);
}

function query(sql, params = []) {
  const statement = historyDb.prepare(sql);
  try {
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

async function addMessage({ contactId, phone, displayName, messageId, direction, body, flowState, activeOrderId, baselineOrderId }) {
  const now = new Date().toISOString();
  historyDb.run(`INSERT INTO contacts(contact_id, phone, display_name, first_seen_at, last_seen_at, flow_state, active_order_id, baseline_order_id, flow_updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET phone=excluded.phone,
      display_name=excluded.display_name, last_seen_at=excluded.last_seen_at,
      flow_state=CASE WHEN excluded.flow_state='' THEN contacts.flow_state ELSE excluded.flow_state END,
      active_order_id=CASE WHEN excluded.flow_state='' THEN contacts.active_order_id ELSE excluded.active_order_id END,
      baseline_order_id=CASE WHEN excluded.flow_state='' THEN contacts.baseline_order_id ELSE excluded.baseline_order_id END,
      flow_updated_at=CASE WHEN excluded.flow_state='' THEN contacts.flow_updated_at ELSE excluded.flow_updated_at END`,
  [contactId, phone, displayName || phone, now, now, flowState || "", activeOrderId ?? null, baselineOrderId ?? null, flowState ? now : null]);
  historyDb.run("INSERT OR IGNORE INTO messages(message_id, contact_id, direction, body, created_at) VALUES(?, ?, ?, ?, ?)", [messageId, contactId, direction, body, now]);
  await saveHistory();
}

function setFlow(contactId, flowState, activeOrderId = null, baselineOrderId = null) {
  const now = new Date().toISOString();
  historyDb.run("UPDATE contacts SET flow_state=?, active_order_id=?, baseline_order_id=?, flow_updated_at=?, last_seen_at=? WHERE contact_id=?", [flowState, activeOrderId, baselineOrderId, now, now, contactId]);
}

function getContact(contactId) {
  return query("SELECT * FROM contacts WHERE contact_id=?", [contactId])[0];
}

function getStatus() {
  return {
    state: connectionState,
    qrAvailable: Boolean(qrBuffer) && Date.now() - qrCapturedAt < 120_000,
    dryRun: DRY_RUN,
    uncertainDeliveries: query("SELECT COUNT(*) AS count FROM outbox WHERE status='uncertain'")[0]?.count || 0,
    apiConfigured: pdvApi.apiConfigured,
    menuUrlConfigured: pdvApi.orderUrlConfigured,
    lastError: lastError || lastScanWarning || (!pdvApi.apiConfigured ? "Configure PDV_API_BASE_URL para habilitar a consulta de pedidos." : !pdvApi.orderUrlConfigured ? "Configure PDV_PUBLIC_ORDER_URL para habilitar os links de cardápio e acompanhamento." : ""),
    lastInbound,
  };
}

async function getActiveOrder(phone) {
  const active = await pdvApi.getActiveOrder(phone);
  if (!active?.orderId) return null;
  const details = await pdvApi.getOrderStatus(active.orderId);
  return { ...active, ...details };
}

function stageSituation(stage) {
  return STAGE_SITUATION[stage] || "A equipe pode informar mais detalhes pelo atendimento.";
}

async function sendToPhone(phone, text, channel, onDispatchStart) {
  if (!context || !page || page.isClosed()) throw new Error("WhatsApp não está conectado para enviar a confirmação.");
  if (browserNavigationInProgress) throw new Error("A aba principal do WhatsApp está ocupada por outro envio.");
  const wasProcessing = processing;
  processing = true;
  browserNavigationInProgress = true;
  const activePage = page;
  let originalUrl = "https://web.whatsapp.com/";
  try {
    originalUrl = activePage.url() || originalUrl;
    const url = new URL("https://web.whatsapp.com/send");
    url.searchParams.set("phone", phone);
    logEvent("outbox.using_main_tab", { channel });
    await activePage.goto(url.toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
    const editor = activePage.locator('#main footer [contenteditable="true"]').last();
    await editor.waitFor({ state: "visible", timeout: 30_000 });
    await editor.fill(text);
    onDispatchStart();
    await editor.press("Enter");
    await activePage.waitForTimeout(800);
  } finally {
    const returnUrl = originalUrl.startsWith("https://web.whatsapp.com/") ? originalUrl : "https://web.whatsapp.com/";
    await activePage.goto(returnUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch((error) => {
      lastError = `O envio usou a aba principal, mas não foi possível voltar ao WhatsApp Web: ${error.message}`;
      logEvent("outbox.return_to_main_failed", { errorName: error?.name || "Error" });
    });
    browserNavigationInProgress = false;
    processing = wasProcessing;
  }
}

async function dispatchOutbound({ messageId, contactId, phone, displayName, body, channel }) {
  const item = { messageId, contactId, phone, displayName, body, channel };
  let existing = query("SELECT status, attempts FROM outbox WHERE message_id=?", [messageId])[0];
  const plan = planOutboxDispatch(existing, DRY_RUN);
  if (plan === "suppress") {
    logEvent("outbox.duplicate_suppressed", { channel, status: existing.status });
    return { status: existing.status };
  }
  if (plan === "attempt_limit") {
    logEvent("outbox.attempt_limit", { channel });
    return { status: "failed", exhausted: true };
  }

  const now = new Date().toISOString();
  if (plan === "dry_run") {
    if (existing) {
      historyDb.run("UPDATE outbox SET status='dry_run', updated_at=? WHERE message_id=? AND status='failed'", [now, messageId]);
    } else {
      historyDb.run("INSERT INTO outbox(message_id, contact_id, phone, display_name, body, channel, status, attempts, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 'dry_run', 0, ?, ?)", [messageId, contactId, phone, displayName || phone, body, channel, now, now]);
    }
    await saveHistory();
    logEvent("message.dry_run", { channel });
    return { status: "dry_run" };
  }

  if (existing) {
    historyDb.run("UPDATE outbox SET status='sending', attempts=attempts+1, last_error_name=NULL, updated_at=? WHERE message_id=? AND status='failed' AND attempts=?", [now, messageId, Number(existing.attempts || 0)]);
    if (historyDb.getRowsModified() !== 1) {
      existing = query("SELECT status FROM outbox WHERE message_id=?", [messageId])[0];
      return { status: existing?.status || "uncertain" };
    }
  } else {
    historyDb.run("INSERT INTO outbox(message_id, contact_id, phone, display_name, body, channel, status, attempts, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, 'sending', 1, ?, ?)", [messageId, contactId, phone, displayName || phone, body, channel, now, now]);
  }
  try {
    await saveHistory();
  } catch (error) {
    historyDb.run("UPDATE outbox SET status='failed', last_error_name=?, updated_at=? WHERE message_id=? AND status='sending'", [error?.name || "Error", new Date().toISOString(), messageId]);
    await saveHistory().catch(() => {});
    logEvent("outbox.persist_before_dispatch_failed", { channel, errorName: error?.name || "Error" });
    return { status: "failed", exhausted: Number(query("SELECT attempts FROM outbox WHERE message_id=?", [messageId])[0]?.attempts || 0) >= 3 };
  }

  let dispatchStarted = false;
  try {
    await sendToPhone(phone, body, channel, () => { dispatchStarted = true; });
  } catch (error) {
    const outcome = outboxOutcomeAfterError(dispatchStarted);
    historyDb.run("UPDATE outbox SET status=?, last_error_name=?, updated_at=? WHERE message_id=? AND status='sending'", [outcome, error?.name || "Error", new Date().toISOString(), messageId]);
    await saveHistory().catch(() => {});
    logEvent("outbox.dispatch_failed", { channel, outcome, errorName: error?.name || "Error" });
    if (outcome === "uncertain") return { status: "uncertain" };
    const attempts = Number(query("SELECT attempts FROM outbox WHERE message_id=?", [messageId])[0]?.attempts || 0);
    if (attempts < 3) return dispatchOutbound(item);
    return { status: "failed", exhausted: true };
  }

  const sentAt = new Date().toISOString();
  try {
    historyDb.run("BEGIN");
    historyDb.run("UPDATE outbox SET status='sent', updated_at=? WHERE message_id=? AND status='sending'", [sentAt, messageId]);
    historyDb.run("INSERT OR IGNORE INTO messages(message_id, contact_id, direction, body, created_at) VALUES(?, ?, 'out', ?, ?)", [messageId, contactId, body, sentAt]);
    historyDb.run("COMMIT");
    await saveHistory();
    logEvent("outbox.sent", { channel });
    return { status: "sent" };
  } catch (error) {
    try { historyDb.run("ROLLBACK"); } catch {}
    historyDb.run("UPDATE outbox SET status='uncertain', last_error_name=?, updated_at=? WHERE message_id=?", [error?.name || "Error", new Date().toISOString(), messageId]);
    await saveHistory().catch(() => {});
    logEvent("outbox.persist_after_dispatch_failed", { channel, errorName: error?.name || "Error" });
    return { status: "uncertain" };
  }
}

async function watchNewOrders() {
  if (watchingOrders || processing || browserNavigationInProgress || !context || connectionState !== "conectado" || !pdvApi.apiConfigured) return;
  watchingOrders = true;
  try {
    const pending = query(`SELECT contact_id AS contactId, phone, display_name AS displayName,
      baseline_order_id AS baselineOrderId FROM contacts WHERE flow_state='awaiting_menu_order'
      ORDER BY flow_updated_at LIMIT 100`);
    const batchSize = Math.min(4, pending.length);
    if (watchCursor >= pending.length) watchCursor = 0;
    const batch = Array.from({ length: batchSize }, (_, index) => pending[(watchCursor + index) % pending.length]);
    if (pending.length) watchCursor = (watchCursor + batchSize) % pending.length;
    for (const contact of batch) {
      try {
        const active = await pdvApi.getActiveOrder(contact.phone);
        if (!active?.orderId || active.orderId === contact.baselineOrderId) continue;
        const details = await pdvApi.getOrderStatus(active.orderId);
        const situation = stageSituation(details.customerStage?.stage);
        const trackingLink = pdvApi.makeOrderUrl(contact.phone, active.orderId);
        const message = MESSAGES.orderConfirmed(active.orderId, details.customerStage?.label || "Recebido", situation, trackingLink);
        const notificationId = `bot:order-confirmed:${active.orderId}`;
        if (query("SELECT message_id FROM messages WHERE message_id=?", [notificationId]).length) {
          setFlow(contact.contactId, "order_confirmed", active.orderId, active.orderId);
          await saveHistory();
          continue;
        }
        const delivery = await dispatchOutbound({ messageId: notificationId, contactId: contact.contactId, phone: contact.phone, displayName: contact.displayName, body: message, channel: "order_confirmation" });
        if (delivery.status === "sent") setFlow(contact.contactId, "order_confirmed", active.orderId, active.orderId);
        else if (delivery.status === "dry_run") setFlow(contact.contactId, "order_notification_simulated", active.orderId, active.orderId);
        else if (delivery.status === "uncertain") setFlow(contact.contactId, "order_notification_review", active.orderId, active.orderId);
        else if (delivery.exhausted) setFlow(contact.contactId, "order_notification_failed", active.orderId, active.orderId);
        if (["sent", "dry_run", "uncertain"].includes(delivery.status) || delivery.exhausted) await saveHistory();
      } catch (error) {
        lastError = `Falha ao conferir/avisar novo pedido: ${error.message}`;
        logEvent("order_watch.failed", { errorName: error?.name || "Error" });
      }
    }
  } finally {
    watchingOrders = false;
  }
}

async function saveEncryptedSession() {
  if (!context) return;
  try {
    const storage = await context.storageState({ indexedDB: true });
    await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
    await chmod(DATA_DIR, DIR_MODE);
    const temp = `${STATE_FILE}.tmp`;
    await writeFile(temp, encryptJson({ storage }), { mode: FILE_MODE });
    await chmod(temp, FILE_MODE);
    await rename(temp, STATE_FILE);
    lastSaveAt = Date.now();
    logEvent("session.saved", { cookies: storage.cookies?.length || 0, origins: storage.origins?.length || 0, indexedDbOrigins: storage.origins?.filter((origin) => origin.indexedDB?.length).length || 0 });
  } catch (error) {
    lastError = `Não foi possível cifrar/salvar a sessão: ${error.message}`;
    logEvent("session.save_failed", { errorName: error?.name || "Error" });
  }
}

async function readSavedState() {
  try {
    const state = decryptJson(await readFile(STATE_FILE, "utf8"));
    if (!state?.storage || !Array.isArray(state.storage.cookies) || !Array.isArray(state.storage.origins)) {
      throw new Error("O arquivo não contém um storageState válido do Playwright.");
    }
    logEvent("session.loaded", { cookies: state.storage.cookies.length, origins: state.storage.origins.length, indexedDbOrigins: state.storage.origins.filter((origin) => origin.indexedDB?.length).length });
    return state.storage;
  } catch (error) {
    if (error.code === "ENOENT") {
      logEvent("session.not_found", { configuredDataHome: Boolean(process.env.XDG_DATA_HOME) });
      return undefined;
    }
    lastError = `Sessão local inválida; conecte novamente. (${error.message})`;
    logEvent("session.load_failed", { errorName: error?.name || "Error" });
    return undefined;
  }
}

async function startBrowser() {
  if (context) return;
  if (browserStartPromise) return browserStartPromise;
  browserStartPromise = startBrowserOnce();
  try {
    await browserStartPromise;
  } finally {
    browserStartPromise = undefined;
  }
}

async function startBrowserOnce() {
  try {
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  await chmod(DATA_DIR, DIR_MODE);
  browser = await chromium.launch({ headless: false , args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const storageState = await readSavedState();
  context = await browser.newContext({ ...(storageState ? { storageState } : {}), viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    // Aviso interno emitido pelo WhatsApp Web/Chromium; não impede o QR nem a sessão.
    if (/Permissions policy violation: unload is not allowed in this document/i.test(text)) return;
    // O contexto isolado do Playwright pode negar storage.persist(); o próprio
    // WhatsApp classifica essa falha como não fatal e a sessão é salva pelo agente.
    if (/storage bucket persistence denied|persistent-storage-denied/i.test(text)) {
      logEvent("whatsapp.console_nonfatal", { reason: "storage_persistence_denied" });
      return;
    }
    // Alguns recursos de imagem externos do WhatsApp são bloqueados pela CSP
    // da própria página; isso não indica erro de autenticação ou do agente.
    if (/Loading the image 'https:\/\/static\.whatsapp\.net\/.*violates the following Content Security Policy directive: "img-src 'self' blob:"/i.test(text)) {
      logEvent("whatsapp.console_nonfatal", { reason: "static_image_blocked_by_csp" });
      return;
    }
    lastError = `WhatsApp Web: ${text.slice(0, 250)}`;
  });
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  connectionState = "aguardando_qr";
  await page.waitForTimeout(1_500);
  await refreshQr();
  inboundTimer = setInterval(() => pollIncoming().catch((error) => {
    lastError = error.message;
    logEvent("scanner.failed", { errorName: error?.name || "Error" });
  }), 2_500);
  orderWatchTimer = setInterval(() => watchNewOrders().catch((error) => {
    lastError = error.message;
    logEvent("order_watch.failed", { errorName: error?.name || "Error" });
  }), 15_000);
  } catch (error) {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    context = undefined;
    browser = undefined;
    page = undefined;
    connectionState = "erro";
    throw error;
  }
}

async function refreshQr() {
  if (!page || page.isClosed()) return;
  const chatList = page.locator("#pane-side");
  if (await chatList.count().catch(() => 0)) {
    const justConnected = connectionState !== "conectado";
    connectionState = "conectado";
    qrBuffer = undefined;
    if (justConnected) logEvent("whatsapp.connected");
    if (justConnected || Date.now() - lastSaveAt > 30_000) await saveEncryptedSession();
    return;
  }
  const qr = page.locator("canvas").first();
  if (await qr.count().catch(() => 0)) {
    const qrWasAvailable = Boolean(qrBuffer);
    qrBuffer = await qr.screenshot().catch(() => undefined);
    if (qrBuffer) {
      qrCapturedAt = Date.now();
      connectionState = "aguardando_qr";
      if (!qrWasAvailable) logEvent("whatsapp.qr_available");
    }
  }
}

async function sendReply({ contactId, phone, displayName, sourceMessageId, body, flowState, activeOrderId, baselineOrderId }) {
  const delivery = await dispatchOutbound({ messageId: `bot:${sourceMessageId}`, contactId, phone, displayName, body, channel: "customer_reply" });
  if (delivery.status === "sent") logEvent("reply.sent", { flowState });
  else if (delivery.status === "uncertain") lastError = "Uma resposta teve resultado incerto. Confira o WhatsApp antes de responder manualmente; o agente não repetirá esse envio.";
  else if (delivery.status === "failed") lastError = "Não foi possível enviar a resposta após tentativas seguras. Confira o WhatsApp e os logs.";
}

async function handleNewMessage(message, text, chatTitle, idData) {
  const { contactId, phone } = idData;
  const displayName = chatTitle && chatTitle !== phone ? chatTitle : phone;
  const rawId = await message.getAttribute("data-id");
  const sourceMessageId = rawId || `${contactId}:${Date.now()}`;
  if (query("SELECT message_id FROM messages WHERE message_id=?", [sourceMessageId]).length) return;

  const contact = getContact(contactId);
  if (!contact || !["awaiting_new_order_choice", "awaiting_choice", "awaiting_intent_clarification", "awaiting_menu_order"].includes(contact.flow_state)) {
    // Classificador local em memória: conversa fora do escopo de pedido não é salva nem respondida.
    const classification = classifyIntent(text);
    logEvent("message.classified", { intent: classification.intent, confidence: Number(classification.confidence.toFixed(3)), inScope: classification.inScope });
    if (classification.intent === "unrelated") {
      logEvent("message.ignored", { reason: "outside_order_scope" });
      return;
    }
    if (classification.intent === "unclear") {
      await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_intent_clarification" });
      await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.clarifyIntent, flowState: "awaiting_intent_clarification" });
      lastInbound = `${displayName}: ${text.slice(0, 140)}`;
      return;
    }
    const active = await getActiveOrder(phone);
    const activeOrderId = active?.orderId ?? null;
    const body = active
      ? MESSAGES.pendingChoice(active.orderId, active.customerStage?.label || "Em andamento", stageSituation(active.customerStage?.stage))
      : MESSAGES.noPending;
    await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_new_order_choice", activeOrderId, baselineOrderId: activeOrderId });
    await sendReply({ contactId, phone, displayName, sourceMessageId, body, flowState: "awaiting_new_order_choice", activeOrderId, baselineOrderId: activeOrderId });
    lastInbound = `${displayName}: ${text.slice(0, 140)}`;
    return;
  }

  if (["awaiting_new_order_choice", "awaiting_choice", "awaiting_intent_clarification"].includes(contact.flow_state)) {
    const classification = classifyIntent(text);
    logEvent("message.classified", { intent: classification.intent, confidence: Number(classification.confidence.toFixed(3)), inScope: classification.inScope, flow: contact.flow_state });
    if (classification.intent === "unrelated") {
      logEvent("message.ignored", { reason: "outside_order_scope" });
      return;
    }
    if (classification.intent === "unclear") {
      await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_intent_clarification" });
      await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.clarifyIntent, flowState: "awaiting_intent_clarification" });
      lastInbound = `${displayName}: ${text.slice(0, 140)}`;
      return;
    }
    if (classification.intent === "new_order") {
      const link = pdvApi.makeOrderUrl(phone);
      const body = `Abra o cardápio para montar seu pedido: ${link}`;
      const latestActiveOrder = await pdvApi.getActiveOrder(phone);
      const baselineOrderId = latestActiveOrder?.orderId ?? null;
      await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_menu_order", activeOrderId: baselineOrderId, baselineOrderId });
      await sendReply({ contactId, phone, displayName, sourceMessageId, body, flowState: "awaiting_menu_order", activeOrderId: baselineOrderId, baselineOrderId });
    } else {
      const currentOrderId = contact.active_order_id ?? null;
      const body = currentOrderId
        ? MESSAGES.trackingLink(currentOrderId, pdvApi.makeOrderUrl(phone, currentOrderId))
        : MESSAGES.noNewOrder;
      await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "tracking_link_sent", activeOrderId: currentOrderId, baselineOrderId: currentOrderId });
      await sendReply({ contactId, phone, displayName, sourceMessageId, body, flowState: "tracking_link_sent", activeOrderId: currentOrderId, baselineOrderId: currentOrderId });
    }
    lastInbound = `${displayName}: ${text.slice(0, 140)}`;
    return;
  }
}

async function inspectChatRow(row) {
  return row.evaluate((el) => {
    const metadataNodes = [el, ...el.querySelectorAll("[data-id], [data-jid], [data-chat-id], a[href], [title], [aria-label]")];
    const values = [];
    for (const node of metadataNodes) {
      for (const name of ["data-id", "data-jid", "data-chat-id", "href", "title", "aria-label"]) {
        const value = node.getAttribute?.(name);
        if (value) values.push(value);
      }
    }
    const unreadNodes = [...el.querySelectorAll('[data-testid="icon-unread-count"], [data-testid*="unread" i], [aria-label*="unread" i], [aria-label*="não lida" i], [aria-label*="não lidas" i]')];
    const unreadTexts = unreadNodes.map((node) => `${node.getAttribute("aria-label") || ""} ${node.textContent || ""}`);
    const labels = [el.getAttribute("aria-label") || "", ...unreadTexts];
    const unread = unreadNodes.length > 0 || /(?:mensagem|message)s?\s+(?:não\s+lida|unread)|(?:não\s+lida|unread)/i.test(labels.join(" "));
    const countMatch = unreadTexts.join(" ").match(/\b(\d{1,3})\+?\b/)
      || labels.join(" ").match(/(?:^|[,;]\s*)(\d{1,3})\s+(?:mensagem|message)/i);
    const titleNode = el.querySelector('[data-testid="cell-frame-title"] span[title], span[title]');
    const title = titleNode?.getAttribute("title") || "";
    const groupHint = Boolean(el.querySelector('[data-testid*="group" i], [aria-label*="group" i], [title*="group" i]'));
    const timeNodes = [...el.querySelectorAll('time[datetime], [data-testid*="last-msg-ts" i], [data-testid*="timestamp" i], [data-timestamp], [data-time], span[title]')];
    const activityValues = timeNodes.flatMap((node) => [node.getAttribute("datetime"), node.getAttribute("data-timestamp"), node.getAttribute("data-time"), node.getAttribute("title"), node.getAttribute("aria-label"), node.textContent]).filter(Boolean);
    const locale = navigator.languages?.[0] || navigator.language || document.documentElement.lang || "pt-BR";
    return { values, activityValues, locale, unread, unreadCount: unread ? Math.max(1, Number(countMatch?.[1] || 1)) : 0, title, groupHint };
  });
}

async function processTestChat(row, rowData, identity, rowIndex) {
  logEvent("scanner.test_chat_opening", { row: rowIndex + 1 });
  try {
    await row.click({ timeout: 4_000 });
    await page.waitForTimeout(350);
  } catch (error) {
    lastScanWarning = `Não consegui abrir o chat de teste: ${error.message}`;
    logEvent("scanner.test_chat_open_failed", { errorName: error?.name || "Error" });
    return true;
  }

  const incoming = page.locator("#main .message-in");
  const count = await incoming.count().catch(() => 0);
  if (!count) {
    logEvent("scanner.test_chat_no_incoming");
    return true;
  }
  const message = incoming.nth(count - 1);
  const rawId = await message.getAttribute("data-id").catch(() => null);
  const idData = extractDirectContactId(rawId);
  if (!idData || idData.contactId !== identity.contactId || !isConfiguredTestContact(idData, testPhone)) {
    lastScanWarning = "A última mensagem do chat de teste não confirmou o mesmo JID individual; conteúdo ignorado.";
    logEvent("scanner.test_chat_id_mismatch");
    return true;
  }

  const messageKey = rawId || `${idData.contactId}:${count}`;
  if (!isNewVerifiedTestMessage({ identity: idData, configuredPhone: testPhone, messageKey, lastProcessedMessageKey: lastTestMessageKey })) return true;
  if (query("SELECT message_id FROM messages WHERE message_id=?", [messageKey]).length) {
    lastTestMessageKey = messageKey;
    logEvent("scanner.test_chat_latest_already_processed");
    return true;
  }

  const text = (await message.locator(".selectable-text").allTextContents().catch(() => [])).join(" ").trim();
  if (!text) {
    lastTestMessageKey = messageKey;
    logEvent("scanner.test_chat_latest_has_no_text");
    return true;
  }
  const chatTitle = await page.locator("#main header [title]").first().getAttribute("title").catch(() => "");
  activeChat = chatTitle || rowData.title || testPhone;
  baselineMessageKey = "";
  logEvent("scanner.test_chat_latest_verified");
  processing = true;
  try {
    await handleNewMessage(message, text, activeChat, idData);
    lastTestMessageKey = messageKey;
    lastProcessedMessageKey = messageKey;
    lastInbound = `${activeChat}: ${text.slice(0, 140)}`;
  } finally {
    processing = false;
  }
  return true;
}

async function processUnreadDirectChat() {
  const rows = page.locator('#pane-side [role="listitem"], #pane-side [data-testid="cell-frame-container"]');
  const rowCount = Math.min(await rows.count().catch(() => 0), 100);
  let sawUnread = false;

  for (let index = 0; index < rowCount; index += 1) {
    const row = rows.nth(index);
    const rowData = await inspectChatRow(row).catch(() => null);
    if (!rowData) continue;
    const rowIdentity = extractChatIdentityFromMetadata(rowData.values);
    if (isConfiguredTestContact(rowIdentity, testPhone) && !rowData.groupHint) {
      if (Date.now() - lastTestChatScanAt >= 10_000) {
        lastTestChatScanAt = Date.now();
        return processTestChat(row, rowData, rowIdentity, index);
      }
      if (!rowData.unread) continue;
    }
    if (!rowData.unread) continue;
    sawUnread = true;
    const now = Date.now();
    const shouldLogRow = now - (lastUnreadRowLogAt.get(index) || 0) >= 30_000;
    if (shouldLogRow) {
      logEvent("scanner.unread_detected", { row: index + 1, unreadMessages: rowData.unreadCount });
      lastUnreadRowLogAt.set(index, now);
    }
    const activityTimestamp = parseChatActivityTimestamp(rowData.activityValues, Date.now(), rowData.locale);
    if (!isWithinLast24Hours(activityTimestamp)) {
      lastScanWarning = "Há conversa não lida sem atividade confirmada nas últimas 24 horas; chats antigos ou sem horário confiável são ignorados.";
      const timestampKnown = Number.isFinite(activityTimestamp);
      if (shouldLogRow) {
        logEvent(timestampKnown ? "scanner.skipped_outside_24h" : "scanner.activity_timestamp_unparsed", {
          row: index + 1,
          reason: !timestampKnown ? "no_recognized_timestamp" : activityTimestamp > Date.now() ? "timestamp_in_future" : "older_than_24h",
          ageMinutes: timestampKnown ? Math.round((Date.now() - activityTimestamp) / 60_000) : null,
          activityValueCount: rowData.activityValues.length,
          locale: rowData.locale?.split("-")[0] || "unknown",
        });
      }
      continue;
    }
    const identity = rowIdentity;
    if (!identity || identity.group || rowData.groupHint) {
      lastScanWarning = "Há conversa não lida cuja identidade individual não foi confirmada; não abri nem li o conteúdo por segurança.";
      if (shouldLogRow) logEvent("scanner.skipped_unverified_chat", { row: index + 1, reason: identity?.group || rowData.groupHint ? "group_or_group_marker" : "direct_jid_not_exposed" });
      continue;
    }

    try {
      logEvent("scanner.opening_direct_chat", { row: index + 1, unreadMessages: rowData.unreadCount });
      await row.click({ timeout: 4_000 });
      await page.waitForTimeout(350);
    } catch (error) {
      lastScanWarning = `Não consegui abrir uma conversa individual não lida: ${error.message}`;
      logEvent("scanner.open_failed", { row: index + 1, errorName: error?.name || "Error" });
      continue;
    }

    const incoming = page.locator("#main .message-in");
    const incomingCount = await incoming.count().catch(() => 0);
    if (!incomingCount) {
      lastScanWarning = "Abri o chat individual, mas não encontrei uma mensagem recebida verificável; não li conteúdo.";
      logEvent("scanner.no_incoming_message", { row: index + 1 });
      return true;
    }

    const firstUnread = Math.max(0, incomingCount - Math.min(rowData.unreadCount, incomingCount));
    let verifiedMessage = false;
    for (let messageIndex = firstUnread; messageIndex < incomingCount; messageIndex += 1) {
      const message = incoming.nth(messageIndex);
      const rawId = await message.getAttribute("data-id").catch(() => null);
      const idData = extractDirectContactId(rawId);
      // A identidade da linha e o JID da mensagem precisam coincidir antes de
      // acessar .selectable-text. Grupos e @lid falham fechados.
      if (!idData || idData.group || idData.contactId !== identity.contactId) {
        lastScanWarning = "O ID da mensagem não confirmou o contato individual; conteúdo ignorado.";
        continue;
      }
      verifiedMessage = true;
      logEvent("scanner.message_id_verified", { row: index + 1 });
      const messageKey = rawId || `${idData.contactId}:${messageIndex}`;
      if (query("SELECT message_id FROM messages WHERE message_id=?", [messageKey]).length) {
        lastProcessedMessageKey = messageKey;
        continue;
      }

      const text = (await message.locator(".selectable-text").allTextContents().catch(() => [])).join(" ").trim();
      if (!text) {
        lastProcessedMessageKey = messageKey;
        continue;
      }

      const chatTitle = await page.locator("#main header [title]").first().getAttribute("title").catch(() => "");
      activeChat = chatTitle || rowData.title || identity.phone;
      baselineMessageKey = "";
      processing = true;
      try {
        await handleNewMessage(message, text, activeChat, idData);
        lastProcessedMessageKey = messageKey;
        lastInbound = `${activeChat}: ${text.slice(0, 140)}`;
      } finally {
        processing = false;
      }
    }
    if (verifiedMessage) lastScanWarning = "";
    else lastScanWarning = "O chat não lido foi aberto, mas não encontrei JID @c.us correspondente; não li o conteúdo.";
    logEvent("scanner.chat_scan_finished", { row: index + 1, idVerified: verifiedMessage, unreadMessages: rowData.unreadCount });
    return true;
  }

  if (sawUnread && !lastScanWarning) {
    lastScanWarning = "Há mensagens não lidas, mas nenhuma conversa pôde ser confirmada como contato individual.";
  }
  if (!sawUnread && Date.now() - lastIdleScanLogAt >= 30_000) {
    logEvent("scanner.idle", { sidebarRowsChecked: rowCount });
    lastIdleScanLogAt = Date.now();
  }
  return false;
}

async function pollIncoming() {
  if (!page || page.isClosed() || processing || browserNavigationInProgress) return;
  await refreshQr();
  if (connectionState !== "conectado") return;
  if (await processUnreadDirectChat()) return;
  const messages = page.locator("#main .message-in");
  const count = await messages.count().catch(() => 0);
  if (!count) return;
  const message = messages.nth(count - 1);
  const rawId = await message.getAttribute("data-id").catch(() => null);
  const idData = extractDirectContactId(rawId);
  // Falha fechada: grupos, status, ids não identificados e números sem @c.us não são lidos nem salvos.
  if (!idData || idData.group) return;
  const chatTitle = await page.locator("#main header [title]").first().getAttribute("title").catch(() => "");
  const messageKey = rawId || `${idData.contactId}:${count}`;
  if ((chatTitle || "") !== activeChat) {
    activeChat = chatTitle || "";
    baselineMessageKey = messageKey;
    return;
  }
  if (messageKey === baselineMessageKey || messageKey === lastProcessedMessageKey) return;
  const text = (await message.locator(".selectable-text").allTextContents().catch(() => [])).join(" ").trim();
  if (!text) return;
  processing = true;
  try {
    await handleNewMessage(message, text, chatTitle || idData.phone, idData);
    lastProcessedMessageKey = messageKey;
  } finally {
    processing = false;
  }
}

async function stopBrowser() {
  if (inboundTimer) clearInterval(inboundTimer);
  if (orderWatchTimer) clearInterval(orderWatchTimer);
  inboundTimer = undefined;
  orderWatchTimer = undefined;
  await saveEncryptedSession();
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  context = undefined;
  browser = undefined;
  page = undefined;
  connectionState = "desconectado";
  qrBuffer = undefined;
}

function listConversations() {
  return query(`SELECT c.contact_id AS contactId, c.phone, c.display_name AS displayName,
    c.first_seen_at AS firstSeenAt, c.last_seen_at AS lastSeenAt, c.flow_state AS flowState,
    (SELECT body FROM messages m WHERE m.contact_id=c.contact_id ORDER BY created_at DESC LIMIT 1) AS lastMessage,
    (SELECT direction FROM messages m WHERE m.contact_id=c.contact_id ORDER BY created_at DESC LIMIT 1) AS lastDirection
    FROM contacts c ORDER BY c.last_seen_at DESC LIMIT 100`);
}

function listMessages(contactId) {
  return query("SELECT message_id AS id, direction, body, created_at AS createdAt FROM messages WHERE contact_id=? ORDER BY created_at ASC LIMIT 500", [contactId]);
}

const html = `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PDV · WhatsApp local (teste)</title><style>
*{box-sizing:border-box}body{font:15px system-ui;background:#f5f1e8;color:#332820;max-width:1080px;margin:28px auto;padding:0 16px}main{background:#fff;border:1px solid #ddd3c5;border-radius:16px;padding:22px}.warn{background:#fff7db;border:1px solid #ebd58a;padding:12px;border-radius:10px}.layout{display:grid;grid-template-columns:minmax(220px,34%) 1fr;gap:14px;margin-top:18px}.card{border:1px solid #e4ddd2;border-radius:12px;overflow:hidden}.card h2{font-size:16px;margin:0;padding:14px;border-bottom:1px solid #e4ddd2}.list{max-height:520px;overflow:auto}.contact{display:block;width:100%;text-align:left;border:0;border-bottom:1px solid #eee8df;background:white;padding:12px;cursor:pointer;color:inherit}.contact:hover,.contact:focus{background:#f6f3ee}.sub{font-size:12px;color:#777}.messages{height:440px;overflow:auto;padding:14px;background:#f8f6f2;display:flex;flex-direction:column;gap:8px}.msg{max-width:86%;padding:9px 12px;border-radius:12px;white-space:pre-wrap;overflow-wrap:anywhere}.in{align-self:flex-start;background:white;border:1px solid #e6e0d7}.out{align-self:flex-end;background:#d8f2df}.time{font-size:10px;color:#777;margin-top:4px}button.action{border:0;border-radius:9px;padding:10px 14px;background:#087c56;color:white;font-weight:700;cursor:pointer;margin:4px}button.secondary{background:#6c6258}#qr{display:none;max-width:230px;margin:12px auto;border:1px solid #ddd}.status{font-weight:700}.muted{color:#70685f;font-size:13px}.empty{padding:18px;color:#70685f}.toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hidden{display:none}@media(max-width:700px){.layout{grid-template-columns:1fr}.list{max-height:220px}}
</style><main><h1>WhatsApp do PDV · protótipo Linux</h1><p class="warn"><b>Experimental, não oficial.</b> Teste apenas. O filtro exclui grupos e só persiste mensagens que parecem relacionadas a pedidos; o texto de outras mensagens é avaliado em memória e descartado. A automação pode parar de funcionar ou levar a restrições da conta.</p><div class="toolbar"><span>Status: <span id="status" class="status">iniciando…</span></span><button id="connect" class="action">Conectar / atualizar QR</button><button id="disconnect" class="action secondary">Desconectar</button></div><p id="error" class="muted"></p><img id="qr" alt="QR Code do WhatsApp Web"><p id="hint" class="muted"></p><section class="layout"><div class="card"><h2>Contatos e conversas</h2><div id="contacts" class="list"><p class="empty">Nenhuma conversa de pedido registrada.</p></div></div><div class="card"><h2 id="conversation-title">Histórico da conversa</h2><div id="messages" class="messages"><p class="empty">Selecione um contato. Grupos e mensagens fora de contexto de pedido não são armazenados.</p></div></div></section><p class="muted">O agente procura chats individuais não lidos automaticamente, mas só processa conversas confirmadas como contatos diretos. Grupos e mensagens fora do contexto de pedido são ignorados.</p></main><script>
let selected='';
async function refreshStatus(){try{const s=await(await fetch('/api/status')).json();document.querySelector('#status').textContent=s.state;document.querySelector('#error').textContent=s.lastError||'';const qr=document.querySelector('#qr');if(s.qrAvailable){qr.src='/api/qr?t='+Date.now();qr.style.display='block';document.querySelector('#hint').textContent='Leia o QR com o WhatsApp no celular.'}else{qr.style.display='none';document.querySelector('#hint').textContent=s.state==='conectado'?'Conectado. Verificando chats individuais não lidos; conversas sem JID direto confiável são ignoradas.':''}}catch{document.querySelector('#status').textContent='serviço indisponível'}}
async function loadContacts(){const list=document.querySelector('#contacts');try{const rows=await(await fetch('/api/conversations')).json();list.replaceChildren();if(!rows.length){list.innerHTML='<p class="empty">Nenhuma conversa de pedido registrada.</p>';return}for(const c of rows){const b=document.createElement('button');b.className='contact';b.onclick=()=>loadConversation(c.contactId,c.displayName,c.phone);const name=document.createElement('b');name.textContent=c.displayName||c.phone;const detail=document.createElement('div');detail.className='sub';detail.textContent=(c.phone||'')+' · '+(c.lastMessage||'').slice(0,80);b.append(name,detail);list.append(b)}}catch{list.textContent='Não foi possível carregar o histórico.'}}
async function loadConversation(id,name,phone){selected=id;document.querySelector('#conversation-title').textContent=(name||phone)+' · '+phone;const box=document.querySelector('#messages');try{const rows=await(await fetch('/api/conversations/'+encodeURIComponent(id)+'/messages')).json();box.replaceChildren();for(const m of rows){const bubble=document.createElement('div');bubble.className='msg '+(m.direction==='in'?'in':'out');const body=document.createElement('div');body.textContent=m.body;const time=document.createElement('div');time.className='time';time.textContent=new Date(m.createdAt).toLocaleString('pt-BR');bubble.append(body,time);box.append(bubble)}box.scrollTop=box.scrollHeight}catch{box.textContent='Não foi possível carregar as mensagens.'}}
document.querySelector('#connect').onclick=async()=>{document.querySelector('#status').textContent='abrindo…';await fetch('/api/connect',{method:'POST'});refreshStatus()};document.querySelector('#disconnect').onclick=async()=>{await fetch('/api/disconnect',{method:'POST'});refreshStatus()};setInterval(()=>{refreshStatus();loadContacts();if(selected){const title=document.querySelector('#conversation-title').textContent;const parts=title.split(' · ');loadConversation(selected,parts[0],parts[1])}},3000);refreshStatus();loadContacts();
</script></html>`;
const dashboardHtml = html.replace(
  "document.querySelector('#status').textContent=s.state;",
  "document.querySelector('#status').textContent=s.state+(s.dryRun?' · SIMULAÇÃO — envio desativado':'')+(s.uncertainDeliveries?' · '+s.uncertainDeliveries+' envio(s) para revisão':'');",
);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin)) return res.writeHead(403).end("Origin não permitido");
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(dashboardHtml);
  if (req.method === "GET" && req.url === "/api/status") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(getStatus()));
  if (req.method === "GET" && req.url === "/api/conversations") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(listConversations()));
  if (req.method === "GET" && req.url?.startsWith("/api/conversations/") && req.url.endsWith("/messages")) {
    try {
      const contactId = decodeURIComponent(req.url.slice("/api/conversations/".length, -"/messages".length));
      return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(listMessages(contactId)));
    } catch { return res.writeHead(400).end("Contato inválido"); }
  }
  if (req.method === "GET" && req.url?.startsWith("/api/qr")) {
    if (!qrBuffer) return res.writeHead(404).end("QR indisponível");
    return res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" }).end(qrBuffer);
  }
  if (req.method === "POST" && req.url === "/api/connect") {
    try {
      await startBrowser();
      return res.writeHead(202, { "Content-Type": "application/json" }).end(JSON.stringify(getStatus()));
    } catch (error) {
      connectionState = "erro";
      lastError = error.message;
      return res.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify(getStatus()));
    }
  }
  if (req.method === "POST" && req.url === "/api/disconnect") {
    await stopBrowser();
    return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(getStatus()));
  }
  res.writeHead(404).end("Not found");
});

async function main() {
  await acquireProcessLock();
  if (!pdvApi.apiConfigured) console.warn("PDV_API_BASE_URL não configurado; a consulta de pedidos ficará indisponível.");
  if (!pdvApi.orderUrlConfigured) console.warn("PDV_PUBLIC_ORDER_URL não configurado; os links de cardápio e acompanhamento ficarão indisponíveis.");
  if (DRY_RUN) logEvent("agent.dry_run_enabled", { outboundDisabled: true });
  sessionKey = await loadKey();
  historyKey = createHmac("sha256", sessionKey).update("pdv-whatsapp-history-v1").digest();
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  await chmod(DATA_DIR, DIR_MODE);
  await initializeHistory();
  server.listen(PORT, HOST, () => logEvent("agent.ready", { host: HOST, port: PORT, dryRun: DRY_RUN, pid: process.pid }));
}

let shutdownPromise;
async function shutdown(signal) {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    logEvent("agent.shutdown_started", { signal });
    await stopBrowser().catch((error) => logEvent("agent.shutdown_browser_failed", { errorName: error?.name || "Error" }));
    await saveHistory().catch((error) => logEvent("agent.shutdown_history_failed", { errorName: error?.name || "Error" }));
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    try {
      if (releaseProcessLock) {
        const release = releaseProcessLock;
        releaseProcessLock = undefined;
        await release();
      }
    } catch (error) {
      logEvent("agent.lock_release_failed", { errorName: error?.name || "Error" });
    }
    logEvent("agent.shutdown_complete", { signal });
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown(signal).then(() => process.exit(0)).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
  });
}

server.on("error", async (error) => {
  console.error(error.message);
  try { await releaseProcessLock?.(); } catch {}
  process.exit(1);
});

main().catch(async (error) => {
  console.error(error.message);
  try { await releaseProcessLock?.(); } catch {}
  process.exit(1);
});
