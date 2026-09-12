// =============================================================================
// Supabase Edge Function: "buses"
// Life - Student Edition
//
// Holds the TransportAPI credentials so they never appear in the page.
// Deploy with:  supabase functions deploy buses --no-verify-jwt
//
// Secrets (Project Settings > Edge Functions > Secrets):
//   TRANSPORTAPI_APP_ID    required   your app_id
//   TRANSPORTAPI_APP_KEY   required   your app_key
//   TAPI_DAILY_BUDGET      optional   upstream calls allowed per day  (default 25)
//   TAPI_STOPS             optional   how many nearby stops to fetch  (default 2)
//   TAPI_NEXTBUSES         optional   "yes" for real-time, "no" for timetabled (default "no")
//   TAPI_LIVE_TTL          optional   seconds to cache live departures (default 180)
//
// The free TransportAPI plan is 30 requests a day for the WHOLE app, and
// nextbuses=yes is billed as more than one request. Everything below exists to
// squeeze that: shared caching, a hard daily budget, and stale-but-useful data
// once the budget runs out. On the £5/month Home plan (300/day) you can raise
// TAPI_DAILY_BUDGET to ~250, set TAPI_STOPS=3 and TAPI_NEXTBUSES=yes.
//
// Routes:
//   GET ?lat=51.52&lon=-0.71              -> nearby stops with departures
//   GET ?lat=51.52&lon=-0.71&stations=1   -> nearest train stations (CRS codes)
// =============================================================================

const APP_ID = Deno.env.get("TRANSPORTAPI_APP_ID") ?? "";
const APP_KEY = Deno.env.get("TRANSPORTAPI_APP_KEY") ?? "";
const DAILY_BUDGET = Number(Deno.env.get("TAPI_DAILY_BUDGET") ?? "25");
const STOP_COUNT = Math.max(1, Math.min(4, Number(Deno.env.get("TAPI_STOPS") ?? "2")));
const NEXTBUSES = (Deno.env.get("TAPI_NEXTBUSES") ?? "no").toLowerCase() === "yes" ? "yes" : "no";
const LIVE_TTL = Number(Deno.env.get("TAPI_LIVE_TTL") ?? "180") * 1000;

const STOPS_TTL = 30 * 24 * 3600 * 1000;   // bus stops do not move
const STATIONS_TTL = 30 * 24 * 3600 * 1000;

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const SHARED_CACHE = !!(SB_URL && SB_SERVICE_KEY);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// -----------------------------------------------------------------------------
// Cache: a Postgres table when one exists (shared across isolates and restarts),
// otherwise this isolate's memory. Falls back silently either way.
// -----------------------------------------------------------------------------
type Entry = { body: unknown; at: number };
const mem = new Map<string, Entry>();

async function cacheGet(key: string): Promise<Entry | null> {
  const local = mem.get(key);
  if (local) return local;
  if (!SHARED_CACHE) return null;
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/tapi_cache?key=eq.${encodeURIComponent(key)}&select=body,at`,
      { headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const entry: Entry = { body: rows[0].body, at: Number(rows[0].at) };
    mem.set(key, entry);
    return entry;
  } catch (_) {
    return null;
  }
}

async function cacheSet(key: string, body: unknown): Promise<void> {
  const entry: Entry = { body, at: Date.now() };
  mem.set(key, entry);
  if (!SHARED_CACHE) return;
  try {
    await fetch(`${SB_URL}/rest/v1/tapi_cache`, {
      method: "POST",
      headers: {
        apikey: SB_SERVICE_KEY,
        Authorization: `Bearer ${SB_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({ key, body, at: entry.at }),
    });
  } catch (_) { /* cache is best effort */ }
}

const fresh = (e: Entry | null, ttl: number) => !!e && Date.now() - e.at < ttl;

// -----------------------------------------------------------------------------
// Daily budget. Counts upstream TransportAPI calls, resets at midnight UTC.
// -----------------------------------------------------------------------------
function budgetKey() {
  return `budget:${new Date().toISOString().slice(0, 10)}`;
}

async function budgetUsed(): Promise<number> {
  const e = await cacheGet(budgetKey());
  return e ? Number((e.body as { n?: number })?.n ?? 0) : 0;
}

async function budgetSpend(n: number): Promise<void> {
  const key = budgetKey();
  const used = await budgetUsed();
  await cacheSet(key, { n: used + n });
}

// -----------------------------------------------------------------------------
// TransportAPI
// -----------------------------------------------------------------------------
async function tapi(path: string, params: Record<string, string>) {
  const url = new URL(`https://transportapi.com/v3/uk/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { "X-App-Id": APP_ID, "X-App-Key": APP_KEY, Accept: "application/json" },
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw Object.assign(new Error(`TransportAPI ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  }
  return await r.json();
}

const round = (v: number, dp: number) => Number(v.toFixed(dp));

// -----------------------------------------------------------------------------
// Departure shaping: flatten TransportAPI's route-keyed object into a flat list
// -----------------------------------------------------------------------------
function shapeDepartures(raw: Record<string, unknown>): unknown[] {
  const groups = (raw?.departures ?? {}) as Record<string, Array<Record<string, string | null>>>;
  const out: Array<Record<string, unknown>> = [];
  for (const list of Object.values(groups)) {
    if (!Array.isArray(list)) continue;
    for (const d of list) {
      const aimed = d.aimed_departure_time || null;
      const expected = d.expected_departure_time || d.best_departure_estimate || aimed;
      out.push({
        line: d.line_name || d.line || "",
        direction: d.direction || "",
        operator: d.operator_name || d.operator || "",
        date: d.date || null,
        aimed,
        expected,
        cancelled: !!(d.status as unknown as { cancellation?: { value?: boolean } })?.cancellation?.value,
        live: d.source === "NextBuses" || d.source === "Traveline timetable (nextbuses)",
      });
    }
  }
  out.sort((a, b) => String(a.expected ?? a.aimed).localeCompare(String(b.expected ?? b.aimed)));
  return out.slice(0, 12);
}

