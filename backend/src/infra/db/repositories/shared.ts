/**
 * Helpers dos adapters Postgres (`repositories/*.repository.ts`).
 *
 * Genérico de mais de um adapter mora aqui; o que tem um dono só (ex.:
 * `toJsonText`) fica junto da classe. Nada aqui toca banco.
 */

export function notImplemented(what: string): never {
  throw new Error(`not_implemented: ${what}`);
}
