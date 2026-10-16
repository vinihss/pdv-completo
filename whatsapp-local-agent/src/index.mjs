import http from "node:http";
import { spawnSync } from "node:child_process";
import { randomBytes, createCipheriv, createDecipheriv, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile, chmod, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import initSqlJs from "sql.js";
import { chromium } from "playwright";
import { classifyChoice, extractDirectContactId, isOrderIntent } from "./filters.mjs";

const HOST = "127.0.0.1";
const PORT = Number(process.env.PDV_WA_PORT || 8765);
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "pdv-whatsapp-test");
const STATE_FILE = path.join(DATA_DIR, "session.enc");
const HISTORY_FILE = path.join(DATA_DIR, "history.sqlite.enc");
const KEY_SERVICE = "pdv-whatsapp-local-prototype";
const KEY_ACCOUNT = "session-encryption-key";
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const MESSAGES = {
  welcome: "Olá! Posso ajudar com seu pedido. Responda:\n1 - Fazer um pedido\n2 - Acompanhar um pedido",
  newOrder: "Certo. Envie os itens e quantidades desejados em uma mensagem. Este protótipo apenas registra a conversa; ele não finaliza pedidos no PDV.",
  tracking: "Envie o número do pedido para consulta. Este protótipo ainda não consulta pedidos no PDV.",
  trackingReceived: "Recebi o número. A consulta automática ainda não está disponível; a equipe precisa conferir o histórico antes de responder.",
  detailsReceived: "Recebi os detalhes do pedido. Este protótipo não finaliza nem envia o pedido ao PDV; a equipe precisa revisar a conversa.",
};
let browser;
let context;
let page;
let connectionState = "desconectado";
let lastError = "";
let lastInbound = "";
let processing = false;
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
let lastSaveAt = 0;

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
      flow_state TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS messages (
      message_id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_contact_created ON messages(contact_id, created_at);
  `);
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

async function addMessage({ contactId, phone, displayName, messageId, direction, body, flowState }) {
  const now = new Date().toISOString();
  historyDb.run(`INSERT INTO contacts(contact_id, phone, display_name, first_seen_at, last_seen_at, flow_state)
    VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id) DO UPDATE SET phone=excluded.phone,
      display_name=excluded.display_name, last_seen_at=excluded.last_seen_at,
      flow_state=CASE WHEN excluded.flow_state='' THEN contacts.flow_state ELSE excluded.flow_state END`,
  [contactId, phone, displayName || phone, now, now, flowState || ""]);
  historyDb.run("INSERT OR IGNORE INTO messages(message_id, contact_id, direction, body, created_at) VALUES(?, ?, ?, ?, ?)", [messageId, contactId, direction, body, now]);
  await saveHistory();
}

function setFlow(contactId, flowState) {
  historyDb.run("UPDATE contacts SET flow_state=?, last_seen_at=? WHERE contact_id=?", [flowState, new Date().toISOString(), contactId]);
}

function getContact(contactId) {
  return query("SELECT * FROM contacts WHERE contact_id=?", [contactId])[0];
}

function getStatus() {
  return { state: connectionState, qrAvailable: Boolean(qrBuffer) && Date.now() - qrCapturedAt < 120_000, lastError, lastInbound };
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
  } catch (error) {
    lastError = `Não foi possível cifrar/salvar a sessão: ${error.message}`;
  }
}

async function readSavedState() {
  try {
    const state = decryptJson(await readFile(STATE_FILE, "utf8"));
    return state.storage;
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    lastError = `Sessão local inválida; conecte novamente. (${error.message})`;
    return undefined;
  }
}

async function startBrowser() {
  if (context) return;
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  await chmod(DATA_DIR, DIR_MODE);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const storageState = await readSavedState();
  context = await browser.newContext({ ...(storageState ? { storageState } : {}), viewport: { width: 1280, height: 900 } });
  page = await context.newPage();
  page.on("console", (msg) => { if (msg.type() === "error") lastError = `WhatsApp Web: ${msg.text().slice(0, 250)}`; });
  await page.goto("https://web.whatsapp.com/", { waitUntil: "domcontentloaded", timeout: 60_000 });
  connectionState = "aguardando_qr";
  await page.waitForTimeout(1_500);
  await refreshQr();
  inboundTimer = setInterval(() => pollIncoming().catch((error) => { lastError = error.message; }), 2_500);
}

async function refreshQr() {
  if (!page || page.isClosed()) return;
  const chatList = page.locator("#pane-side");
  if (await chatList.count().catch(() => 0)) {
    const justConnected = connectionState !== "conectado";
    connectionState = "conectado";
    qrBuffer = undefined;
    if (justConnected || Date.now() - lastSaveAt > 30_000) await saveEncryptedSession();
    return;
  }
  const qr = page.locator("canvas").first();
  if (await qr.count().catch(() => 0)) {
    qrBuffer = await qr.screenshot().catch(() => undefined);
    if (qrBuffer) {
      qrCapturedAt = Date.now();
      connectionState = "aguardando_qr";
    }
  }
}

async function sendReply({ contactId, phone, displayName, sourceMessageId, body, flowState }) {
  const editor = page.locator('#main footer [contenteditable="true"]').last();
  await editor.fill(body);
  await editor.press("Enter");
  await addMessage({ contactId, phone, displayName, messageId: `bot:${sourceMessageId}`, direction: "out", body, flowState });
}

async function handleNewMessage(message, text, chatTitle, idData) {
  const { contactId, phone } = idData;
  const displayName = chatTitle && chatTitle !== phone ? chatTitle : phone;
  const rawId = await message.getAttribute("data-id");
  const sourceMessageId = rawId || `${contactId}:${Date.now()}`;
  if (query("SELECT message_id FROM messages WHERE message_id=?", [sourceMessageId]).length) return;

  const contact = getContact(contactId);
  if (!contact || !["awaiting_choice", "awaiting_order_details", "awaiting_tracking_number"].includes(contact.flow_state)) {
    // A avaliação é apenas em memória: texto fora de contexto de pedido não é guardado nem respondido.
    if (!isOrderIntent(text)) return;
    await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_choice" });
    await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.welcome, flowState: "awaiting_choice" });
    lastInbound = `${displayName}: ${text.slice(0, 140)}`;
    return;
  }

  if (contact.flow_state === "awaiting_choice") {
    const choice = classifyChoice(text);
    if (!choice) return;
    if (choice === "new_order") {
      await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_order_details" });
      await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.newOrder, flowState: "awaiting_order_details" });
    } else {
      await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "awaiting_tracking_number" });
      await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.tracking, flowState: "awaiting_tracking_number" });
    }
    lastInbound = `${displayName}: ${text.slice(0, 140)}`;
    return;
  }

  if (contact.flow_state === "awaiting_order_details") {
    await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "order_recorded" });
    await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.detailsReceived, flowState: "order_recorded" });
    lastInbound = `${displayName}: ${text.slice(0, 140)}`;
    return;
  }

  if (contact.flow_state === "awaiting_tracking_number" && /\b\d{3,}\b/.test(text)) {
    await addMessage({ contactId, phone, displayName, messageId: sourceMessageId, direction: "in", body: text, flowState: "tracking_received" });
    await sendReply({ contactId, phone, displayName, sourceMessageId, body: MESSAGES.trackingReceived, flowState: "tracking_received" });
    lastInbound = `${displayName}: ${text.slice(0, 140)}`;
  }
}

async function pollIncoming() {
  if (!page || page.isClosed() || processing) return;
  await refreshQr();
  if (connectionState !== "conectado") return;
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
  inboundTimer = undefined;
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
</style><main><h1>WhatsApp do PDV · protótipo Linux</h1><p class="warn"><b>Experimental, não oficial.</b> Teste apenas. O filtro exclui grupos e só persiste mensagens que parecem relacionadas a pedidos; o texto de outras mensagens é avaliado em memória e descartado. A automação pode parar de funcionar ou levar a restrições da conta.</p><div class="toolbar"><span>Status: <span id="status" class="status">iniciando…</span></span><button id="connect" class="action">Conectar / atualizar QR</button><button id="disconnect" class="action secondary">Desconectar</button></div><p id="error" class="muted"></p><img id="qr" alt="QR Code do WhatsApp Web"><p id="hint" class="muted"></p><section class="layout"><div class="card"><h2>Contatos e conversas</h2><div id="contacts" class="list"><p class="empty">Nenhuma conversa de pedido registrada.</p></div></div><div class="card"><h2 id="conversation-title">Histórico da conversa</h2><div id="messages" class="messages"><p class="empty">Selecione um contato. Grupos e mensagens fora de contexto de pedido não são armazenados.</p></div></div></section><p class="muted">Para detectar mensagens, o chat individual precisa estar aberto no WhatsApp Web. Este protótipo não consulta nem finaliza pedidos no PDV; a equipe deve revisar o histórico antes de confirmar algo ao cliente.</p></main><script>
let selected='';
async function refreshStatus(){try{const s=await(await fetch('/api/status')).json();document.querySelector('#status').textContent=s.state;document.querySelector('#error').textContent=s.lastError||'';const qr=document.querySelector('#qr');if(s.qrAvailable){qr.src='/api/qr?t='+Date.now();qr.style.display='block';document.querySelector('#hint').textContent='Leia o QR com o WhatsApp no celular.'}else{qr.style.display='none';document.querySelector('#hint').textContent=s.state==='conectado'?'Conectado. Deixe aberto o chat individual que deseja testar.':''}}catch{document.querySelector('#status').textContent='serviço indisponível'}}
async function loadContacts(){const list=document.querySelector('#contacts');try{const rows=await(await fetch('/api/conversations')).json();list.replaceChildren();if(!rows.length){list.innerHTML='<p class="empty">Nenhuma conversa de pedido registrada.</p>';return}for(const c of rows){const b=document.createElement('button');b.className='contact';b.onclick=()=>loadConversation(c.contactId,c.displayName,c.phone);const name=document.createElement('b');name.textContent=c.displayName||c.phone;const detail=document.createElement('div');detail.className='sub';detail.textContent=(c.phone||'')+' · '+(c.lastMessage||'').slice(0,80);b.append(name,detail);list.append(b)}}catch{list.textContent='Não foi possível carregar o histórico.'}}
async function loadConversation(id,name,phone){selected=id;document.querySelector('#conversation-title').textContent=(name||phone)+' · '+phone;const box=document.querySelector('#messages');try{const rows=await(await fetch('/api/conversations/'+encodeURIComponent(id)+'/messages')).json();box.replaceChildren();for(const m of rows){const bubble=document.createElement('div');bubble.className='msg '+(m.direction==='in'?'in':'out');const body=document.createElement('div');body.textContent=m.body;const time=document.createElement('div');time.className='time';time.textContent=new Date(m.createdAt).toLocaleString('pt-BR');bubble.append(body,time);box.append(bubble)}box.scrollTop=box.scrollHeight}catch{box.textContent='Não foi possível carregar as mensagens.'}}
document.querySelector('#connect').onclick=async()=>{document.querySelector('#status').textContent='abrindo…';await fetch('/api/connect',{method:'POST'});refreshStatus()};document.querySelector('#disconnect').onclick=async()=>{await fetch('/api/disconnect',{method:'POST'});refreshStatus()};setInterval(()=>{refreshStatus();loadContacts();if(selected){const title=document.querySelector('#conversation-title').textContent;const parts=title.split(' · ');loadConversation(selected,parts[0],parts[1])}},3000);refreshStatus();loadContacts();
</script></html>`;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ![`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`].includes(origin)) return res.writeHead(403).end("Origin não permitido");
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/") return res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(html);
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
  sessionKey = await loadKey();
  historyKey = createHmac("sha256", sessionKey).update("pdv-whatsapp-history-v1").digest();
  await mkdir(DATA_DIR, { recursive: true, mode: DIR_MODE });
  await chmod(DATA_DIR, DIR_MODE);
  await initializeHistory();
  server.listen(PORT, HOST, () => console.log(`Protótipo local pronto: http://${HOST}:${PORT}`));
}

process.on("SIGINT", async () => { await stopBrowser(); await saveHistory(); server.close(() => process.exit(0)); });
process.on("SIGTERM", async () => { await stopBrowser(); await saveHistory(); server.close(() => process.exit(0)); });
main().catch((error) => { console.error(error.message); process.exit(1); });
