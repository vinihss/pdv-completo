# Scripts e ferramentas de desenvolvimento

Este diretório contém scripts de setup, build e release. O código-fonte da CLI Go está em `cmd/pdv/`; a cópia compilada `pdv-cli` não é fonte e não deve ser versionada. Confira a ajuda da CLI localmente depois de instalá-la — os comandos evoluem junto com o código.

## Localizar scripts

| Caminho | Uso |
|---|---|
| [`dev/setup-dev.sh`](dev/setup-dev.sh) | Preparar ambiente local de desenvolvimento |
| [`dev/dev-worktree.sh`](dev/dev-worktree.sh) | Criar/listar/remover worktrees de desenvolvimento |
| [`build/build-app.sh`](build/build-app.sh) | Build do app Tauri legado em `frontend/src-tauri/` |
| [`build/build-standalone.sh`](build/build-standalone.sh) | Build dos apps standalone Tauri |
| [`build/install-cli.sh`](build/install-cli.sh) | Compilar/instalar a CLI Go a partir de `cmd/pdv/` |
| [`release/bump-version.sh`](release/bump-version.sh) | Atualizar versões dos artefatos standalone |
| [`lib/common.sh`](lib/common.sh), [`lib/build-tauri.sh`](lib/build-tauri.sh) | Bibliotecas shell usadas pelos scripts de build/setup |

Para deployment, use [`../deploy/README.md`](../deploy/README.md). Para validar testes/builds, consulte [`../docs/agent-testing.md`](../docs/agent-testing.md) e os comandos dos `package.json` do componente. Não use instruções antigas que mencionem um executável `./pdv` na raiz ou diretórios de serviço que não existam no checkout.

## Desenvolvimento manual

- Backend: `cd ../backend && npm ci`; consulte `../docs/agent-backend.md` para banco, ambiente e testes.
- Frontend: `cd ../frontend && npm ci`; `npm run dev`, `npm run lint`, `npm run test` e `npm run build` conforme a tarefa.
- Apps Rust/Tauri: use o workspace Cargo da raiz e os README de cada crate. Build exige toolchain Rust/Tauri e pode ter requisitos específicos de assinatura.
- CLI: `cd ../cmd/pdv && go test ./...`; instalação via `build/install-cli.sh` depende da configuração descrita no próprio script.

Os caminhos relativos dos comandos são em relação à raiz do repositório, salvo quando o comando mostra `cd` explícito.
