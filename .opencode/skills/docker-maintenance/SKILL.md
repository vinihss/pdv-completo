---
name: docker-maintenance
description: Diagnosticar stacks Docker do projeto com escopo explícito e sem alterar produção.
---
# Diagnóstico Docker seguro

1. Identifique o compose e o ambiente (`dev`, `local` ou produção) antes de comandos.
2. Comece com operações somente leitura: `docker compose ... ps`, `logs --tail`, `config --services`. Não exiba variáveis secretas.
3. Não rode `up`, `down`, `restart`, `exec` com escrita, prune, remoção de volumes ou deploy sem solicitação e escopo explícitos. Ações de produção exigem confirmação do impacto e procedimento do runbook.
4. Ao reportar, inclua serviço, ambiente, evidência e próximo passo seguro.
