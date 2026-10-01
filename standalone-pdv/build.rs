// `tauri_build` faz duas coisas que importam aqui:
//
// 1. valida o `tauri.conf.json` e gera os schemas de capability em `gen/schemas`
//    (é o que o `$schema` de `capabilities/default.json` aponta);
// 2. copia o sidecar de `bundle.externalBin` — e ABORTA se o binário da
//    plataforma atual não existir.
//
// O `externalBin` do daemon de impressão foi REMOVIDO (o printer foi
// reestruturado e `printer/scripts/build-sidecar.sh` não existe mais), então
// este `cargo check` roda sem gerar sidecar nenhum. Quando o novo printer
// for embutido, re-adicionar `externalBin` junto com o passo de build dele.
fn main() {
  tauri_build::build()
}
