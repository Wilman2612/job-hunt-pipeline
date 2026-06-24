// Torre.ai — 36k+ oportunidades, LATAM-friendly. API pública POST (sin auth).
// Varias queries AI × size grande → dedup → guarda con raw_text (objective+tagline+skills+comp).
// Torre es board remote-first (elegibilidad laxa). Uso: node --env-file=.env sources/torre.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const QUERIES = [
  "AI engineer", "machine learning engineer", "LLM engineer", "generative AI", "AI agent",
  "applied AI", "MLOps engineer", "NLP engineer", "deep learning engineer", "AI developer",
  "data engineer", "backend engineer python", "computer vision engineer",
];

async function search(text, size = 20, attempt = 1) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(`https://search.torre.co/opportunities/_search/?size=${size}`, {
      method: "POST", headers: { "Content-Type": "application/json", "User-Agent": UA }, signal: ctrl.signal,
      body: JSON.stringify({ and: [{ "skill/role": { text, experience: "potential-to-develop" } }] }),
    });
    clearTimeout(t);
    if (r.status === 429 || r.status === 400) { // rate-limited → backoff y reintenta
      if (attempt <= 3) { const w = 30000 * attempt; console.error(`[torre ${text}] ${r.status} → espera ${w / 1000}s`); await sleep(w); return search(text, size, attempt + 1); }
      throw new Error(`HTTP ${r.status} tras reintentos`);
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()).results || [];
  } catch (e) { console.error(`[torre ${text}] ${e.message}`); return []; }
}

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  const seen = new Set();
  let added = 0;
  for (const q of QUERIES) {
    const results = await search(q);
    let newInQ = 0;
    for (const o of results) {
      if (o.status && o.status !== "open") continue;
      if (seen.has(o.id)) continue; seen.add(o.id);
      const c = o.compensation?.data;
      const sal = c ? `${c.minAmount || ""}-${c.maxAmount || ""} ${c.currency || ""}/${c.periodicity || ""}` : null;
      const skills = (o.skills || []).map((s) => s.name || s).filter(Boolean);
      const job = {
        source: "torre", id: String(o.id),
        title: o.objective || "(sin título)",
        company: o.organizations?.[0]?.name || "(confidencial)",
        location: (o.locations || []).join(", ") || (o.remote ? "Remote" : ""),
        url: `https://torre.ai/post/${o.id}`,
        raw_text: `${o.objective || ""}. ${o.tagline || ""}. Skills: ${skills.join(", ")}.${o.remote ? " Remote." : ""}`,
        salary: sal, posted: o.created, easyApply: !!o.quickApply,
      };
      if (isKnown(known, job)) continue;
      known.ids.add(job.id);
      await writeJob(job);
      added++; newInQ++;
    }
    process.stderr.write(`  [${q}] ${results.length} resultados, +${newInQ} nuevas (total +${added})\n`);
    await sleep(10000); // lento a propósito para no rate-limitear (no hay prisa)
  }
  console.error(`Torre: +${added} ofertas nuevas → Postgres`);
  await closePool();
};
main();
