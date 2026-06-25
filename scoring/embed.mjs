// Semantic matching, MULTI-QUERY gate. Instead of one profile vector, we embed several role-dialect
// "search" vectors from profile/facets.json (application, llm-systems, ai-product, genai, agentic-automation,
// + a skills and a negative facet). Each posting is embedded once (text-embedding-3-small); we store its
// cosine to every facet (jobs.facet_sims) and set the gate score jobs.semantic = mean of the TOP-2 POSITIVE
// facet similarities. Rationale: a single profile vector misses good roles written in a different AI "dialect"
// (LLM-systems vs application vs FDE); top-2-over-facets catches the best-matching dialect. Validated: ~20%
// fewer LLM calls at equal recall vs a single vector, robust across want thresholds. The skills/negative facets
// are stored for transparency but do NOT feed the gate score today.
// Without OPENAI_API_KEY: warns and exits without breaking the pipeline.
// Usage: node --env-file=.env scoring/embed.mjs
import { readFile } from "node:fs/promises";
import path from "node:path";
import { q, ROOT, closePool } from "../lib/store.mjs";

const KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.EMBED_MODEL || "text-embedding-3-small";

if (!KEY) {
  console.error("⚠️  No OPENAI_API_KEY (set it in .env). Semantic matching is pending; the rest of the pipeline works fine.");
  process.exit(0);
}

async function embed(texts) {
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });
  if (!r.ok) throw new Error(`OpenAI ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).data.map((d) => d.embedding);
}
const vlit = (arr) => `[${arr.join(",")}]`;

// 1) Facets -> query vectors (profile/facets.json). Positive facets drive the gate score.
const cfg = JSON.parse(await readFile(path.join(ROOT, "profile/facets.json"), "utf8"));
const facets = cfg.facets;
const positive = facets.filter((f) => f.role === "positive").map((f) => f.name);
console.error(`Facets: ${facets.map((f) => f.name).join(", ")} | positive (gate): ${positive.join(", ")}`);
const facetVecs = await embed(facets.map((f) => f.text));

// 2) Postings without embedding (with raw_text)
const { rows } = await q(
  "SELECT source, ext_id, title, raw_text FROM jobs WHERE embedding IS NULL AND raw_text IS NOT NULL AND length(raw_text) > 30"
);
console.error(`Postings to embed: ${rows.length}`);

const BATCH = 64;
for (let i = 0; i < rows.length; i += BATCH) {
  const slice = rows.slice(i, i + BATCH);
  const vecs = await embed(slice.map((r) => `${r.title}\n${r.raw_text}`.slice(0, 8000)));
  for (let k = 0; k < slice.length; k++) {
    await q("UPDATE jobs SET embedding=$3::vector WHERE source=$1 AND ext_id=$2",
      [slice[k].source, slice[k].ext_id, vlit(vecs[k])]);
  }
  console.error(`  embedded ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
}

// 3) Per-facet cosine similarity -> jobs.facet_sims (JSONB), for every embedded posting.
//    pgvector "<=>" is cosine distance; similarity = 1 - distance.
const simExprs = facets.map((f, idx) => `'${f.name}', round((1 - (embedding <=> $${idx + 1}::vector))::numeric, 4)`).join(", ");
await q(
  `UPDATE jobs SET facet_sims = jsonb_build_object(${simExprs}) WHERE embedding IS NOT NULL`,
  facetVecs.map(vlit)
);

// 4) Gate score: jobs.semantic = mean of the TOP-2 positive-facet similarities; best_facet = the argmax.
//    Done in SQL with a lateral over the positive facets only.
const posList = positive.map((n) => `'${n}'`).join(", ");
await q(
  `UPDATE jobs j SET
     semantic = sub.top2_mean,
     best_facet = sub.best
   FROM (
     SELECT pk,
            (SELECT avg(v) FROM (SELECT (value)::real v FROM jsonb_each_text(facet_sims)
                                  WHERE key IN (${posList}) ORDER BY v DESC LIMIT 2) t) AS top2_mean,
            (SELECT key FROM jsonb_each_text(facet_sims)
              WHERE key IN (${posList}) ORDER BY (value)::real DESC LIMIT 1) AS best
     FROM jobs WHERE facet_sims IS NOT NULL
   ) sub
   WHERE j.pk = sub.pk`
);

const { rows: top } = await q(
  "SELECT title, company, round(semantic::numeric,3) AS sim, best_facet FROM jobs WHERE semantic IS NOT NULL ORDER BY semantic DESC LIMIT 12"
);
console.error("\nTOP by multi-query gate score (best-matching facet):");
for (const t of top) console.error(`  ${t.sim}  [${t.best_facet}]  ${t.title} @ ${t.company}`);
await closePool();
