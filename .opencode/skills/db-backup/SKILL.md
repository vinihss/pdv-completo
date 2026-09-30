---
name: db-backup
description: Executa rotinas de manutenção, verificação de integridade ou extração de dumps do banco Postgres local.
---

### Algoritmo de Execução
1. Localize o nome do container do banco rodando `docker ps | grep postgres`.
2. Para gerar um backup de segurança antes de tarefas críticas, sugira o comando: `docker exec -t <container_id> pg_dumpall -c -U postgres > ./deploy/state/backup_pre_manutencao.sql`.
