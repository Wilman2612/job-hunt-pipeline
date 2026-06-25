// Parallel MULTI-SOURCE fetcher for remote postings (public APIs + browser buffer).
// Normalizes to a common schema, deduplicates against the store, filters by AI signals,
// and persists to index.jsonl + one file per posting (with raw_text). Does not reprocess known ones.
// Usage: node sources/fetch.mjs
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ensureDirs, loadKnown, isKnown, upsertIndex, writeJob, closePool, INCOMING } from "../lib/store.mjs";
import path from "node:path";

const UA = "Mozilla/5.0 (job-hunt-bot; contact you@example.com)";
const TIMEOUT = 25000;

const AI_KEYWORDS = [
  "ai engineer", "ai developer", "generative ai", "genai", " llm", "large language model",
  "agentic", " rag", "retrieval augmented", "multi-agent", "mcp", "model context protocol",
  "applied ai", "ml engineer", "machine learning engineer", "prompt eng",
  "langchain", "langgraph", "openai", "anthropic", "claude", "vector db", "embeddings",
  "ai agent", "conversational ai", "ai/ml"
];

function strip(html = "") {
  return html
    // 1) decodificar entidades de tags ANTES de quitarlos (si no, "&lt;p&gt;" deja "p")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    // 2) quitar tags reales
    .replace(/<[^>]+>/g, " ")
    // 3) limpiar entidades restantes y espacios
    .replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

async function get(url, type = "json") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return type === "json" ? await r.json() : await r.text();
  } finally {
    clearTimeout(t);
  }
}

function norm({ source, id, title, company, location, url, description, salary, tags, posted }) {
  return {
    source,
    id: String(id),
    title: (title || "").trim(),
    company: (company || "").trim(),
    location: (location || "").trim() || "Remote",
    url,
    description: strip(description || "").slice(0, 4000),
    salary: salary || null,
    tags: (tags || []).map((s) => String(s).toLowerCase()),
    posted: posted || null,
  };
}

// --- Sources ---

async function remotive() {
  const out = [];
  for (const q of ["ai engineer", "machine learning", "llm", "generative ai", "ml engineer", "data engineer", "python", "nlp", "deep learning", "ai developer"]) {
    try {
      const d = await get(`https://remotive.com/api/remote-jobs?search=${encodeURIComponent(q)}&limit=80`);
      for (const j of d.jobs || []) {
        out.push(norm({
          source: "remotive", id: j.id, title: j.title, company: j.company_name,
          location: j.candidate_required_location, url: j.url, description: j.description,
          salary: j.salary, tags: j.tags, posted: j.publication_date,
        }));
      }
    } catch (e) { console.error(`[remotive ${q}] ${e.message}`); }
  }
  return out;
}

async function remoteok() {
  try {
    const d = await get("https://remoteok.com/api");
    return (Array.isArray(d) ? d : []).filter((j) => j.id).map((j) =>
      norm({
        source: "remoteok", id: j.id, title: j.position, company: j.company,
        location: j.location, url: j.url, description: j.description,
        salary: j.salary_min ? `$${j.salary_min}-${j.salary_max}` : null,
        tags: j.tags, posted: j.date,
      }));
  } catch (e) { console.error(`[remoteok] ${e.message}`); return []; }
}

async function arbeitnow() {
  try {
    const d = await get("https://www.arbeitnow.com/api/job-board-api");
    return (d.data || []).map((j) =>
      norm({
        source: "arbeitnow", id: j.slug, title: j.title, company: j.company_name,
        location: j.location + (j.remote ? " (remote)" : ""), url: j.url,
        description: j.description, tags: j.tags, posted: j.created_at,
      }));
  } catch (e) { console.error(`[arbeitnow] ${e.message}`); return []; }
}

