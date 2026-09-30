// `tauri_build` faz duas coisas que importam aqui:
//
// 1. valida o `tauri.conf.json` e gera os schemas de capability em `gen/schemas`
//    (é o que o `$schema` de `capabilities/default.json` aponta);
// 2. copia o sidecar de `bundle.externalBin` — e ABORTA se o binário da
//    plataforma atual não existir. Como este app declara
//    `externalBin: ["binaries/pdv-printer-daemon"]`, o `cargo check` no Linux
//    só roda com `binaries/pdv-printer-daemon-x86_64-unknown-linux-gnu`
//    presente. `./build-sidecar.sh` resolve (ver `binaries/README.md`).
fn main() {
  tauri_build::build()
}
