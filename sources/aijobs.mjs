// ai-jobs.net — 100% AI/ML-dedicated board, RSS no auth, full description included.
// Note: RSS feed may return 404; kept as reference in case it comes back.
// Usage: node --env-file=.env sources/aijobs.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const strip = (h = "") => h
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function parseRSS(xml) {
  const items = [];
  for (const block of xml.split("<item>").slice(1)) {
    const pick = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>|<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
      return m ? (m[1] || m[2] || "").trim() : "";
    };
    const link = pick("link") || pick("guid");
    const id = link.split("/").filter(Boolean).pop() || link;
    const title = pick("title");
    const company = pick("author") || pick("dc:creator") || "";
    const description = pick("description");
    const location = (description.match(/(?:location|remote|where)[:\s]+([^\n<.]+)/i) || [])[1] || "Remote";
    const posted = pick("pubDate");
    if (title && link) items.push({ id, title, company, location, link, description, posted });
  }
  return items;
}

const FEEDS = [
  "https://ai-jobs.net/feed/",
  "https://ai-jobs.net/feed/?job_type=remote",
];

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  let added = 0;
  for (const feed of FEEDS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      const r = await fetch(feed, { headers: { "User-Agent": UA }, signal: ctrl.signal });
      clearTimeout(t);
      if (!r.ok) { console.error(`[aijobs] HTTP ${r.status} for ${feed}`); continue; }
      const xml = await r.text();
      const items = parseRSS(xml);
      for (const item of items) {
        const job = {
          source: "aijobs", id: item.id, title: strip(item.title),
          company: strip(item.company), location: strip(item.location),
          url: item.link, raw_text: strip(item.description).slice(0, 4000),
          posted: item.posted,
        };
        if (isKnown(known, job)) continue;
        known.ids.add(job.id);
        await writeJob(job); added++;
      }
      process.stderr.write(`  [aijobs feed] ${items.length} items, +${added} new\n`);
    } catch (e) { console.error(`[aijobs] ${e.message}`); }
  }
  console.error(`ai-jobs.net: +${added} AI postings → Postgres`);
  await closePool();
};
main();
