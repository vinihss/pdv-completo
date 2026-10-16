import { randomUUID } from "node:crypto";
import { getTenantPool } from "../../infra/db/tenant-db.js";
import { resolveTenantSchemaInScope } from "../../infra/db/tenant-context.js";

const OSRM_URL = (process.env.OSRM_URL ?? "http://localhost:5001").replace(/\/$/, "");
const OSRM_TIMEOUT_MS = 10_000;
type Point = { latitude: number; longitude: number };

function db() { return getTenantPool(resolveTenantSchemaInScope()); }
function validatePoint(point: Point) {
  if (!Number.isFinite(point.latitude) || point.latitude < -90 || point.latitude > 90 ||
      !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude > 180) {
    throw Object.assign(new Error("Coordenada inválida"), { statusCode: 400 });
  }
}

export async function listRegions() {
  const { rows } = await db().query(
    `SELECT id, name, ST_AsGeoJSON(area_geografica)::json AS geometry
     FROM delivery_region ORDER BY name`,
  );
  return rows;
}

export async function saveRegion(input: { id?: string; name: string; geometry: { type: "Polygon"; coordinates: number[][][] } }) {
  if (!input.name.trim() || input.geometry?.type !== "Polygon" || !Array.isArray(input.geometry.coordinates)) {
    throw Object.assign(new Error("Nome e polígono GeoJSON são obrigatórios"), { statusCode: 400 });
  }
  const validRings = input.geometry.coordinates.length > 0 && input.geometry.coordinates.every((ring) => {
    if (ring.length < 4) return false;
    const inRange = ring.every((coordinate) => Number.isFinite(coordinate[0]) && Number.isFinite(coordinate[1]) &&
      coordinate[0] >= -180 && coordinate[0] <= 180 && coordinate[1] >= -90 && coordinate[1] <= 90);
    const first = ring[0];
    const last = ring[ring.length - 1];
    return inRange && first[0] === last[0] && first[1] === last[1];
  });
  if (!validRings) throw Object.assign(new Error("Polígono inválido: anéis devem ser fechados e conter coordenadas WGS84 válidas"), { statusCode: 400 });
  const id = input.id ?? randomUUID();
  const { rows } = await db().query(
    `INSERT INTO delivery_region(id, name, area_geografica)
     VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, area_geografica = EXCLUDED.area_geografica
     RETURNING id, name, ST_AsGeoJSON(area_geografica)::json AS geometry`,
    [id, input.name.trim(), JSON.stringify(input.geometry)],
  );
  return rows[0];
}

export async function assignDeliveryCoordinate(deliveryId: string, point: Point) {
  validatePoint(point);
  const { rows } = await db().query(
    `WITH point AS (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326) AS geom),
     match AS (SELECT r.id FROM delivery_region r, point p WHERE ST_Contains(r.area_geografica, p.geom) ORDER BY ST_Area(r.area_geografica::geography) LIMIT 1)
     UPDATE delivery d SET coordinate = point.geom, region_id = (SELECT id FROM match)
     FROM point WHERE d.id = $1
     RETURNING d.id, d.region_id`,
    [deliveryId, point.longitude, point.latitude],
  );
  if (!rows[0]) throw Object.assign(new Error("Entrega não encontrada"), { statusCode: 404 });
  return rows[0];
}

