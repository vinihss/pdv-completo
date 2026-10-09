# Migrations do registry de tenants

Este diretório contém somente migrations globais do registry, aplicadas pelo runner dedicado `backend/src/infra/db/registry-migrate.ts` em `public`. O runner do tenant não deve ler estes arquivos: eles não pertencem aos schemas de loja.

A ordem é lexical e o filename é persistido em `public._registry_migrations`; nomes publicados são imutáveis. Consulte [`../README.md`](../README.md) e os comentários SQL antes de criar ou alterar uma migration.
