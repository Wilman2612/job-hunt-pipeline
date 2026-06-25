// MULTI-AGENT CV refinement: three roles with distinct objectives that iterate with feedback.
//   1) ATS screener  → scores parsing + keyword coverage vs the job description.
//   2) Recruiter      → 6-second scan: fit, impact, credibility, red flags.
//   3) Reviser        → rewrites addressing both critiques. GUARDRAIL: only uses facts from the
//                       knowledge base; reframes/emphasizes, NEVER fabricates.
// Loop until ATS and recruiter both pass the threshold or rounds are exhausted.
//
// NO RAG by design: the data (1 CV + 1 JD + 1 KB) fits in context; a vector store would be
// over-engineering for this volume. Direct calls to the Claude API → zero deps.
// (Standalone, but can also be orchestrated with Claude Code.)
//
// Usage:
//   node --env-file=.env cv/refine.mjs --jd=job.txt --kb=cv_base.md [--cv=draft.md] \
//        [--out=cv.final.md] [--rounds=3] [--threshold=80]
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { callText, hasKey, DEFAULT_MODEL, PROVIDER } from "../lib/llm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Model is swappable (lib/llm): CV_MODEL overrides; else the provider default.
const MODEL = process.env.CV_MODEL || DEFAULT_MODEL;
if (!hasKey()) { console.error(`Missing API key for LLM_PROVIDER=${PROVIDER} (set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env)`); process.exit(1); }

// Load agent system prompts from .claude/agents/ — single source of truth shared with Claude Code subagents.
// Strip YAML frontmatter (--- ... ---) and use the markdown body as the system prompt.
const stripFrontmatter = (md) => md.replace(/^---[\s\S]*?---\n?/, "").trim();
const agentDir = path.join(ROOT, ".claude", "agents");
const [ATS_SYS, RECRUITER_SYS, REVISER_SYS] = await Promise.all([
  readFile(path.join(agentDir, "cv-ats-screener.md"), "utf8").then(stripFrontmatter),
  readFile(path.join(agentDir, "cv-recruiter.md"),    "utf8").then(stripFrontmatter),
  readFile(path.join(agentDir, "cv-reviser.md"),      "utf8").then(stripFrontmatter),
]);

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const ROUNDS = Number(arg("rounds", 3));
const THRESHOLD = Number(arg("threshold", 80));
const OUT = arg("out", "cv.final.md");

// Provider-agnostic (lib/llm): swap model via CV_MODEL / LLM_PROVIDER without touching this file.
const claude = (system, user, maxTokens) => callText({ system, user, model: MODEL, maxTokens, temperature: 0.3 });
const parseJson = (t) => { const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); return JSON.parse(f ? f[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); };
const stripFences = (t) => { const f = t.match(/```(?:markdown|md)?\s*([\s\S]*?)```/); return (f ? f[1] : t).trim(); };

// ATS_SYS, RECRUITER_SYS, REVISER_SYS loaded above from .claude/agents/

const atsReview = (cv, jd) => claude(ATS_SYS, `JOB DESCRIPTION:\n${jd}\n\nCV:\n${cv}`, 700).then(parseJson);
const recruiterReview = (cv, jd) => claude(RECRUITER_SYS, `JOB DESCRIPTION:\n${jd}\n\nCV:\n${cv}`, 700).then(parseJson);

function revise(cv, jd, kb, ats, rec) {
  const crit = `ATS CRITIQUE (score ${ats.score}): missing keywords ${JSON.stringify(ats.missing_keywords)}; format risks ${JSON.stringify(ats.format_risks)}. ${ats.notes}
RECRUITER CRITIQUE (score ${rec.score}): weaknesses ${JSON.stringify(rec.weaknesses)}; red flags ${JSON.stringify(rec.red_flags)}. ${rec.verdict}`;
  return claude(REVISER_SYS, `KNOWLEDGE BASE (only permitted source of facts):\n${kb}\n\nJOB DESCRIPTION:\n${jd}\n\nCURRENT CV:\n${cv}\n\nCRITIQUES TO ADDRESS:\n${crit}`, 2500).then(stripFences);
}
const writeDraft = (jd, kb) =>
  claude(REVISER_SYS, `KNOWLEDGE BASE (only permitted source of facts):\n${kb}\n\nJOB DESCRIPTION:\n${jd}\n\nWrite an initial 1-2 page CV tailored to this role, using ONLY facts from the knowledge base.`, 2500).then(stripFences);

// --- Loop orchestration ---
const jdPath = arg("jd"), kbPath = arg("kb");
if (!jdPath || !kbPath) { console.error("Missing --jd=<job.txt> and --kb=<cv_base.md>"); process.exit(1); }
const jd = await readFile(jdPath, "utf8");
const kb = await readFile(kbPath, "utf8");
let cv = arg("cv") ? await readFile(arg("cv"), "utf8") : (console.error("No draft provided → generating initial CV…"), await writeDraft(jd, kb));

const trace = [];
for (let i = 1; i <= ROUNDS; i++) {
  const [ats, rec] = await Promise.all([atsReview(cv, jd), recruiterReview(cv, jd)]);
  trace.push({ round: i, ats: ats.score, recruiter: rec.score });
  console.error(`Round ${i}:  ATS ${ats.score}  |  Recruiter ${rec.score}`);
  if (ats.score >= THRESHOLD && rec.score >= THRESHOLD) { console.error("✓ Both pass the threshold — done."); break; }
  if (i < ROUNDS) cv = await revise(cv, jd, kb, ats, rec);
}
await writeFile(OUT, cv, "utf8");
console.error(`\nFinal CV → ${OUT}`);
console.error("Trace:", JSON.stringify(trace));
