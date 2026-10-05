// Eleição de dono único por worker, via advisory lock de TRANSAÇÃO do Postgres.
//
// Por que isso existe: `server.ts` sobe três ciclos (`setInterval`) por
// processo, e o deploy é blue/green (nunca 2 instâncias ativas ao mesmo tempo).
// A coordenação entre instâncias era pendência registrada em
// docs/agent-deploy.md §"Pendência conhecida" — se um dia dois processos
// apontarem pro mesmo banco, o cenário de "um dono só" deixa de ser uma
// suposição e precisa ser garantido no banco, não na convenção de deploy.
//
// Um lock por worker, acquired no TOPO do ciclo. Quem não consegue o lock
// pula o ciclo inteiro em silêncio: réplica não-eleita não é erro, e a
// tentativa é de graça (try_), então ela só gasta uma query a cada 200ms.
//
// ## `pg_try_advisory_xact_lock`, NUNCA `pg_try_advisory_lock`
//
// O lock de SESSÃO ficaria preso na conexão ociosa do `pg.Pool` que o
// adquiriu (o client.ts não faz pin de conexão: cada `db.query` pega uma
// conexão, executa e devolve). As queries seguintes cairiam em outras
// conexões, não enxergariam o lock, e com `DATABASE_POOL_MAX=10` o pool
// esgotaria. O lock de TRANSAÇÃO é liberado no COMMIT/ROLLBACK — que é
// exatamente o ciclo de vida que o pool dá a cada query — então ele precisa
// ser adquirido DENTRO de `db.transaction(...)`.
//
// ## `hashtext(literal)`
//
// `hashtext` devolve `int4` e o overload bigint de
// `pg_try_advisory_xact_lock` resolve por cast implícito. Os literais vivem
// AQUI, num módulo só, de propósito: `hashtext('pdv:outbox:owner')` e
// `hashtext('pdv:outbox:owner ')` (espaço a mais) dariam locks DIFERENTES —
// divergência silenciosa, sem erro em lugar nenhum. Copy-paste do literal
// para dentro do worker eliminaria a chance de o lock deixar de valer.
import { sql } from "drizzle-orm";
import { db, type Tx } from "./db/client.js";

/** Um lock por worker. Nome = o que o dono exclusivo faz. */
export const LOCKS = {
  /** Dispatcher do outbox: quem faz broadcast dos eventos de realtime. */
  outboxDispatcher: "pdv:outbox:owner",
  /** Job de limpeza (2.5): purga outbox publicado, idempotency_key, carrinho, alertas. */
  maintenance: "pdv:maintenance:owner",
  /** Polling da iFood Order API: quem busca eventos e ACK. */
  ifoodWorker: "pdv:ifood:worker",
  /** Processa a inbox de webhook do Pagar.me (payment_event pendente). */
  paymentWorker: "pdv:payment:worker",
  /** Relê no gateway as cobranças que nenhum webhook confirmou. */
  paymentReconciliation: "pdv:payment:reconciliation",
} as const;

export type LockName = (typeof LOCKS)[keyof typeof LOCKS];

export type LockAttempt<T> =
  /** Lock obtido: `value` é o retorno de `fn`. */
  | { acquired: true; value: T }
  /** Lock ocupado por outro processo: `fn` nem rodou, ciclo pulado. */
  | { acquired: false };

/**
 * Roda `fn` numa transação, mas só se o advisory lock `name` estiver livre.
 *
 * `fn` recebe a transação: é onde a leitura e a escrita do ciclo têm de
 * morar, para o lote ser atômico (ou commita inteiro, ou nada). O lock
 * segure a transação aberta durante toda a execução de `fn` e é liberado no
 * COMMIT — é por isso que segurar lock através de chamada HTTP externa
 * funciona, mas custa uma conexão do pool durante a chamada.
 */
export async function tryWithAdvisoryLock<T>(
  name: LockName,
  fn: (tx: Tx) => Promise<T>,
): Promise<LockAttempt<T>> {
  return db.transaction(async (tx) => {
    const res = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${name})) AS locked`,
    );
    if (!res.rows[0]?.locked) return { acquired: false };
    return { acquired: true, value: await fn(tx) };
  });
}
