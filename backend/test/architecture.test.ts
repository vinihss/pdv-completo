/**
 * Teste de arquitetura — RATCHET das regras de camadas (FASE 0).
 *
 * Varre a árvore `src/` (arquivos `.ts`, recursivo) com fs + regex de
 * imports (sem dependency-canal) e aplica 3 regras:
 *
 *   a) `src/domain/**`       não importa application/infra/http/config/
 *      integrations, nem os pacotes drizzle-orm/fastify/pg;
 *   b) `src/application/**`  não importa infra/integrations/http/config, nem
 *      drizzle-orm (o `../infra/db/schema.js` está coberto pela regra de dir);
 *   c) `src/http/**`         não importa drizzle-orm, `infra/db/schema` nem
 *      `infra/db/client` — exceto os arquivos do EXEMPT abaixo (composition
 *      root provisória nesta fase).
 *
 * O código atual viola em massa (a migração é onda por onda), então isto é um
 * RATCHET: `KNOWN_VIOLATIONS` congela o estado ATUAL — gerado do diff real —
 * e o teste falha quando:
 *   - aparece violação NOVA (fora da lista);
 *   - uma entrada da lista ficou OBSOLETA (arquivo corrigido ou apagado) —
 *     força a lista a DIMINUIR a cada onda;
 *   - um arquivo do EXEMPT deixa de existir.
 *
 * Formato da entrada: "<arquivo> :: <regra> :: <termo-banido>".
 * Mantenha a lista ORDENADA (o teste confere) e comente cada bloco.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");

// ---------------------------------------------------------------------
// Arquivos isentos — EXEMPT EXPLÍCITO (não é "não achamos a violação").
// `server.ts` é a composition root provisória: monta rotas/middlewares e,
// nesta fase, ainda toca no banco diretamente. Quando a montagem migrar
// para um composition module fora de `src/http`, REMOVA daqui (o teste vai
// cobrar a remoção: entrada obsoleta falha).
// ---------------------------------------------------------------------
const EXEMPT: Record<string, readonly string[]> = {
  http: ["src/http/server.ts"],
};

// ---------------------------------------------------------------------
// RATCHET — estado atual do repositório. DIMINUA a cada onda; nunca aumente
// sem justificativa no diff. Gerado em 2026-10-12 (FASE 0).
// ---------------------------------------------------------------------
const KNOWN_VIOLATIONS: readonly string[] = [
  // ------------------------------------------------------------------
  // application: use cases ainda acoplados a infra/integrations/config e
  // ao Drizzle (39 entradas — 45 antes da Onda 3 do contexto self-service). Migram use case a use case; ao migrar um,
  // apague as linhas dele — a lista só DIMINUI.
  // ------------------------------------------------------------------
  "src/application/auth/login.usecase.ts :: application :: dir:config",
  "src/application/auth/login.usecase.ts :: application :: dir:infra",
  "src/application/customer.usecases.ts :: application :: dir:infra",
  "src/application/customer.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/payment/payment.usecases.ts :: application :: dir:infra",
  "src/application/payment/payment.usecases.ts :: application :: dir:integrations",
  "src/application/provisioning/device-state.ts :: application :: dir:infra",
  "src/application/provisioning/device-state.ts :: application :: pkg:drizzle-orm",
  "src/application/provisioning/provisioning-email.usecase.ts :: application :: dir:infra",
  "src/application/provisioning/provisioning-email.usecase.ts :: application :: pkg:drizzle-orm",
  "src/application/provisioning/provisioning.usecases.ts :: application :: dir:config",
  "src/application/provisioning/provisioning.usecases.ts :: application :: dir:infra",
  "src/application/provisioning/provisioning.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/purchase/purchase.usecases.ts :: application :: dir:infra",
  "src/application/purchase/purchase.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/refund/refund.usecases.ts :: application :: dir:infra",
  "src/application/refund/refund.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/report-deliveries.usecases.ts :: application :: dir:infra",
  "src/application/report-deliveries.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/report-overview.usecases.ts :: application :: dir:infra",
  "src/application/report-overview.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/report.usecases.ts :: application :: dir:infra",
  "src/application/report.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/self-service/delivery.usecases.ts :: application :: dir:infra",
  "src/application/self-service/delivery.usecases.ts :: application :: dir:integrations",
  "src/application/self-service/delivery.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/self-service/manager-delivery-status.usecase.ts :: application :: dir:infra",
  "src/application/self-service/manager-delivery-status.usecase.ts :: application :: dir:integrations",
  "src/application/self-service/menu.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/self-service/order-intake.usecase.ts :: application :: dir:infra",
  "src/application/self-service/order-intake.usecase.ts :: application :: pkg:drizzle-orm",
  "src/application/settlement/settlement.usecases.ts :: application :: dir:infra",
  "src/application/settlement/settlement.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/store-settings.usecases.ts :: application :: dir:infra",
  "src/application/store-settings.usecases.ts :: application :: dir:integrations",
  "src/application/store-settings.usecases.ts :: application :: pkg:drizzle-orm",
  "src/application/tenant/resolve-tenant.usecase.ts :: application :: dir:infra",
  "src/application/user.usecases.ts :: application :: dir:infra",
  "src/application/user.usecases.ts :: application :: pkg:drizzle-orm",
  // ------------------------------------------------------------------
  // http: rotas/middleware que ainda tocam em Drizzle/schema/client (9).
  // Quando o acesso a dado sair das rotas, apague estas linhas.
  // `server.ts` NÃO aparece: é o EXEMPT documentado acima.
  // ------------------------------------------------------------------
  "src/http/middlewares/idempotency.middleware.ts :: http :: file:src/infra/db/client",
  "src/http/middlewares/idempotency.middleware.ts :: http :: file:src/infra/db/schema",
  "src/http/middlewares/idempotency.middleware.ts :: http :: pkg:drizzle-orm",
  "src/http/routes/auth.routes.ts :: http :: file:src/infra/db/client",
  "src/http/routes/auth.routes.ts :: http :: file:src/infra/db/schema",
  "src/http/routes/auth.routes.ts :: http :: pkg:drizzle-orm",
  "src/http/routes/ifood.routes.ts :: http :: file:src/infra/db/client",
  "src/http/routes/ifood.routes.ts :: http :: file:src/infra/db/schema",
  "src/http/routes/ifood.routes.ts :: http :: pkg:drizzle-orm",
];

// ---------------------------------------------------------------------
// Coleta
// ---------------------------------------------------------------------

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function toRel(absFile: string): string {
  return path.relative(ROOT, absFile).split(path.sep).join("/");
}

/** Tira comentários para não casar menções de caminho em documentação. */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");
}

