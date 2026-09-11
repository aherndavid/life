// Supabase Edge Function "news" for Life - Student Edition (v2.7)
// Reads BBC News RSS feeds and returns the headlines as JSON for the app.
// Browsers can't read BBC feeds directly, which is why this small function is needed.
// No keys or secrets. Only the areas listed below can be requested.
//
//   .../functions/v1/news?area=berkshire     headlines for one area
//   .../functions/v1/news?check=1            health check: tests every area and reports what it found
//
// The BBC has been moving some local pages to new "topic" addresses, so each area lists the
// addresses to try in order. The first one with recent headlines wins. If none work, the
// function falls back to BBC England news so the panel is never empty, and says so.

const B = "https://feeds.bbci.co.uk/news/";
const FEEDS: Record<string, string[]> = {
  uk: ["uk"],
  scotland: ["scotland"],
  wales: ["wales"],
  northern_ireland: ["northern_ireland"],
  beds_bucks_and_herts: ["england/beds_bucks_and_herts"],
  berkshire: ["england/berkshire"],
  birmingham_and_black_country: ["england/birmingham_and_black_country", "topics/cerlz4j5m67t"],
  bristol: ["england/bristol"],
  cambridgeshire: ["england/cambridgeshire"],
  cornwall: ["england/cornwall"],
  coventry_and_warwickshire: ["england/coventry_and_warwickshire"],
  cumbria: ["england/cumbria"],
  derby: ["england/derbyshire", "england/derby"],
  devon: ["england/devon"],
  dorset: ["england/dorset"],
  essex: ["england/essex"],
  gloucestershire: ["england/gloucestershire"],
  hampshire: ["england/hampshire"],
  hereford_and_worcester: ["england/hereford_and_worcester"],
  humberside: ["england/hull_and_east_yorkshire", "england/humberside"],
  kent: ["england/kent"],
  lancashire: ["england/lancashire"],
  leeds_and_west_yorkshire: ["england/leeds_and_west_yorkshire", "topics/cq23pdgvrwyt"],
  leicester: ["england/leicester"],
  lincolnshire: ["england/lincolnshire"],
  london: ["england/london"],
  manchester: ["england/manchester", "topics/cjkm56d0p7et"],
  merseyside: ["england/merseyside", "topics/cwdnm99je6gt"],
  norfolk: ["england/norfolk"],
  northamptonshire: ["england/northamptonshire"],
  nottingham: ["england/nottingham"],
  oxford: ["england/oxford"],
  shropshire: ["england/shropshire"],
  somerset: ["england/somerset"],
  south_yorkshire: ["england/south_yorkshire"],
  stoke_and_staffordshire: ["england/stoke_and_staffordshire"],
  suffolk: ["england/suffolk"],
  surrey: ["england/surrey"],
  sussex: ["england/sussex"],
  tees: ["england/tees"],
  tyne_and_wear: ["england/tyne_and_wear"],
  wiltshire: ["england/wiltshire"],
  york_and_north_yorkshire: ["england/north_yorkshire", "england/york_and_north_yorkshire"],
};
const STALE_DAYS = 21; // a feed whose newest story is older than this is treated as dead

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&amp;/g, "&")
    .trim();
}
function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decode(m[1]) : "";
}
function json(body: unknown, status = 200, cache = "public, max-age=600") {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": cache },
  });
}

type Item = { title: string; link: string; date: string };

async function readFeed(path: string): Promise<{ items: Item[]; source: string; status: number }> {
  const r = await fetch(`${B}${path}/rss.xml`, {
    headers: { "User-Agent": "Life-Student-Edition/2.7 (+https://www.dpaul-software.uk)" },
  });
  if (!r.ok) return { items: [], source: "", status: r.status };
  const xml = await r.text();
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map((m) => ({
    title: tag(m[1], "title"),
    link: tag(m[1], "link"),
    date: tag(m[1], "pubDate"),
  })).filter((it) => it.title && it.link);
  return { items, source: tag(xml.split("<item>")[0], "title"), status: r.status };
}

function newest(items: Item[]): number {
  return Math.max(0, ...items.map((it) => Date.parse(it.date) || 0));
}

// Try each address for an area; first with recent headlines wins
async function forArea(area: string) {
  const tried: { path: string; status: number; count: number; newest: string }[] = [];
  for (const path of FEEDS[area]) {
    try {
      const f = await readFeed(path);
      const n = newest(f.items);
      tried.push({ path, status: f.status, count: f.items.length, newest: n ? new Date(n).toISOString() : "" });
      if (f.items.length && Date.now() - n < STALE_DAYS * 864e5) {
        return { area, source: f.source, path, items: f.items, fallback: false, tried };
      }
    } catch (_e) {
      tried.push({ path, status: 0, count: 0, newest: "" });
    }
  }
  // Nothing recent for this area: use BBC England so the panel still fills
  const eng = await readFeed("england").catch(() => ({ items: [] as Item[], source: "", status: 0 }));
  return { area, source: eng.source, path: "england", items: eng.items, fallback: true, tried };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const url = new URL(req.url);

  if (url.searchParams.has("check")) {
    const report = await Promise.all(Object.keys(FEEDS).map(async (area) => {
      const r = await forArea(area);
      return { area, ok: !r.fallback && r.items.length > 0, using: r.fallback ? "england (fallback)" : r.path, headlines: r.items.length, tried: r.tried };
    }));
    const broken = report.filter((r) => !r.ok).map((r) => r.area);
    return json({ checked: report.length, working: report.length - broken.length, broken, report }, 200, "no-store");
  }

  const area = (url.searchParams.get("area") || "uk").toLowerCase();
  if (!FEEDS[area]) return json({ error: "Unknown area" }, 400, "no-store");
  try {
    const r = await forArea(area);
    if (!r.items.length) return json({ error: "No headlines from BBC News right now" }, 502, "no-store");
    return json({ area, source: r.source, fallback: r.fallback, items: r.items });
  } catch (_e) {
    return json({ error: "Couldn't reach BBC News" }, 502, "no-store");
  }
});
