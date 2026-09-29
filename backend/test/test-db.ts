// URL do Postgres dedicado aos testes. Fica num módulo só porque o
// vitest.config.ts (processo principal) e o global-setup (runner) precisam
// resolver a MESMA string — se divergirem, o setup limpa um banco e os testes
// rodam em outro.
//
// `TEST_DATABASE_URL` permite apontar para outro Postgres (ex.: CI) sem
// hardcode de senha/porta em vários lugares.
//
// Com fileParallelism habilitado, o global-setup cria um banco por worker
// (pdv_test_{poolId}) e define DATABASE_URL antes dos imports. Este módulo
// lê DATABASE_URL do ambiente para herdar o banco correto.
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  "postgres://pdv:pdv_test_pw@localhost:55432/pdv_test";
