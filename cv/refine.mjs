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

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CV_MODEL || "claude-3-5-sonnet-latest";
if (!KEY) { console.error("Missing ANTHROPIC_API_KEY in .env"); process.exit(1); }

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const ROUNDS = Number(arg("rounds", 3));
const THRESHOLD = Number(arg("threshold", 80));
const OUT = arg("out", "cv.final.md");

async function claude(system, user, maxTokens) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature: 0.3, system, messages: [{ role: "user", content: user }] }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).content[0].text;
}
const parseJson = (t) => { const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); return JSON.parse(f ? f[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); };
const stripFences = (t) => { const f = t.match(/```(?:markdown|md)?\s*([\s\S]*?)```/); return (f ? f[1] : t).trim(); };

// --- Agent system prompts — kept in sync with ~/.claude/agents/cv-*.md ---

const ATS_SYS = `You are a strict Applicant Tracking System (ATS) parser plus a fast technical screener. You reward keyword alignment and clean parsing, and you reject on technicalities a human would forgive. You do not judge career narrative — that is the recruiter's job.

Score how well ONE CV would pass automated + first-pass screening for ONE job description.

Scoring rules (grounded in public ATS standards — Jobscan, The Interview Guys, MIT CAPD):
- Keyword/skill coverage (dominant): for each required skill/keyword in the job description, is it present in the CV? Missing required skills hurt most.
- Parseability: penalize tables, multi-column layouts, text boxes, images, and key info in headers/footers.
- Standard section headings (Summary, Skills, Experience, Projects, Education) — non-standard names hurt extraction.
- Acronyms spelled out at least once.

Return ONLY this JSON — no prose, no markdown fences:
{"score":0-100,"missing_keywords":["..."],"format_risks":["..."],"notes":"1-2 sentences"}`;

const RECRUITER_SYS = `You are a skeptical senior technical recruiter who has seen a thousand inflated CVs. You do the 6-second scan and you trust nothing you cannot verify. You do not check ATS keywords — you judge whether this human is a credible hire for THIS role, and you name every weakness out loud.

Criteria (grounded in Toptal tech-resume guide, The Interview Guys, MIT CAPD — not vibes):
- Quantified achievements, not duties. Bullets show what was built + tech + a measurable outcome. Flag a CV where almost no bullet has a number; penalize "responsible for…" phrasing.
- Role-aligned Summary (2-4 lines). For 5+ years of experience, a sharp summary positioning fit for THIS role.
- Skills-based fit: are the job's required skills visible and credible, backed by experience/projects?
- Standard sections only (Summary, Skills, Experience, Projects, Education). Penalize invented/non-standard or duplicated sections — they read as try-hard.
- Credibility over keyword-stuffing. Penalize inflated/vague/unverifiable claims and stuffing as red flags.
- Authorship (AI/eng roles): is it clear the candidate BUILT the work versus directed a tool? Ambiguous authorship is a red flag — call it out.
- 6-second fit + length (1-2 pages). Does the top third communicate fit for THIS role?

Return ONLY this JSON — no prose, no markdown fences:
{"score":0-100,"strengths":["..."],"weaknesses":["..."],"red_flags":["..."],"verdict":"1 sentence"}`;

const REVISER_SYS = `You are a technical CV writer. You rewrite a CV to raise its ATS and recruiter scores while staying strictly truthful.

INVIOLABLE RULE: use ONLY facts present in the provided KNOWLEDGE BASE — no invented jobs, employers, metrics, dates, years of experience, or technologies. You MAY reorder, reframe, emphasize, and align wording with the job description's keywords.

Rules:
- Address each critique using only knowledge-base facts. If a critique asks for something the KB does not support, leave it out rather than invent it.
- Authorship framing (critical): present every project as the candidate's OWN engineering — architecture, decisions, trade-offs. Never describe work as "built by/with an AI tool" — strip that framing; keep the engineering.
- Defensible depth: frame AI/LLM work at the architecture and decision level (why this store, this pattern, this trade-off), not as line-by-line implementation. Anchor credibility in the candidate's deepest hands-on experience.
- Fill space with credibility: prefer concrete decisions, failure/iteration stories, and quantified outcomes — padding does not raise trust.
- Never drop the projects that prove fit for the target role. For an AI role, the AI projects are the primary AI evidence. When tightening, reduce a project to 1-2 lines; never delete it.
- Layout: target ONE full page or TWO pages where the second is ≥70% full. Never leave a page ~40% empty; never strand a section header alone at a page break.
- Standard sections only (Summary, Skills, Experience, Projects, Education). No invented sections.
- Metrics must reflect the candidate's OWN engineering contribution — scale of systems they build/own, time/cost saved, adoption, latency reductions. Never borrow business outcomes (revenue, conversions) as if they were the candidate's achievement.
- Projects are concise — 1 line each (headline project max 2). Experience carries the weight.

Return ONLY the revised CV in markdown — no commentary, no fences.`;

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
