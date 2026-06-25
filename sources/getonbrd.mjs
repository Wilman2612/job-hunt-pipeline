// Get on Board (getonbrd.com) — LATAM job board, public API. Remote-first board (lax eligibility).
// Usage: node --env-file=.env sources/getonbrd.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";
const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const strip = (h = "") => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  let added = 0;
  for (const qy of ["AI", "machine learning", "LLM", "generative AI", "data engineer"]) {
    for (let page = 1; page <= 2; page++) {
      try {
        const r = await fetch(`https://www.getonbrd.com/api/v0/search/jobs?query=${encodeURIComponent(qy)}&per_page=50&page=${page}&include=company`, { headers: { "User-Agent": UA } });
        if (!r.ok) { console.error(`[gob ${qy} p${page}] HTTP ${r.status}`); continue; }
        const d = await r.json();
        const cos = {}; for (const inc of (d.included || [])) if (inc.type === "company") cos[inc.id] = inc.attributes?.name;
        for (const j of d.data || []) {
          const a = j.attributes || {};
          const slug = (j.links?.public_url || "").split("/jobs/")[1] || j.id;
          const job = {
            source: "getonbrd", id: String(slug), title: a.title, company: cos[a.company?.data?.id] || "(Get on Board)",
            location: [a.remote_modality, a.remote_zone, (a.countries || []).join("/")].filter(Boolean).join(" · ") || "Remote",
            url: j.links?.public_url || `https://www.getonbrd.com/jobs/${slug}`,
            raw_text: strip(`${a.description || ""} ${a.functions || ""} ${a.desirable || ""}`),
            salary: a.min_salary ? `${a.min_salary}-${a.max_salary} USD` : null, posted: a.published_at,
          };
          if (!job.title || isKnown(known, job)) continue;
          known.ids.add(job.id); await writeJob(job); added++;
        }
        process.stderr.write(`  [${qy} p${page}] +${(d.data || []).length}\n`);
      } catch (e) { console.error(`[gob ${qy} p${page}] ${e.message}`); }
      await sleep(700);
    }
  }
  console.error(`Get on Board: +${added} new → Postgres`);
  await closePool();
};
main();
