-- Cor principal da marca (identidade) — aplicada no tema do sistema e na
-- página externa de pedidos. Padrão: o amber atual (#f59e0b).
ALTER TABLE store_settings ADD COLUMN brand_color TEXT NOT NULL DEFAULT '#f59e0b';