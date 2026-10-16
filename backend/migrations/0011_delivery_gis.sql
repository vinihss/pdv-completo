-- Recursos geoespaciais por tenant. A extensão é compartilhada pelo database;
-- as tabelas e índices abaixo vivem no schema selecionado pelo runner.
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA public;

CREATE TABLE IF NOT EXISTS delivery_region (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  area_geografica geometry(Polygon, 4326) NOT NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
);
CREATE INDEX IF NOT EXISTS idx_delivery_region_area ON delivery_region USING GIST (area_geografica);

ALTER TABLE courier_location ADD COLUMN IF NOT EXISTS position geometry(Point, 4326);
ALTER TABLE courier_location ADD COLUMN IF NOT EXISTS region_id TEXT REFERENCES delivery_region(id) ON DELETE SET NULL;
UPDATE courier_location
SET position = ST_SetSRID(ST_MakePoint(longitude, latitude), 4326)
WHERE position IS NULL;
CREATE INDEX IF NOT EXISTS idx_courier_location_position ON courier_location USING GIST (position);

ALTER TABLE delivery ADD COLUMN IF NOT EXISTS coordinate geometry(Point, 4326);
ALTER TABLE delivery ADD COLUMN IF NOT EXISTS region_id TEXT REFERENCES delivery_region(id) ON DELETE SET NULL;
ALTER TABLE delivery ADD COLUMN IF NOT EXISTS route_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_delivery_region_status ON delivery(region_id, status);

CREATE TABLE IF NOT EXISTS delivery_region_route (
  id TEXT PRIMARY KEY,
  region_id TEXT NOT NULL REFERENCES delivery_region(id) ON DELETE CASCADE,
  geometry geometry(LineString, 4326) NOT NULL,
  ordered_delivery_ids TEXT[] NOT NULL,
  distance_meters INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delivery_region_route_region ON delivery_region_route(region_id, created_at DESC);
