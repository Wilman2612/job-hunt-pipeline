// Guarda la reputación investigada de una empresa. JSON por stdin.
// Uso: echo '<json>' | node --env-file=.env scripts/save-company.mjs "<Nombre Empresa>"
import { q, closePool } from "../lib/store.mjs";
const display = process.argv[2];
if (!display) { console.error("uso: save-company.mjs <nombre> (json por stdin)"); process.exit(1); }
const name = display.toLowerCase().trim();

let buf = ""; for await (const c of process.stdin) buf += c;
let intel; try { intel = JSON.parse(buf); } catch (e) { console.error("JSON inválido: " + e.message); process.exit(1); }

await q(
  `INSERT INTO companies (name, display, intel) VALUES ($1,$2,$3)
   ON CONFLICT (name) DO UPDATE SET display=EXCLUDED.display, intel=EXCLUDED.intel, researched_at=now()`,
  [name, display, JSON.stringify(intel)]
);
console.log(`OK empresa "${display}" (verdict=${intel.verdict||"?"})`);
await closePool();