function specifiersOf(code: string): string[] {
  const out: string[] = [];
  const re = /\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Resolve import relativo ao path sem extensão (`.js` → `.ts` do NodeNext). `null` = pacote. */
function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
  const abs = path.resolve(path.dirname(fromFile), spec);
  return toRel(abs).replace(/\.js$/, "");
}

/** Primeiro segmento depois de `src/` no caminho resolvido (banned dirs são top-level). */
function topSegmentUnderSrc(relPath: string): string | null {
  const idx = relPath.lastIndexOf("src/");
  if (idx === -1) return null;
  const rest = relPath.slice(idx + "src/".length);
  const seg = rest.split("/")[0];
  return seg && seg.endsWith(".ts") ? null : seg ?? null;
}

function packageNameOf(spec: string): string {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

interface Rule {
  id: string;
  appliesTo: (relFile: string) => boolean;
  bannedDirs: readonly string[];
  bannedPkgs: readonly string[];
  /** Caminhos sem extensão, relativos ao ROOT (compara com o import resolvido). */
  bannedFiles: readonly string[];
}

const RULES: readonly Rule[] = [
  {
    id: "domain",
    appliesTo: (f) => f.startsWith("src/domain/"),
    bannedDirs: ["application", "infra", "http", "config", "integrations"],
    bannedPkgs: ["drizzle-orm", "fastify", "pg"],
    bannedFiles: [],
  },
  {
    id: "application",
    appliesTo: (f) => f.startsWith("src/application/"),
    // O spec cita `../infra/db/schema.js` explicitamente — coberto por dir:infra.
    bannedDirs: ["infra", "integrations", "http", "config"],
    bannedPkgs: ["drizzle-orm"],
    bannedFiles: [],
  },
  {
    id: "http",
    appliesTo: (f) => f.startsWith("src/http/"),
    bannedDirs: [],
    bannedPkgs: ["drizzle-orm"],
    bannedFiles: ["src/infra/db/schema", "src/infra/db/client"],
  },
];

function isExempt(ruleId: string, relFile: string): boolean {
  return (EXEMPT[ruleId] ?? []).includes(relFile);
}

function collectViolations(): string[] {
  const found = new Set<string>();
  for (const abs of listTsFiles(SRC)) {
    const relFile = toRel(abs);
    const code = stripComments(readFileSync(abs, "utf8"));
    const specs = specifiersOf(code);
    for (const rule of RULES) {
      if (!rule.appliesTo(relFile) || isExempt(rule.id, relFile)) continue;
      for (const spec of specs) {
        const resolved = resolveRelative(abs, spec);
        if (resolved === null) {
          const pkg = packageNameOf(spec);
          if (rule.bannedPkgs.includes(pkg)) found.add(`${relFile} :: ${rule.id} :: pkg:${pkg}`);
          continue;
        }
        const top = topSegmentUnderSrc(resolved);
        if (top !== null && rule.bannedDirs.includes(top)) {
          found.add(`${relFile} :: ${rule.id} :: dir:${top}`);
        }
        if (rule.bannedFiles.includes(resolved)) {
          found.add(`${relFile} :: ${rule.id} :: file:${resolved}`);
        }
      }
    }
  }
  return [...found].sort();
}

describe("arquitetura (ratchet de camadas)", () => {
  it("KNOWN_VIOLATIONS está ordenado e sem duplicatas", () => {
    const sorted = [...KNOWN_VIOLATIONS].sort();
    expect([...KNOWN_VIOLATIONS], "lista fora de ordem").toEqual(sorted);
    expect(new Set(KNOWN_VIOLATIONS).size, "entradas duplicadas").toBe(KNOWN_VIOLATIONS.length);
  });

  it("nenhuma violação NOVA além de KNOWN_VIOLATIONS", () => {
    const known = new Set(KNOWN_VIOLATIONS);
    const current = collectViolations();
    const newOnes = current.filter((v) => !known.has(v));
    expect(
      newOnes,
      `Violações novas (corrija o import ou migre a camada; a lista só diminui):\n${newOnes.join("\n")}`,
    ).toEqual([]);
  });

  it("nenhuma entrada OBSOLETA em KNOWN_VIOLATIONS (força a lista a diminuir)", () => {
    const current = new Set(collectViolations());
    const stale = KNOWN_VIOLATIONS.filter((v) => !current.has(v));
    expect(
      stale,
      `Entradas que não são mais violação — remova da lista:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("todos os arquivos do EXEMPT existem (senão, remova da lista)", () => {
    for (const rule of RULES) {
      for (const rel of EXEMPT[rule.id] ?? []) {
        expect(existsSync(path.join(ROOT, rel)), `${rel} não existe mais — tire do EXEMPT`).toBe(true);
      }
    }
  });
});
