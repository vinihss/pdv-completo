// Roda uma vez antes de qualquer suíte: garante que cada execução de teste
// começa com um banco limpo (o client do Drizzle cria os arquivos no import).
import fs from "node:fs";
import path from "node:path";

export default function globalSetup() {
  const dbFile = path.resolve("data/test.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(dbFile + suffix, { force: true });
  }
  return () => {
    for (const suffix of ["", "-wal", "-shm"]) {
      fs.rmSync(dbFile + suffix, { force: true });
    }
  };
}