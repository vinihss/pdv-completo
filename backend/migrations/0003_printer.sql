-- Impressão térmica (daemon local): flags de rollout da integração.
-- printer_enabled  — master switch: liga/desliga a integração com o daemon.
-- printer_auto_print — impressão automática (cozinha no launch, courier no dispatch).
-- IF NOT EXISTS: reexecutar a migration é seguro (o runner já pula arquivos
-- registrados em _migrations, mas o DDL não pode estourar se a coluna tiver
-- sido adicionada fora do runner). Alinhado com 0003_profile_fields.sql.
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS printer_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS printer_auto_print boolean NOT NULL DEFAULT false;
