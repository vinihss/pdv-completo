# Instruções para Claude Code

Leia [`AGENTS.md`](AGENTS.md) para as regras globais e [`docs/README.md`](docs/README.md) para localizar a fonte canônica da tarefa. Carregue apenas os guias da área afetada.

> Os apps mobile saíram para **`pdv-mobile-apps`** (repo separado). As cascas Tauri
> Os crates Tauri dos apps Garçom/Entregador foram **removidos** deste repositório
> (RN/Expo vive em `pdv-mobile-apps`). A família Tauri standalone restante é apenas
> `standalone-pdv` e `standalone-kds`.

## Regras desta ferramenta

- Antes de editar, verifique o escopo e as instruções aplicáveis mais próximas dos arquivos-alvo.
- Para estado atual, valide código, testes, `package.json`, scripts e CI; não repita contagens de testes ou versões sem conferir.
- Siga o protocolo de validação e relato em `AGENTS.md`. Se documentação e implementação divergirem em comportamento, dados ou segurança, sinalize o conflito em vez de escolher silenciosamente.
- A documentação não autoriza acesso a produção. Operações de banco seguem `docs/agent-db-maintenance.md`; pare se autorização, ambiente ou tenant não estiverem claros.
