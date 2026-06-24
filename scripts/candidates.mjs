// Lista candidatas para enriquecer (top-N por similitud semántica, aún sin enrich).
// El orquestador lo usa para armar lotes y repartir a subagentes.
// Uso: node --env-file=.env scripts/candidates.mjs [--top 40] [--all]
import { q, closePool } from "../lib/store.mjs";

const args = process.argv.slice(2);
const top = Number((args.find((a) => a.startsWith("--top="))?.split("=")[1]) || (args.includes("--top") ? args[args.indexOf("--top") + 1] : 40));
const all = args.includes("--all"); // incluir ya enriquecidas (re-análisis)

const { rows } = await q(
  `SELECT source, ext_id, title, company, score, round(semantic::numeric,3) AS semantic
   FROM jobs
   WHERE score IS NOT NULL ${all ? "" : "AND enrich IS NULL"}
   ORDER BY semantic DESC NULLS LAST, score DESC
   LIMIT $1`,
  [top]
);
console.log(JSON.stringify(rows, null, 2));
await closePool();
