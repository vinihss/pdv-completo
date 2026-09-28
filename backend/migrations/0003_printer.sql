-- Impressão térmica (daemon local): flags de rollout da integração.
-- printer_enabled  — master switch: liga/desliga a integração com o daemon.
-- printer_auto_print — impressão automática (cozinha no launch, courier no dispatch).
ALTER TABLE store_settings ADD COLUMN printer_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE store_settings ADD COLUMN printer_auto_print boolean NOT NULL DEFAULT false;
