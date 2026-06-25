// Remote.co — RSS feeds by category, good quality, free.
// Note: feeds may time out (>20s); kept as reference.
// Usage: node --env-file=.env sources/remoteco.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    const title = pick("title");
    if (!title || !link) continue;
    items.push({
      id: link.replace(/[^a-z0-9]/gi, "_").slice(-60),
      title, company: pick("author") || pick("dc:creator") || "",
      url: link, description: pick("description"), posted: pick("pubDate"),
    });
  }
  return items;
}

// RSS feeds for tech categories on Remote.co
const FEEDS = [
  "https://remote.co/remote-jobs/software-dev/rss/",
  "https://remote.co/remote-jobs/computer-it/rss/",
  "https://remote.co/remote-jobs/data-science/rss/",
  "https://remote.co/remote-jobs/engineering/rss/",
];

const AI_KW = ["ai", "ml", "machine learning", "llm", "generative", "engineer", "developer",
  "python", "data", "backend", "full stack", "software", "cloud", "platform"];
const isRelevant = (title, desc) => AI_KW.some((k) => (title + " " + desc).toLowerCase().includes(k));

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
      if (!r.ok) { console.error(`[remoteco] HTTP ${r.status}: ${feed}`); continue; }
      const items = parseRSS(await r.text());
      let n = 0;
      for (const item of items) {
        const raw = strip(item.description);
        if (!isRelevant(item.title, raw)) continue;
        const job = {
          source: "remoteco", id: item.id, title: strip(item.title),
          company: strip(item.company), location: "Remote",
          url: item.url, raw_text: raw.slice(0, 4000), posted: item.posted,
        };
        if (isKnown(known, job)) continue;
        known.ids.add(job.id);
        await writeJob(job); added++; n++;
      }
      process.stderr.write(`  [remoteco] ${items.length} items → +${n} new (feed: ${feed.split("/")[4]})\n`);
    } catch (e) { console.error(`[remoteco] ${e.message}`); }
    await sleep(300);
  }
  console.error(`Remote.co: +${added} postings → Postgres`);
  await closePool();
};
main();
