// =============================================================================
// Supabase Edge Function: "news"
// Life - Student Edition
//
// Replaces the single-feed version. Each area has a CHAIN of sources, tried in
// order until one returns usable headlines, so one dead feed no longer takes the
// whole panel down. No API key needed by any source here.
//
// Deploy with:  supabase functions deploy news --no-verify-jwt
//
// Routes:
//   GET ?area=uk
//   GET ?area=berkshire&q=Berkshire
//
// `q` is the area's display name and is only used to build the Google News
// search fallback. If it's missing the chain just skips that step.
//
// Response:
//   { items: [{ title, link, date, source }], source: "BBC Berkshire",
//     tried: [...], fallback: false, cached: false }
//
// Optional secrets:
//   NEWS_CACHE_TTL   seconds to cache each area (default 600)
//   NEWS_UA          User-Agent sent upstream (some feeds reject blank ones)
// =============================================================================

const TTL = Number(Deno.env.get("NEWS_CACHE_TTL") ?? "600") * 1000;
const UA = Deno.env.get("NEWS_UA") ??
  "Mozilla/5.0 (compatible; LifeStudentEdition/1.0; +https://dpaul.studio)";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type Item = { title: string; link: string; date: string | null; source: string };
type Source = { name: string; url: string };

const cache = new Map<string, { at: number; body: unknown }>();

// -----------------------------------------------------------------------------
// Source chains
// -----------------------------------------------------------------------------
const googleNews = (query: string, name: string): Source => ({
  name,
  url: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`,
});

// BBC uses a different path for the nations
const NATIONS: Record<string, string> = {
  scotland: "scotland",
  wales: "wales",
  northern_ireland: "northern_ireland",
};

function chainFor(area: string, label: string): Source[] {
  if (area === "uk") {
    return [
      { name: "BBC News", url: "https://feeds.bbci.co.uk/news/uk/rss.xml" },
      { name: "Sky News", url: "https://feeds.skynews.com/feeds/rss/uk.xml" },
      { name: "The Guardian", url: "https://www.theguardian.com/uk-news/rss" },
      googleNews("United Kingdom", "Google News"),
    ];
  }

  const out: Source[] = [];
  if (NATIONS[area]) {
    out.push({ name: `BBC ${label}`, url: `https://feeds.bbci.co.uk/news/${NATIONS[area]}/rss.xml` });
  } else {
    out.push({ name: `BBC ${label}`, url: `https://feeds.bbci.co.uk/news/england/${area}/rss.xml` });
  }
  if (label) out.push(googleNews(`${label} news`, `Google News: ${label}`));
  // Last resort so the panel is never empty
  out.push({ name: "BBC England", url: "https://feeds.bbci.co.uk/news/england/rss.xml" });
  return out;
}

// -----------------------------------------------------------------------------
// A small, forgiving RSS / Atom reader. Deliberately not a full XML parser:
// these feeds are simple and a regex reader has no dependencies to rot.
// -----------------------------------------------------------------------------
function decode(v: string): string {
  return v
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, names: string[]): string {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, "i").exec(block);
    if (m) return decode(m[1]);
  }
  return "";
}

function linkOf(block: string): string {
  const plain = tag(block, ["link"]);
  if (/^https?:\/\//i.test(plain)) return plain;
  // Atom: <link rel="alternate" href="...">
  const m = /<link[^>]*href=["']([^"']+)["'][^>]*>/i.exec(block);
  if (m && /^https?:\/\//i.test(m[1])) return m[1];
  const guid = tag(block, ["guid", "id"]);
  return /^https?:\/\//i.test(guid) ? guid : "";
}

function parseFeed(xml: string, fallbackSource: string): Item[] {
  const blocks = xml.match(/<(?:item|entry)(?:\s[^>]*)?>[\s\S]*?<\/(?:item|entry)>/gi) || [];
  const items: Item[] = [];
  for (const b of blocks) {
    const title = tag(b, ["title"]);
    const link = linkOf(b);
    if (!title || !link) continue;
    const raw = tag(b, ["pubDate", "published", "updated", "dc:date"]);
    const d = raw ? new Date(raw) : null;
    // Google News puts the publisher in <source>; everything else gets the feed's name
    const src = tag(b, ["source"]) || fallbackSource;
    items.push({
      title: title.slice(0, 300),
      link,
      date: d && !isNaN(d.getTime()) ? d.toISOString() : null,
      source: src.slice(0, 60),
    });
    if (items.length >= 25) break;
  }
  return items;
}

// Google News titles are "Headline - Publisher"; strip the tail, it's shown separately
function tidyGoogleTitles(items: Item[]): Item[] {
  return items.map((it) => {
    if (!it.source) return it;
    const suffix = ` - ${it.source}`;
    return it.title.endsWith(suffix)
      ? { ...it, title: it.title.slice(0, -suffix.length).trim() }
      : it;
  });
}

// A feed that hasn't moved in a fortnight is stale, not working
function looksFresh(items: Item[]): boolean {
  if (items.length < 3) return false;
  const newest = items
    .map((i) => (i.date ? Date.parse(i.date) : 0))
    .reduce((a, b) => Math.max(a, b), 0);
  return !newest || Date.now() - newest < 14 * 24 * 3600 * 1000;
}

async function fetchSource(src: Source): Promise<Item[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    let items = parseFeed(xml, src.name);
    if (src.url.includes("news.google.com")) items = tidyGoogleTitles(items);
    return items;
  } finally {
    clearTimeout(t);
  }
}

// -----------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const url = new URL(req.url);
  const area = (url.searchParams.get("area") || "uk").toLowerCase().replace(/[^a-z_]/g, "");
  const label = (url.searchParams.get("q") || "").replace(/[^\w\s,'-]/g, "").slice(0, 40);
  if (!area) return json({ error: "No news area given." }, 400);

  const key = `${area}|${label}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) {
    return json({ ...(hit.body as object), cached: true });
  }

  const chain = chainFor(area, label);
  const tried: Array<{ name: string; result: string }> = [];

  for (let i = 0; i < chain.length; i++) {
    const src = chain[i];
    try {
      const items = await fetchSource(src);
      if (!looksFresh(items)) {
        tried.push({ name: src.name, result: items.length ? "stale" : "empty" });
        continue;
      }
      const body = {
        items,
        source: src.name,
        fallback: i > 0,          // true when the first choice didn't answer
        tried,
        cached: false,
      };
      cache.set(key, { at: Date.now(), body });
      return json(body);
    } catch (e) {
      tried.push({ name: src.name, result: (e as Error).message || "failed" });
    }
  }

  // Everything failed: serve whatever's in the cache, however old, rather than nothing
  if (hit) return json({ ...(hit.body as object), cached: true, stale: true, tried });
  return json({ items: [], source: "", tried, error: "No news source answered." }, 502);
});
