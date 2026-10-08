---
name: sync-sidecar
description: Conferir e sincronizar mudanças relacionadas ao daemon/sidecar de impressão.
---
# Sincronização de impressão

1. Leia `docs/agente-hardware-printing.md`, `printer/README.md` e o guia da aplicação afetada antes de editar.
2. Confirme o estado atual do empacotamento nos manifests e workflows: não presuma que o sidecar está embutido ou que scripts antigos existem.
3. Preserve compatibilidade dos contratos e renderizações; quando aplicável, rode testes Go e os testes golden ESC/POS do app Caixa.
4. Atualize documentação canônica e referências quando caminhos, build ou estado do sidecar mudarem. Relate testes não executados.
