// Direct ATS (Greenhouse / Ashby / Lever) — public JSON APIs with no auth, full description.
// Curated list of AI / remote-first companies. Each board is another source → parallelizable, no wall.
// Usage: node --env-file=.env sources/ats.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (job-hunt-bot; you@example.com)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (h = "") => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

const AI = ["ai", "ml", "machine learning", "llm", "genai", "generative", "agent", "rag", "nlp",
  "deep learning", "applied scientist", "research engineer", "data", "backend", "full stack", "software engineer", "infrastructure", "mlops"];
const isRelevant = (t, d) => { const h = (t + " " + d).toLowerCase(); return AI.some((k) => h.includes(k)); };

// Known AI / remote-first companies by platform (non-existent ones return 404 → skipped).
const GREENHOUSE = ["databricks", "anthropic", "scaleai", "cohere", "huggingface", "runwayml", "wandb",
  "character", "glean", "adept", "togethercomputer", "modal", "harvey", "sierra", "abridge", "hippocraticai",
  "tome", "imbue", "contextual", "writer", "assemblyai", "deepgram", "weaviate", "pinecone", "neo4j",
  "stripe", "gitlab", "cloudflare", "datadog", "hashicorp", "elastic", "mongodb", "confluent", "doordash",
  "instacart", "robinhood", "coinbase", "brex", "plaid", "retool", "discord", "reddit", "dropbox", "asana",
  "gusto", "samsara", "affirm", "chime", "faire", "unity", "twitch", "gretel", "arize", "verkada",
  "rippling", "airtable", "notion", "grammarly", "openstore", "ironclad", "vannaai", "tecton", "labelbox",
  "snorkelai", "primer", "moveworks", "cresta", "observe", "temporal", "render", "fivetran", "dbtlabs",
  "montecarlo", "hex", "census", "amplitude", "mixpanel", "webflow", "loom", "miro", "calendly", "deel",
  // nuevas empresas AI 2025-2026
  "mistralai", "xai", "inflectionai", "01ai", "zhipuai", "moonshot", "stepfun",
  "stability", "midjourney", "ideogram", "blackforestlabs", "hedra", "lumalabs",
  "nvidia", "amd", "intel", "qualcomm", "arm",
  "palantir", "c3ai", "datarobot", "domino", "h2oai", "altair",
  "huggingface", "replicate", "banana", "coreweave", "hyperstack", "fluidstack",
  "turing", "toptal", "andela", "crossover",
  "twilio", "sendgrid", "segment", "klaviyo", "iterable", "braze",
  "figma", "canva", "framer", "relume",
  "linear", "height", "shortcut", "plane",
  "neon", "planetscale", "turso", "xata",
  "resend", "loops", "customerio"];
const ASHBY = ["openai", "perplexityai", "ramp", "linear", "mistral", "elevenlabs", "anysphere", "notion",
  "vercel", "supabase", "replit", "langchain", "writer", "crusoeenergy", "baseten", "fal", "lovable",
  "browserbase", "mintlify", "hex", "decagon", "sierra", "gamma", "raycast", "clay", "dust", "mercor",
  "cognition", "suno", "pika", "runwayml", "together", "modal", "weights", "scale", "harvey", "glean",
  "abridge", "openpipe", "exa", "tavily", "llamaindex", "crewai", "humanloop", "langfuse", "helicone",
  "vapi", "retellai", "sieve", "outset", "patronus", "freed", "tennr", "11x", "cursor", "windsurf",
  "magic", "poolside", "sierraai", "hebbia", "rogo", "definite", "hyperbound", "fireworks", "lambdalabs",
  // nuevas 2025-2026
  "groq", "together", "deepinfra", "novita", "lepton", "infermatic",
  "comet", "braintrust", "arize", "traceloop", "honeyhive", "promptlayer",
  "fixie", "letta", "e2b", "daytona", "devzero",
  "reducto", "unstructured", "chunkr", "ragie",
  "mem0", "zep", "cognee", "graphlit",
  "liveblocks", "partykit", "convex", "jazz",
  "trigger", "inngest", "temporal", "windmill",
  "apify", "brightdata", "oxylabs", "scrapingbee",
  "prompt", "credal", "glean", "guru", "notion"];
const LEVER = ["voiceflow", "cresta", "you", "deepl", "huggingface", "anrok", "metabase", "instabase",
  "verbit", "kaeya", "writer", "moveworks", "twelvelabs", "hippocratic", "perceptyx", "shieldai",
  // nuevas
  "cohere", "ai21", "alephalpha", "nomic", "voyage", "jina",
  "haystack", "weaviate", "qdrant", "milvus", "vespa",
  "clarifai", "roboflow", "landing", "scale", "appen", "defined"];

async function get(url, json = true) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) return null;
    return json ? await r.json() : await r.text();
  } catch { return null; } finally { clearTimeout(t); }
}

async function greenhouse(slug) {
  const d = await get(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
  if (!d?.jobs) return [];
  return d.jobs.map((j) => ({
    source: "greenhouse", id: `${slug}-${j.id}`, title: j.title, company: slug,
    location: j.location?.name || "", url: j.absolute_url, raw_text: strip(j.content || ""),
    posted: j.updated_at,
  }));
}
async function ashby(slug) {
  const d = await get(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`);
  if (!d?.jobs) return [];
  return d.jobs.map((j) => ({
    source: "ashby", id: `${slug}-${j.id}`, title: j.title, company: slug,
    location: (j.isRemote ? "Remote " : "") + (j.location || ""), url: j.jobUrl || j.applyUrl,
    raw_text: strip(j.descriptionHtml || j.descriptionPlain || ""),
    salary: j.compensation?.compensationTierSummary || null,
  }));
}
async function lever(slug) {
  const d = await get(`https://api.lever.co/v0/postings/${slug}?mode=json`);
  if (!Array.isArray(d)) return [];
  return d.map((j) => ({
    source: "lever", id: `${slug}-${j.id}`, title: j.text, company: slug,
    location: j.categories?.location || "", url: j.hostedUrl,
    raw_text: strip(j.descriptionPlain || j.description || ""),
  }));
}

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  let added = 0, boards = 0;
  const run = async (fn, slugs, label) => {
    for (const s of slugs) {
      const jobs = await fn(s);
      if (jobs.length) boards++;
      let n = 0;
      for (const j of jobs) {
        if (!j.title || !isRelevant(j.title, j.raw_text)) continue;
        if (isKnown(known, j)) continue;
        known.ids.add(String(j.id));
        await writeJob(j); added++; n++;
      }
      if (jobs.length) process.stderr.write(`  [${label}/${s}] ${jobs.length} jobs, +${n} new AI\n`);
      await sleep(300);
    }
  };
  await run(greenhouse, GREENHOUSE, "GH");
  await run(ashby, ASHBY, "ashby");
  await run(lever, LEVER, "lever");
  console.error(`ATS: ${boards} active boards, +${added} new AI postings → Postgres`);
  await closePool();
};
main();
