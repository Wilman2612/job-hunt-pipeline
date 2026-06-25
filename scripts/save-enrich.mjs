// Saves a subagent's analysis into jobs.enrich (+ want_score/qual_score).
// JSON is passed via STDIN (avoids escaping problems in arguments).
// Usage: echo '<json>' | node --env-file=.env scripts/save-enrich.mjs <source> <id>
import { q, closePool } from "../lib/store.mjs";

const [source, id] = process.argv.slice(2);
if (!source || !id) { console.error("usage: save-enrich.mjs <source> <id> (json via stdin)"); process.exit(1); }

let buf = "";
for await (const chunk of process.stdin) buf += chunk;
let obj;
try { obj = JSON.parse(buf); } catch (e) { console.error("Invalid JSON: " + e.message); process.exit(1); }

const clampInt = (v) => (v == null || isNaN(+v)) ? null : Math.max(0, Math.min(100, Math.round(+v)));
const want = clampInt(obj.want);
const qual = clampInt(obj.qual);

const { rowCount } = await q(
  `UPDATE jobs SET enrich=$3, want_score=$4, qual_score=$5, enriched_at=now()
   WHERE source=$1 AND ext_id=$2`,
  [source, id, JSON.stringify(obj), want, qual]
);
console.log(rowCount ? `OK ${source}/${id} (want=${want} qual=${qual})` : `NO MATCH ${source}/${id}`);
await closePool();
