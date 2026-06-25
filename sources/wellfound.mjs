// Wellfound (ex-AngelList) — largest startup board, many AI/remote roles.
// Uses the public search endpoint (no auth) exposed for SEO.
// Note: jobs load client-side via GraphQL; __NEXT_DATA__ returns 0 results. Kept as reference.
// Usage: node --env-file=.env sources/wellfound.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);
const strip = (h = "") => h
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const ROLE_TYPES = [
  "Software Engineer", "Machine Learning", "Artificial Intelligence",
  "Data Science", "Backend Engineer", "Full Stack Engineer",
];

async function searchWellfound(roleType, page = 1) {
  const url = `https://wellfound.com/role/l/${encodeURIComponent(roleType.toLowerCase().replace(/ /g, "-"))}/remote?page=${page}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const html = await r.text();

    // Extract data from the embedded __NEXT_DATA__ JSON
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return [];
    const data = JSON.parse(m[1]);

    // Walk the props tree to find job listings
    const jobs = [];
    const walkProps = (obj) => {
      if (!obj || typeof obj !== "object") return;
      if (Array.isArray(obj)) { obj.forEach(walkProps); return; }
      // Detect job listing
      if (obj.jobListingId && obj.title) {
        jobs.push({
          id: String(obj.jobListingId),
          title: obj.title || "",
          company: obj.startupName || obj.startup?.name || "",
          location: obj.locationNames?.join(", ") || (obj.remote ? "Remote" : ""),
          url: obj.jobListingPath ? `https://wellfound.com${obj.jobListingPath}` : "",
          description: obj.description || obj.descriptionSnippet || "",
          salary: obj.compensation || (obj.salary ? `${obj.salary}` : null),
          posted: obj.createdAt || null,
        });
      }
      Object.values(obj).forEach(walkProps);
    };
    walkProps(data);
    return jobs;
  } catch (e) {
    console.error(`[wellfound ${roleType} p${page}] ${e.message}`);
    return [];
  }
}

const AI_KW = ["ai", "ml", "machine learning", "llm", "generative", "genai", "agent", "rag",
  "nlp", "deep learning", "applied scientist", "research engineer", "langchain", "openai", "anthropic"];
const isRelevant = (title, desc) => {
  const h = (title + " " + desc).toLowerCase();
  return AI_KW.some((k) => h.includes(k));
};

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  let added = 0;
  for (const role of ROLE_TYPES) {
    for (let page = 1; page <= 3; page++) {
      const jobs = await searchWellfound(role, page);
      for (const j of jobs) {
        if (!j.title || !isRelevant(j.title, j.description)) continue;
        const job = {
          source: "wellfound", id: j.id, title: strip(j.title),
          company: strip(j.company), location: strip(j.location) || "Remote",
          url: j.url, raw_text: strip(j.description).slice(0, 4000),
          salary: j.salary || null, posted: j.posted,
        };
        if (isKnown(known, job)) continue;
        known.ids.add(job.id);
        await writeJob(job); added++;
      }
      if (jobs.length) process.stderr.write(`  [wellfound ${role} p${page}] ${jobs.length} listings, +${added} AI total\n`);
      await sleep(jitter(600, 1200));
    }
  }
  console.error(`Wellfound: +${added} AI postings → Postgres`);
  await closePool();
};
main();
