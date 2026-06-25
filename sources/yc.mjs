// Y Combinator Work at a Startup — public JSON API, YC AI startups, no auth.
// Note: api.workatastartup.com now requires auth; kept as reference.
// Usage: node --env-file=.env sources/yc.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AI_KW = ["ai", "ml", "machine learning", "llm", "generative", "genai", "agent", "rag",
  "nlp", "deep learning", "applied scientist", "research engineer", "langchain", "openai",
  "anthropic", "data scientist", "data engineer", "python", "backend", "full stack", "software engineer"];
const isRelevant = (title, desc) => {
  const h = (title + " " + desc).toLowerCase();
  return AI_KW.some((k) => h.includes(k));
};

const strip = (h = "") => h.replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\s+/g, " ").trim();

const QUERIES = ["ai engineer", "machine learning", "llm", "generative ai", "software engineer"];

async function fetchYC(query, page) {
  const url = `https://api.workatastartup.com/companies?batch=&industry=&query=${encodeURIComponent(query)}&role=engineer&remote=true&cofounder=false&sort=joined&limit=20&page=${page}`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "application/json" },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const d = await r.json();
    const companies = d.companies || [];
    const jobs = [];
    for (const co of companies) {
      for (const job of co.jobs || []) {
        jobs.push({
          id: String(job.id),
          title: job.title || "",
          company: co.name || "",
          location: job.remote ? "Remote" : (job.locationData?.map((l) => l.text).join(", ") || ""),
          url: job.url || `https://www.workatastartup.com/jobs/${job.id}`,
          description: strip((job.description || "") + " " + (co.long_description || "")),
          salary: job.salary_range || null,
          posted: job.created_at || null,
        });
      }
    }
    return jobs;
  } catch (e) { console.error(`[yc ${query} p${page}] ${e.message}`); return []; }
}

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  let added = 0;
  for (const q of QUERIES) {
    for (let page = 0; page <= 4; page++) {
      const jobs = await fetchYC(q, page);
      if (!jobs.length) break;
      for (const j of jobs) {
        if (!isRelevant(j.title, j.description)) continue;
        const job = {
          source: "yc", id: j.id, title: j.title, company: j.company,
          location: j.location || "Remote", url: j.url,
          raw_text: j.description.slice(0, 4000), salary: j.salary, posted: j.posted,
        };
        if (isKnown(known, job)) continue;
        known.ids.add(job.id);
        await writeJob(job); added++;
      }
      process.stderr.write(`  [yc ${q} p${page}] ${jobs.length} jobs, total added: ${added}\n`);
      await sleep(400);
    }
  }
  console.error(`YC Work at a Startup: +${added} postings → Postgres`);
  await closePool();
};
main();
