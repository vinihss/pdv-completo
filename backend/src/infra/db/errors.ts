const UNIQUE_VIOLATION = "23505";
const MAX_CAUSE_DEPTH = 5;

// O Drizzle embrulha o erro do node-postgres em `DrizzleQueryError`, e o erro
// original (com `code`/`constraint`) fica em `cause`. Inspecionar só o topo
// faz a checagem passar batizada e o `23505` vazar como 500 — daí percorrer a
// cadeia.
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: { cause?: unknown } | null | undefined = err as { cause?: unknown } | null | undefined;
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    chain.push(current);
    current = (current as { cause?: { cause?: unknown } }).cause;
  }
  return chain;
}

export function isUniqueViolation(err: unknown): boolean {
  return errorChain(err).some((e) => (e as { code?: string }).code === UNIQUE_VIOLATION);
}

export function isUniqueViolationOn(err: unknown, constraint: string): boolean {
  return errorChain(err).some(
    (e) =>
      (e as { code?: string }).code === UNIQUE_VIOLATION &&
      (e as { constraint?: string }).constraint === constraint
  );
}
