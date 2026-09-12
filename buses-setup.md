# Buses edge function — setup

The key never touches the page. It lives as a Supabase secret, same pattern as
your `trains` and `news` functions.

## 1. Cache table (do this first)

Supabase → SQL Editor. The function works without it, but each edge isolate then
caches on its own, so you'd burn through the daily allowance far quicker.

```sql
create table if not exists public.tapi_cache (
  key  text primary key,
  body jsonb  not null,
  at   bigint not null
);
alter table public.tapi_cache enable row level security;
-- no policies: only the service role (the function) touches this
```

## 2. Secrets

Supabase → Project Settings → Edge Functions → Secrets.

| Name | Value |
|---|---|
| `TRANSPORTAPI_APP_ID` | `10125585` |
| `TRANSPORTAPI_APP_KEY` | **a freshly generated key** — not the one pasted in chat |
| `TAPI_DAILY_BUDGET` | `25` on Free, `250` on the Home plan |
| `TAPI_STOPS` | `1` on Free, `3` on the Home plan |
| `TAPI_NEXTBUSES` | `no` on Free, `yes` on the Home plan |
| `TAPI_LIVE_TTL` | `600` on Free, `120` on the Home plan |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically —
don't add them.

## 3. Deploy

```bash
supabase functions deploy buses --no-verify-jwt
```

`--no-verify-jwt` matters: the page calls it with a plain `fetch` and no auth
header, exactly like `trains`.

## 4. Test

```bash
curl "https://ucnqhcxsomfelpgmruhb.supabase.co/functions/v1/buses?lat=51.5227&lon=-0.7153"
curl "https://ucnqhcxsomfelpgmruhb.supabase.co/functions/v1/buses?lat=51.5227&lon=-0.7153&stations=1"
```

The first should return `stops` with `departures`; the second `stations` with
CRS codes. Every response carries `budget: { used, limit }` so you can watch the
allowance. Run the same call twice — `used` should not move the second time.

## What it does to stay inside 30 requests a day

- Nearby stops and nearest stations are cached **30 days** per rounded
  coordinate. Stops don't move, so this is a one-off cost per location.
- Live departures are cached and shared across every user, so twenty students at
  the same stop cost one upstream call, not twenty.
- The browser won't re-request inside 90 seconds and only polls every 3 minutes
  while the page is visible.
- A daily counter stops upstream calls at `TAPI_DAILY_BUDGET` and serves the last
  known times instead, flagged `stale: true`. The app shows "Showing the last
  times we got" rather than an error.
- `TAPI_NEXTBUSES=no` gets timetabled times for 1 request. `yes` gets real-time
  but TransportAPI bills it as more than one, so it's off by default.

Even so: on the Free plan, `TAPI_STOPS=1` and a 10-minute cache works out at
roughly 100 upstream calls a day if the app were used continuously, which is
over the 30 limit. The budget cap absorbs it, but the times go stale by
mid-morning. The £5/month Home plan is what makes this actually usable.

## Endpoints used

| Purpose | TransportAPI endpoint |
|---|---|
| Nearest bus stops | `GET /v3/uk/bus/stops/near.json?lat=&lon=&rpp=10` |
| Live departures | `GET /v3/uk/bus/stop/{atcocode}/live.json?group=no&nextbuses=&limit=12` |
| Nearest stations | `GET /v3/uk/places.json?lat=&lon=&type=train_station&rpp=5` |

Auth goes in the `X-App-Id` / `X-App-Key` headers rather than the query string,
so the credentials stay out of any upstream logs.

If `places.json` doesn't return `station_code` on your plan, the station
auto-fill quietly does nothing and the Stations box still works by hand — trains
carry on regardless, since they go through your `trains` function, not this one.
