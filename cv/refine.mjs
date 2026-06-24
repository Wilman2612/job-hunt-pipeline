// Refinamiento de CV MULTI-AGENTE: tres roles con objetivos distintos que iteran con feedback.
//   1) ATS screener  → puntúa parseo + cobertura de keywords vs la job description.
//   2) Reclutador     → scan de 6s: fit, impacto, credibilidad, red flags.
//   3) Reviser        → reescribe atendiendo ambas críticas. GUARDRAIL: solo usa hechos del
//                       knowledge base; reencuadra/enfatiza, NUNCA fabrica.
// Bucle hasta que ATS y reclutador pasen el umbral o se agoten las rondas.
//
// SIN RAG a propósito: la data (1 CV + 1 JD + 1 KB) entra en contexto; un vector store sería
// over-engineering para este volumen. Llamadas directas a la API de Claude → cero deps.
// (Standalone, pero también se puede orquestar con Claude Code.)
//
// Uso:
//   node --env-file=.env cv/refine.mjs --jd=job.txt --kb=cv_base.md [--cv=draft.md] \
//        [--out=cv.final.md] [--rounds=3] [--threshold=80]
import { readFile, writeFile } from "node:fs/promises";

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.CV_MODEL || "claude-3-5-sonnet-latest";
if (!KEY) { console.error("Falta ANTHROPIC_API_KEY en .env"); process.exit(1); }

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

// --- Roles (cada uno es un agente con su propio system prompt y objetivo) ---
const ATS_SYS = `Eres un Applicant Tracking System (ATS) + primer filtro técnico. Evalúas un CV contra una job description como lo haría un parser ATS y un screener. Devuelve SOLO JSON:
{"score":0-100,"missing_keywords":[...],"format_risks":[...],"notes":"1-2 frases"}
Penaliza: keywords clave de la JD ausentes en el CV; secciones no estándar; tablas/columnas que rompen el parseo; acrónimos sin expandir al menos una vez.`;

const RECRUITER_SYS = `Eres un reclutador técnico senior en el scan de 6 segundos. Evalúas si el CV VENDE al candidato para ESTA oferta. Devuelve SOLO JSON:
{"score":0-100,"strengths":[...],"weaknesses":[...],"red_flags":[...],"verdict":"1 frase"}
Mira: ¿el tercio superior comunica el fit?; ¿hay impacto medible?; ¿es creíble o suena a humo?; ¿algún claim inflado o inconsistente?`;

const REVISER_SYS = `Eres un escritor de CVs técnicos. Reescribes el CV para subir su puntaje ante el ATS y el reclutador, atendiendo sus críticas.
REGLA INVIOLABLE: solo puedes usar hechos presentes en el KNOWLEDGE BASE. NO inventes empleos, métricas, años ni tecnologías. Puedes reordenar, reencuadrar, enfatizar y alinear keywords con la JD — nunca fabricar.
Formato: markdown limpio, 1-2 páginas, secciones estándar. Devuelve SOLO el CV en markdown, sin comentarios.`;

const atsReview = (cv, jd) => claude(ATS_SYS, `JOB DESCRIPTION:\n${jd}\n\nCV:\n${cv}`, 700).then(parseJson);
const recruiterReview = (cv, jd) => claude(RECRUITER_SYS, `JOB DESCRIPTION:\n${jd}\n\nCV:\n${cv}`, 700).then(parseJson);

function revise(cv, jd, kb, ats, rec) {
  const crit = `CRÍTICA ATS (score ${ats.score}): faltan keywords ${JSON.stringify(ats.missing_keywords)}; riesgos de formato ${JSON.stringify(ats.format_risks)}. ${ats.notes}
CRÍTICA RECLUTADOR (score ${rec.score}): debilidades ${JSON.stringify(rec.weaknesses)}; red flags ${JSON.stringify(rec.red_flags)}. ${rec.verdict}`;
  return claude(REVISER_SYS, `KNOWLEDGE BASE (única fuente de hechos permitida):\n${kb}\n\nJOB DESCRIPTION:\n${jd}\n\nCV ACTUAL:\n${cv}\n\nCRÍTICAS A ATENDER:\n${crit}`, 2500).then(stripFences);
}
const writeDraft = (jd, kb) =>
  claude(REVISER_SYS, `KNOWLEDGE BASE (única fuente de hechos permitida):\n${kb}\n\nJOB DESCRIPTION:\n${jd}\n\nEscribe un primer CV de 1-2 páginas tuneado a esta oferta, usando SOLO hechos del knowledge base.`, 2500).then(stripFences);

// --- Orquestación del bucle ---
const jdPath = arg("jd"), kbPath = arg("kb");
if (!jdPath || !kbPath) { console.error("Faltan --jd=<job.txt> y --kb=<cv_base.md>"); process.exit(1); }
const jd = await readFile(jdPath, "utf8");
const kb = await readFile(kbPath, "utf8");
let cv = arg("cv") ? await readFile(arg("cv"), "utf8") : (console.error("Sin draft → generando CV inicial…"), await writeDraft(jd, kb));

const trace = [];
for (let i = 1; i <= ROUNDS; i++) {
  const [ats, rec] = await Promise.all([atsReview(cv, jd), recruiterReview(cv, jd)]);
  trace.push({ round: i, ats: ats.score, recruiter: rec.score });
  console.error(`Ronda ${i}:  ATS ${ats.score}  |  Reclutador ${rec.score}`);
  if (ats.score >= THRESHOLD && rec.score >= THRESHOLD) { console.error("✓ Ambos pasan el umbral — listo."); break; }
  if (i < ROUNDS) cv = await revise(cv, jd, kb, ats, rec);
}
await writeFile(OUT, cv, "utf8");
console.error(`\nCV final → ${OUT}`);
console.error("Trace:", JSON.stringify(trace));
