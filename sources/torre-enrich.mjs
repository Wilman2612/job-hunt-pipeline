// Torre text enrichment: the search API (torre.mjs) only stores a ~340-char summary
// (objective + tagline + skills). The DETAIL API (suite/opportunities/{id}) returns the full
// description. We re-fetch it for torre postings with thin raw_text, rebuild raw_text, and reset
// embedding/semantic so embed.mjs re-embeds and score.mjs --rescore re-classifies geo on real text.
// Why it matters: thin text starves BOTH the embedding (role signal) AND geo detection
// (RX.usOnly can't see "US only" in a 340-char snippet) AND the LLM analysis. One fix, three wins.
// Usage: node --env-file=.env sources/torre-enrich.mjs [--max-len=800] [--conc=3] [--limit=N]
import { q, closePool } from "../lib/store.mjs";

const args = process.argv.slice(2);
const MAXLEN = Number(args.find((a) => a.startsWith("--max-len="))?.split("=")[1] || 800);
const CONC = Number(args.find((a) => a.startsWith("--conc="))?.split("=")[1] || 3);
const LIMIT = Number(args.find((a) => a.startsWith("--limit="))?.split("=")[1] || 99999);
const UA = "Mozilla/5.0 (job-hunt-bot; enrichment)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (s) => (s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

// Fetch the full opportunity detail; returns rebuilt raw_text or null (expired/404/error).
async function fetchDetail(id, attempt = 1) {
  try {
    const r = await fetch(`https://torre.ai/api/suite/opportunities/${id}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 404 || r.status === 410) return { gone: true };
    if (r.status === 429) {
      if (attempt <= 3) { await sleep(15000 * attempt); return fetchDetail(id, attempt + 1); }
      throw new Error("429 after retries");
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const o = await r.json();
    const skills = (o.strengths || []).map((s) => s.name || s).filter(Boolean);
    const details = (o.details || []).map((d) => (typeof d.content === "string" ? d.content : "")).join("\n");
    const text = [
      o.objective || "",
      o.tagline || "",
      skills.length ? `Skills: ${skills.join(", ")}.` : "",
      stripHtml(details),
    ].filter(Boolean).join(". ").trim();
    return { text };
  } catch (e) { return { error: e.message }; }
}

const { rows } = await q(
  `SELECT ext_id, length(raw_text) AS len FROM jobs
   WHERE source='torre' AND (raw_text IS NULL OR length(raw_text) < $1)
   ORDER BY len ASC LIMIT $2`,
  [MAXLEN, LIMIT]
);
console.error(`Torre postings to enrich (raw_text < ${MAXLEN} chars): ${rows.length}`);

let enriched = 0, gone = 0, failed = 0, tooThin = 0;
const queue = [...rows];
async function worker() {
  while (queue.length) {
    const job = queue.shift();
    const res = await fetchDetail(job.ext_id);
    if (res.gone) { gone++; continue; }
    if (res.error) { failed++; console.error(`  ✗ ${job.ext_id}: ${res.error}`); continue; }
    if (!res.text || res.text.length <= job.len) { tooThin++; continue; } // no improvement
    await q(
      `UPDATE jobs SET raw_text=$2, embedding=NULL, semantic=NULL WHERE source='torre' AND ext_id=$1`,
      [job.ext_id, res.text.slice(0, 12000)]
    );
    enriched++;
    if (enriched % 25 === 0) process.stderr.write(`  enriched ${enriched} (gone ${gone}, fail ${failed})\n`);
    await sleep(400);
  }
}
await Promise.all(Array.from({ length: CONC }, () => worker()));
console.error(`\nTorre enrichment: ${enriched} updated, ${gone} expired/404, ${tooThin} no-improvement, ${failed} failed.`);
console.error(enriched ? "Next: node --env-file=.env scoring/embed.mjs && node --env-file=.env scoring/score.mjs --rescore" : "Nothing updated.");
await closePool();