// -----------------------------------------------------------------------------
// Nearest train stations -> CRS codes
// -----------------------------------------------------------------------------
async function nearestStations(lat: number, lon: number) {
  const key = `stations:${round(lat, 2)},${round(lon, 2)}`;
  const hit = await cacheGet(key);
  if (fresh(hit, STATIONS_TTL)) return { stations: hit!.body, cached: true, stale: false };

  if ((await budgetUsed()) >= DAILY_BUDGET) {
    if (hit) return { stations: hit.body, cached: true, stale: true, reason: "budget" };
    throw Object.assign(new Error("Daily limit for the travel service reached."), { status: 429 });
  }

  const j = await tapi("places.json", {
    lat: String(lat), lon: String(lon), type: "train_station", rpp: "5",
  });
  await budgetSpend(1);

  const members = Array.isArray(j?.member) ? j.member : [];
  const stations = members
    .map((m: Record<string, unknown>) => ({
      code: String(m.station_code ?? m.code ?? "").toUpperCase(),
      name: String(m.name ?? ""),
      distance: m.distance ?? null,
    }))
    .filter((s: { code: string }) => /^[A-Z]{3}$/.test(s.code))
    .slice(0, 3);

  await cacheSet(key, stations);
  return { stations, cached: false, stale: false };
}

// -----------------------------------------------------------------------------
// Nearby bus stops, with departures for the closest few
// -----------------------------------------------------------------------------
async function nearbyBuses(lat: number, lon: number) {
  const nearKey = `near:${round(lat, 3)},${round(lon, 3)}`;
  let stops: Array<Record<string, unknown>> = [];
  let stale = false;
  let reason = "";

  const nearHit = await cacheGet(nearKey);
  if (fresh(nearHit, STOPS_TTL)) {
    stops = nearHit!.body as Array<Record<string, unknown>>;
  } else if ((await budgetUsed()) < DAILY_BUDGET) {
    const j = await tapi("bus/stops/near.json", {
      lat: String(lat), lon: String(lon), page: "1", rpp: "10",
    });
    await budgetSpend(1);
    stops = (Array.isArray(j?.stops) ? j.stops : [])
      .filter((s: Record<string, unknown>) => s.atcocode)
      .slice(0, 6)
      .map((s: Record<string, unknown>) => ({
        atcocode: s.atcocode,
        name: s.name ?? s.stop_name,
        stop_name: s.stop_name,
        indicator: s.indicator ?? "",
        bearing: s.bearing ?? "",
        locality: s.locality ?? "",
        distance: s.distance ?? null,
      }));
    await cacheSet(nearKey, stops);
  } else if (nearHit) {
    stops = nearHit.body as Array<Record<string, unknown>>;
    stale = true;
    reason = "budget";
  } else {
    throw Object.assign(new Error("Daily limit for the travel service reached."), { status: 429 });
  }

  const wanted = stops.slice(0, STOP_COUNT);
  const results = await Promise.all(wanted.map(async (stop) => {
    const atco = String(stop.atcocode);
    const liveKey = `live:${atco}:${NEXTBUSES}`;
    const hit = await cacheGet(liveKey);
    if (fresh(hit, LIVE_TTL)) return { ...stop, ...(hit!.body as object), fetchedAt: hit!.at };

    if ((await budgetUsed()) >= DAILY_BUDGET) {
      stale = true;
      reason = reason || "budget";
      return hit
        ? { ...stop, ...(hit.body as object), fetchedAt: hit.at }
        : { ...stop, departures: [], error: "Daily limit reached" };
    }

    try {
      const j = await tapi(`bus/stop/${encodeURIComponent(atco)}/live.json`, {
        group: "no", nextbuses: NEXTBUSES, limit: "12",
      });
      await budgetSpend(NEXTBUSES === "yes" ? 2 : 1);
      const body = {
        name: j.name ?? stop.name,
        stop_name: j.stop_name ?? stop.stop_name,
        indicator: j.indicator ?? stop.indicator,
        locality: j.locality ?? stop.locality,
        requestTime: j.request_time ?? null,
        departures: shapeDepartures(j),
      };
      await cacheSet(liveKey, body);
      return { ...stop, ...body, fetchedAt: Date.now() };
    } catch (e) {
      stale = true;
      reason = reason || "upstream";
      return hit
        ? { ...stop, ...(hit.body as object), fetchedAt: hit.at }
        : { ...stop, departures: [], error: (e as Error).message };
    }
  }));

  return {
    stops: results,
    stale,
    reason,
    live: NEXTBUSES === "yes",
    budget: { used: await budgetUsed(), limit: DAILY_BUDGET },
  };
}

// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  if (!APP_ID || !APP_KEY) {
    return json({ error: "The bus service isn't set up on this copy of the app yet." }, 503);
  }

  const url = new URL(req.url);
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return json({ error: "Set your location first." }, 400);
  }

  try {
    if (url.searchParams.get("stations")) return json(await nearestStations(lat, lon));
    return json(await nearbyBuses(lat, lon));
  } catch (e) {
    const err = e as Error & { status?: number };
    const status = err.status === 429 ? 429 : 502;
    return json({ error: err.message || "The bus service didn't answer." }, status);
  }
});
