// The Muse — public API, no auth, good tech/AI companies, full description included.
// Usage: node --env-file=.env sources/muse.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h = "") => h.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

const CATEGORIES = ["Software Engineer", "Data and Analytics", "IT", "Science and Research"];
const LEVELS = ["Senior Level", "Management", "Director"];

const AI_KW = ["ai", "ml", "machine learning", "llm", "generative", "genai", "agent", "rag",
  "nlp", "deep learning", "engineer", "data", "python", "langchain", "openai", "anthropic", "cloud"];
const isRelevant = (title, body) => {
  const h = (title + " " + body).toLowerCase();
  return AI_KW.some((k) => h.includes(k));
};

async function fetchPage(category, level, page) {
  const url = `https://www.themuse.com/api/public/jobs?category=${encodeURIComponent(category)}&level=${encodeURIComponent(level)}&page=${page}&descending=true`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return [];
    const d = await r.json();
    return d.results || [];
  } catch (e) { console.error(`[muse ${category}/${level} p${page}] ${e.message}`); return []; }
}

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  let added = 0;
  for (const cat of CATEGORIES) {
    for (const lvl of LEVELS) {
      for (let page = 0; page <= 4; page++) {
        const results = await fetchPage(cat, lvl, page);
        for (const j of results) {
          const locations = (j.locations || []).map((l) => l.name).join(", ") || "Remote";
          const body = strip((j.contents || "") + " " + (j.refs?.landing_page || ""));
          if (!isRelevant(j.name, body)) continue;
          const job = {
            source: "themuse", id: String(j.id), title: j.name,
            company: j.company?.name || "", location: locations,
            url: j.refs?.landing_page || `https://www.themuse.com/jobs/${j.id}`,
            raw_text: strip(j.contents || "").slice(0, 4000), posted: j.publication_date,
          };
          if (isKnown(known, job)) continue;
          known.ids.add(job.id);
          await writeJob(job); added++;
        }
        if (results.length === 0) break;
        await sleep(300);
      }
    }
  }
  console.error(`The Muse: +${added} relevant postings → Postgres`);
  await closePool();
};
main();