export async function updateCourierPosition(courierId: string, point: Point) {
  validatePoint(point);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const previous = await client.query<{ region_id: string | null }>(
      "SELECT region_id FROM courier_location WHERE courier_id = $1 FOR UPDATE", [courierId],
    );
    const { rows } = await client.query(
      `WITH point AS (SELECT ST_SetSRID(ST_MakePoint($2, $3), 4326) AS geom),
       match AS (SELECT r.id FROM delivery_region r, point p WHERE ST_Contains(r.area_geografica, p.geom) ORDER BY ST_Area(r.area_geografica::geography) LIMIT 1)
       UPDATE courier_location c SET position = point.geom, region_id = (SELECT id FROM match)
       FROM point WHERE c.courier_id = $1
       RETURNING c.courier_id, c.region_id, c.updated_at`,
      [courierId, point.longitude, point.latitude],
    );
    const result = rows[0] ?? null;
    const oldRegionId = previous.rows[0]?.region_id ?? null;
    if (result && oldRegionId !== result.region_id) {
      await client.query(
        `INSERT INTO outbox_event(id, event_type, payload, room, published, created_at)
         VALUES ($1, 'courier.region_changed', $2, 'deliveries', false, $3)`,
        [randomUUID(), JSON.stringify({ courierId, regionId: result.region_id }), new Date().toISOString()],
      );
    }
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

interface OsrmTrip {
  code: string;
  trips?: Array<{ geometry: { coordinates: number[][] }; distance: number; duration: number }>;
  waypoints?: Array<{ waypoint_index: number; trips_index: number }>;
}

export async function routeRegion(regionId: string) {
  const { rows: stops } = await db().query(
    `SELECT d.id, ST_X(d.coordinate) AS longitude, ST_Y(d.coordinate) AS latitude
     FROM delivery d WHERE d.region_id = $1 AND d.status IN ('awaiting_courier', 'out_for_delivery') AND d.coordinate IS NOT NULL
     ORDER BY d.created_at, d.id`, [regionId],
  );
  if (!stops.length) throw Object.assign(new Error("Não há entregas pendentes georreferenciadas nesta região"), { statusCode: 409 });
  if (stops.length > 100) throw Object.assign(new Error("O serviço OSRM aceita até 100 paradas por rota"), { statusCode: 422 });

  let trip: NonNullable<OsrmTrip["trips"]>[number];
  let waypoints: NonNullable<OsrmTrip["waypoints"]>;
  if (stops.length === 1) {
    const coordinate: [number, number] = [Number(stops[0].longitude), Number(stops[0].latitude)];
    trip = { geometry: { coordinates: [coordinate, coordinate] }, distance: 0, duration: 0 };
    waypoints = [{ waypoint_index: 0, trips_index: 0 }];
  } else {
    const coordinates = stops.map((s) => `${s.longitude},${s.latitude}`).join(";");
    const url = `${OSRM_URL}/trip/v1/driving/${coordinates}?roundtrip=false&source=first&destination=last&overview=full&geometries=geojson&steps=false`;
    let result: OsrmTrip;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(OSRM_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      result = await response.json() as OsrmTrip;
    } catch (error) {
      throw Object.assign(new Error(`OSRM indisponível: ${error instanceof Error ? error.message : "erro de rede"}`), { statusCode: 502 });
    }
    trip = result.trips?.[0]!;
    waypoints = result.waypoints!;
    if (result.code !== "Ok" || !trip || !waypoints) throw Object.assign(new Error("OSRM não conseguiu montar uma rota para estas paradas"), { statusCode: 422 });
  }

  const ordered = stops.map((stop, index) => ({ id: stop.id as string, waypointIndex: waypoints[index].waypoint_index }))
    .sort((a, b) => a.waypointIndex - b.waypointIndex);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    for (const [index, stop] of ordered.entries()) {
      await client.query("UPDATE delivery SET route_order = $2 WHERE id = $1", [stop.id, index + 1]);
    }
    const routeId = randomUUID();
    await client.query(
      `INSERT INTO delivery_region_route(id, region_id, geometry, ordered_delivery_ids, distance_meters, duration_seconds, created_at)
       VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326), $4, $5, $6, $7)`,
      [routeId, regionId, JSON.stringify({ type: "LineString", coordinates: trip.geometry.coordinates }), ordered.map((s) => s.id), Math.round(trip.distance), Math.round(trip.duration), new Date().toISOString()],
    );
    await client.query("COMMIT");
    return { id: routeId, regionId, deliveryIds: ordered.map((s) => s.id), geometry: { type: "LineString", coordinates: trip.geometry.coordinates }, distanceMeters: trip.distance, durationSeconds: trip.duration };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
