// Prints the detail of ONE posting for a subagent to read.
// Usage: node --env-file=.env scripts/get-job.mjs <source> <id>
import { q, closePool } from "../lib/store.mjs";

const [source, id] = process.argv.slice(2);
if (!source || !id) { console.error("usage: get-job.mjs <source> <id>"); process.exit(1); }

const { rows } = await q(
  "SELECT title, company, location, url, salary, posted, raw_text FROM jobs WHERE source=$1 AND ext_id=$2",
  [source, id]
);
if (!rows[0]) { console.error("not found"); process.exit(2); }
const j = rows[0];
console.log(`TITLE: ${j.title}`);
console.log(`COMPANY: ${j.company || "?"}`);
console.log(`LOCATION: ${j.location || "?"}`);
console.log(`SALARY: ${j.salary || "(not disclosed)"}`);
console.log(`POSTED: ${j.posted || "?"}`);
console.log(`URL: ${j.url || ""}`);
console.log(`\n--- DESCRIPTION ---\n${(j.raw_text || "(no description)").slice(0, 8000)}`);
await closePool();
