// Semantic matching: embeds the candidate's profile and each posting (text-embedding-3-small),
// stores the vector in pgvector and computes cosine similarity (0-1) -> jobs.semantic column.
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

// 1) Profile -> vector (distilled text from target.json)
const profile = JSON.parse(await readFile(path.join(ROOT, "profile/target.json"), "utf8"));
const profileText = [
  profile.target_roles.join(", "),
  (profile.core_keywords || []).join(", "),
  (profile.strong_stack_match || []).join(", "),
  (profile.differentiators || []).join(". "),
].join("\n");
const [profileVec] = await embed([profileText]);

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

// 3) Cosine similarity against the profile -> jobs.semantic (0-1)
await q(
  "UPDATE jobs SET semantic = 1 - (embedding <=> $1::vector) WHERE embedding IS NOT NULL",
  [vlit(profileVec)]
);

const { rows: top } = await q(
  "SELECT title, company, round(semantic::numeric,3) AS sim FROM jobs WHERE semantic IS NOT NULL ORDER BY semantic DESC LIMIT 10"
);
console.error("\nTOP by semantic similarity to profile:");
for (const t of top) console.error(`  ${t.sim}  ${t.title} @ ${t.company}`);
await closePool();
