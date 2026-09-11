// Supabase Edge Function "news" for Life - Student Edition (v2.3)
// Reads a BBC News RSS feed and returns the headlines as JSON, so the app can show them.
// Browsers can't read BBC feeds directly, which is why this small function is needed.
// No keys or secrets. Only the BBC areas listed below can be requested.
//
// Call it as:  https://<project>.supabase.co/functions/v1/news?area=berkshire   (or ?area=uk)

const ENGLAND = [
  "beds_bucks_and_herts", "berkshire", "birmingham_and_black_country", "bristol", "cambridgeshire",
  "cornwall", "coventry_and_warwickshire", "cumbria", "derby", "devon", "dorset", "essex",
  "gloucestershire", "hampshire", "hereford_and_worcester", "humberside", "kent", "lancashire",
  "leeds_and_west_yorkshire", "leicester", "lincolnshire", "london", "manchester", "merseyside",
  "norfolk", "northamptonshire", "nottingham", "oxford", "shropshire", "somerset", "south_yorkshire",
  "stoke_and_staffordshire", "suffolk", "surrey", "sussex", "tees", "tyne_and_wear", "wiltshire",
  "york_and_north_yorkshire",
];
const NATIONS = ["uk", "scotland", "wales", "northern_ireland"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function feedPath(area: string): string | null {
  if (NATIONS.includes(area)) return area;
  if (ENGLAND.includes(area)) return `england/${area}`;
  return null;
}

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const area = (new URL(req.url).searchParams.get("area") || "uk").toLowerCase();
  const path = feedPath(area);
  if (!path) return json({ error: "Unknown area" }, 400, "no-store");

  try {
    const r = await fetch(`https://feeds.bbci.co.uk/news/${path}/rss.xml`, {
      headers: { "User-Agent": "Life-Student-Edition/2.3 (+https://www.dpaul-software.uk)" },
    });
    if (!r.ok) return json({ error: `BBC feed returned ${r.status}` }, 502, "no-store");
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 20).map((m) => ({
      title: tag(m[1], "title"),
      link: tag(m[1], "link"),
      date: tag(m[1], "pubDate"),
    })).filter((it) => it.title && it.link);
    return json({ area, source: tag(xml.split("<item>")[0], "title"), items });
  } catch (_e) {
    return json({ error: "Couldn't reach BBC News" }, 502, "no-store");
  }
});
