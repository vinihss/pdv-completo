// Helpers de precisão monetária. O schema usa REAL (reais) — floats de 8
// bytes — então toda comparação/subtração de dinheiro precisa passar por
// aqui pra não herdar cauda de 0.1+0.2. (Se o modo cloud/Postgres entrar,
// NUMERIC(10,2) resolve na origem; esses helpers continuam válidos.)

export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

// Igualdade com tolerância de 1 centavo (absorve diferença de arredondamento
// entre valores que passaram por parseBRL/parseFloat em caminhos diferentes).
export function moneyEq(a: number, b: number): boolean {
  return Math.abs(round2(a) - round2(b)) <= 0.001;
}