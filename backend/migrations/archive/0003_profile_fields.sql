-- Perfil completo de equipe e cliente + busca ignorando acentos.
--
-- user: telefone, email e foto (photo_path, mesmo padrão de product.image_path —
-- o app grava <id>.<ext> em UPLOADS_DIR e serve /uploads/<id>.<ext>).
-- customer: email e soft-delete (active) — cliente tem histórico de pedidos
-- (order.customer_id), então nunca se apaga de verdade.
-- unaccent: extensão do Postgres para busca por nome sem distinguir acentos
-- (ex.: "Cerveja" acha "Cerveja" e vice-versa). Trusted extension, disponível
-- em qualquer instalação Postgres padrão.

CREATE EXTENSION IF NOT EXISTS unaccent;

ALTER TABLE "user" ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS photo_path TEXT;
-- Email único quando informado (NULLs não colidem — parcial).
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_email ON "user"(email) WHERE email IS NOT NULL;

ALTER TABLE customer ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE customer ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_email ON customer(email) WHERE email IS NOT NULL;
