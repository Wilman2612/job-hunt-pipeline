// Hacker News "Who is hiring?" (thread mensual) vía Algolia. Cada comentario top-level = una oferta.
// Filtra por señales AI. Mixto remoto/onsite/US → la elegibilidad/análisis decide geo después.
// Uso: node --env-file=.env sources/hn.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";
const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const strip = (h = "") => h.replace(/<p>/g, "\n").replace(/&#x2F;/g, "/").replace(/&#x27;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const AI = ["ai engineer", "ml engineer", "machine learning", " llm", "generative", "genai", "rag", "agent", "nlp", "applied ai", "ai/ml", "langchain", "deep learning", "ai-"];

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  const s = await (await fetch('https://hn.algolia.com/api/v1/search_by_date?query=%22Ask%20HN%3A%20Who%20is%20hiring%3F%22&tags=story&hitsPerPage=1', { headers: { "User-Agent": UA } })).json();
  const storyId = s.hits[0].objectID;
  console.error(`Thread: ${s.hits[0].title} (${storyId})`);
  const item = await (await fetch(`https://hn.algolia.com/api/v1/items/${storyId}`, { headers: { "User-Agent": UA } })).json();
  let added = 0, scanned = 0;
  for (const c of item.children || []) {
    if (!c.text) continue; scanned++;
    const text = strip(c.text);
    if (!AI.some(k => text.toLowerCase().includes(k))) continue;
    const firstLine = text.split(/[\n|]/)[0].trim();
    const job = {
      source: "hn", id: String(c.id),
      title: firstLine.slice(0, 90) || "HN hiring post",
      company: (firstLine.split(/[|–-]/)[0] || "").trim().slice(0, 60) || "(HN)",
      location: /remote/i.test(text) ? "Remote (ver post)" : "ver post",
      url: `https://news.ycombinator.com/item?id=${c.id}`,
      raw_text: text.slice(0, 4000), posted: c.created_at,
    };
    if (isKnown(known, job)) continue;
    known.ids.add(job.id); await writeJob(job); added++;
  }
  console.error(`HN: ${scanned} comentarios, +${added} ofertas AI → Postgres`);
  await closePool();
};
main();
