-- 0022: Localização, frete por distância e cache de geocoding
-- Coordenadas do restaurante, tabela de frete, free delivery e cache.

-- Coordenadas do restaurante (geocodificadas pelo gerente nas Configurações)
ALTER TABLE store_settings ADD COLUMN restaurant_lat REAL;
ALTER TABLE store_settings ADD COLUMN restaurant_long REAL;

-- Frete grátis acima deste valor de itens (0 = desativado)
ALTER TABLE store_settings ADD COLUMN free_delivery_min REAL NOT NULL DEFAULT 0;

-- Tabela de frete por distância (JSON): [{ "maxKm": 3, "fee": 5.00 }, ...]
-- A última faixa define o limite máximo; acima dela = fora da área.
ALTER TABLE store_settings ADD COLUMN delivery_fee_tiers TEXT NOT NULL DEFAULT '[]';

-- Coordenadas do endereço do cliente (geocodificadas no checkout)
ALTER TABLE customer_address ADD COLUMN latitude REAL;
ALTER TABLE customer_address ADD COLUMN longitude REAL;

-- Dados da entrega calculados no pedido
ALTER TABLE delivery ADD COLUMN distance_km REAL;
ALTER TABLE delivery ADD COLUMN estimated_minutes INTEGER;

-- Cache de geocoding (reverso e forward) para reduzir chamadas externas
CREATE TABLE geocoding_cache (
  cache_key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (current_timestamp),
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_geocoding_cache_expires ON geocoding_cache(expires_at);
