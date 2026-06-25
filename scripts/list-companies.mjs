// Lists companies (from eligible/analyzed postings) that don't yet have researched reputation.
// Usage: node --env-file=.env scripts/list-companies.mjs [--top 20]
import { q, closePool } from "../lib/store.mjs";
const top = Number(process.argv.find((a)=>a.startsWith("--top="))?.split("=")[1] || 20);

const { rows } = await q(
  `SELECT j.company, count(*) AS jobs, max(j.title) AS sample
   FROM jobs j
   LEFT JOIN companies c ON lower(trim(j.company)) = c.name
   WHERE j.company IS NOT NULL AND j.company <> '' AND c.name IS NULL AND j.score IS NOT NULL
   GROUP BY j.company
   ORDER BY count(*) DESC, max(j.semantic) DESC NULLS LAST
   LIMIT $1`, [top]
);
console.log(JSON.stringify(rows, null, 2));
await closePool();
