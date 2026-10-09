# Arquivo histórico de migrations

Os arquivos SQL deste diretório registram a cadeia anterior ao baseline consolidado de `../0001_init.sql` e alterações históricas. O runner de `backend/src/infra/db/migrate.ts` lê apenas arquivos SQL diretamente em `backend/migrations/`; logo, nada aqui é aplicado automaticamente.

Não mova arquivos de volta à raiz nem edite/reexecute-os como se fossem pendências. Para schema novo ou mudança futura, siga [`../README.md`](../README.md) e crie migration incremental nova na raiz.