async function wwr() {
  // WeWorkRemotely RSS (programming)
  try {
    const xml = await get("https://weworkremotely.com/categories/remote-programming-jobs.rss", "text");
    const items = xml.split("<item>").slice(1);
    return items.map((blk) => {
      const pick = (tag) => (blk.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`)) || [, ""])[1]
        .replace("<![CDATA[", "").replace("]]>", "").trim();
      const title = pick("title"); // "Company: Role"
      const [co, ...rest] = title.split(":");
      return norm({
        source: "weworkremotely", id: pick("guid") || pick("link"),
        title: rest.join(":").trim() || title, company: co.trim(),
        location: pick("region") || "Remote", url: pick("link"),
        description: pick("description"), posted: pick("pubDate"),
      });
    });
  } catch (e) { console.error(`[wwr] ${e.message}`); return []; }
}

async function himalayas() {
  const out = [];
  for (let offset = 0; offset <= 400; offset += 100) {
    try {
      const d = await get(`https://himalayas.app/jobs/api?limit=100&offset=${offset}`);
      for (const j of d.jobs || []) out.push(norm({
        source: "himalayas", id: j.guid || j.applicationLink, title: j.title, company: j.companyName,
        location: (j.locationRestrictions || []).join(", ") || "Remote", url: j.applicationLink,
        description: j.description || j.excerpt,
        salary: j.minSalary ? `${j.minSalary}-${j.maxSalary} ${j.currency || ""}` : null,
        tags: j.categories, posted: j.pubDate ? new Date(j.pubDate * 1000).toISOString() : null,
      }));
      if (!(d.jobs || []).length) break;
    } catch (e) { console.error(`[himalayas off${offset}] ${e.message}`); break; }
  }
  return out;
}

async function workingnomads() {
  try {
    const d = await get("https://www.workingnomads.com/api/exposed_jobs/");
    return (Array.isArray(d) ? d : []).map((j) => norm({
      source: "workingnomads", id: j.url, title: j.title, company: j.company_name,
      location: j.location || "Remote", url: j.url, description: j.description,
      tags: (j.tags || "").split(","), posted: j.pub_date,
    }));
  } catch (e) { console.error(`[workingnomads] ${e.message}`); return []; }
}

async function jobicy() {
  const out = [];
  for (const tag of ["engineering", "data-science"]) {
    try {
      const d = await get(`https://jobicy.com/api/v2/remote-jobs?count=50&tag=${tag}`);
      for (const j of d.jobs || []) out.push(norm({
        source: "jobicy", id: j.id, title: j.jobTitle, company: j.companyName,
        location: j.jobGeo || "Remote", url: j.url, description: j.jobDescription || j.jobExcerpt,
        salary: j.salaryMin ? `${j.salaryMin}-${j.salaryMax} ${j.salaryCurrency || ""}` : null,
        tags: [j.jobIndustry, j.jobLevel].filter(Boolean), posted: j.pubDate,
      }));
    } catch (e) { console.error(`[jobicy ${tag}] ${e.message}`); }
  }
  return out;
}

async function torre() {
  // Torre.ai — LATAM-friendly, public API (POST), returns real salary and skills.
  const out = [];
  for (const q of ["AI engineer", "machine learning engineer", "LLM engineer", "generative AI"]) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT);
      const r = await fetch("https://search.torre.co/opportunities/_search/?size=60", {
        method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, signal: ctrl.signal,
        body: JSON.stringify({ and: [{ "skill/role": { text: q, experience: "potential-to-develop" } }] }),
      });
      clearTimeout(t);
      const d = await r.json();
      for (const o of d.results || []) {
        if (o.status && o.status !== "open") continue;
        const c = o.compensation?.data;
        const sal = c ? `${c.minAmount || ""}-${c.maxAmount || ""} ${c.currency || ""}/${c.periodicity || ""}` : null;
        const skills = (o.skills || []).map((s) => s.name || s).filter(Boolean);
        out.push(norm({
          source: "torre", id: o.id, title: o.objective,
          company: o.organizations?.[0]?.name || "(confidential)",
          location: (o.locations || []).join(", ") || (o.remote ? "Remote" : ""),
          url: `https://torre.ai/post/${o.id}`,
          description: `${o.tagline || ""}. Skills: ${skills.join(", ")}`,
          salary: sal, tags: skills, posted: o.created,
        }));
      }
    } catch (e) { console.error(`[torre ${q}] ${e.message}`); }
  }
  return out;
}

function isAI(j) {
  const hay = (j.title + " " + j.description + " " + j.tags.join(" ")).toLowerCase();
  return AI_KEYWORDS.some((k) => hay.includes(k));
}

const main = async () => {
  console.error("Fetching in parallel...");
  const results = await Promise.allSettled([remotive(), remoteok(), arbeitnow(), wwr(), himalayas(), workingnomads(), jobicy(), torre()]);
  let all = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));

  // Browser buffer (linkedin-jobs skill or other header-detail sources).
  const buf = path.join(INCOMING, "linkedin.json");
  if (existsSync(buf)) {
    try {
      const cards = JSON.parse(await readFile(buf, "utf8"));
      for (const c of cards) {
        all.push(norm({
          source: c.source || "linkedin", id: c.id, title: c.t || c.title,
          company: c.co || c.company, location: c.loc || c.location, url: c.url,
          description: c.raw_text || c.description || "", tags: [],
        }));
      }
      console.error(`Browser buffer: +${cards.length} (${buf})`);
    } catch (e) { console.error(`[buffer] ${e.message}`); }
  }
  console.error(`Total raw: ${all.length}`);

  // dedupe by url within this run
  const seenUrl = new Set();
  all = all.filter((j) => j.url && !seenUrl.has(j.url) && seenUrl.add(j.url));

  // AI only (browser ones are already pre-filtered by the search → always keep).
  const preFiltered = new Set(["linkedin", "torre"]); // already searched by AI role at the source
  const ai = all.filter((j) => preFiltered.has(j.source) || isAI(j));

  // Dedup against already known (index + excluded) → don't re-spend resources.
  await ensureDirs();
  const known = await loadKnown();
  let added = 0, skipped = 0;
  const bySource = {};
  for (const j of ai) {
    if (isKnown(known, j)) { skipped++; continue; }
    known.ids.add(String(j.id));
    const job = { ...j, raw_text: j.description || "", fetched_at: new Date().toISOString() };
    delete job.description;
    await upsertIndex(job);            // lightweight (no raw_text)
    if (job.raw_text) await writeJob(job); // full (with raw_text) if description is available
    bySource[j.source] = (bySource[j.source] || 0) + 1;
    added++;
  }
  console.error(`Added: ${added} | already known (skipped): ${skipped}`);
  console.error("Por fuente:", JSON.stringify(bySource));
  console.error("-> Postgres (jobs table)");
  await closePool();
};

main();
