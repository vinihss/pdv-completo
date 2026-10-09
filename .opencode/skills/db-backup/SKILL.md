---
name: db-backup
description: Planejar backups locais de PostgreSQL sem selecionar ambientes por heurísticas frágeis.
---
# Backup de banco

1. Leia `docs/agent-db-maintenance.md` e o runbook operacional antes de qualquer operação.
2. Identifique explicitamente compose, serviço, ambiente e banco; não escolha container por `grep postgres`. Não presuma que um nome de container implica ambiente local.
3. Não conecte nem faça dump de produção sem autorização explícita e escopo aprovado.
4. Antes de gerar arquivo, confira destino, permissões, espaço e tratamento de dados/segredos; não grave backup em caminho versionado. Use os procedimentos atuais de `deploy/README.md`.
5. Relate escopo, localização do artefato e validação, sem expor credenciais ou dados sensíveis.
