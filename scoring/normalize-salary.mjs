// Normaliza el string crudo de salario a USD/año estructurado → columna jobs.salary_usd_year.
// Maneja moneda (CAD/SGD/EUR/GBP/MXN/BRL/PEN…), periodo (hora/mes/año) y "k". Midpoint de rangos.
// Uso: node --env-file=.env scoring/normalize-salary.mjs
import { q, closePool } from "../lib/store.mjs";

const RATE = { usd: 1, cad: 0.73, sgd: 0.74, eur: 1.08, gbp: 1.27, aud: 0.66, chf: 1.12,
  mxn: 0.055, brl: 0.18, pen: 0.27, ars: 0.0011, clp: 0.0011, cop: 0.00025, inr: 0.012, "€": 1.08, "£": 1.27, "$": 1 };

function annualUSD(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase();
  if (/competit|negoci|no especif|s\/dato|sin salario|^\s*\?\s*$|undefined|^-/.test(s)) return null;
  // moneda
  let cur = "usd";
  for (const c of ["cad", "sgd", "eur", "gbp", "aud", "chf", "mxn", "brl", "pen", "ars", "clp", "cop", "inr"]) if (s.includes(c)) { cur = c; break; }
  if (cur === "usd") { if (s.includes("€")) cur = "eur"; else if (s.includes("£")) cur = "gbp"; }
  // periodo
  const mult = /hour|\/hr|hora|hourly/.test(s) ? 2000 : /month|\/mo|mes|mensual|monthly/.test(s) ? 12 : 1;
  // números (con k)
  const nums = [];
  for (const m of s.matchAll(/(\d[\d,\.]*)\s*(k)?/g)) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (isNaN(n)) continue;
    if (m[2] === "k") n *= 1000;
    if (n >= 3) nums.push(n); // descarta ruido tipo "401(k)"→0, "2 years"
  }
  if (!nums.length) return null;
  // si hay >=2 números plausibles de salario, midpoint de los 2 primeros; si no, el único
  const big = nums.filter((n) => n >= (mult === 1 ? 8000 : mult === 12 ? 800 : 8)); // umbral por periodo
  const use = (big.length ? big : nums).slice(0, 2);
  const val = use.reduce((a, b) => a + b, 0) / use.length;
  return Math.round(val * mult * (RATE[cur] || 1));
}

const { rows } = await q("SELECT source, ext_id, salary FROM jobs WHERE salary IS NOT NULL AND salary_usd_year IS NULL");
let set = 0;
for (const r of rows) {
  const v = annualUSD(r.salary);
  if (v && v > 5000 && v < 2000000) { await q("UPDATE jobs SET salary_usd_year=$3 WHERE source=$1 AND ext_id=$2", [r.source, r.ext_id, v]); set++; }
}
console.error(`Normalizadas ${set}/${rows.length} con salario.`);
const { rows: dist } = await q("SELECT CASE WHEN salary_usd_year>=65000 THEN '>=65k (objetivo)' WHEN salary_usd_year>=45000 THEN '45-65k (piso ok)' ELSE '<45k (bajo piso)' END band, count(*) FROM jobs WHERE salary_usd_year IS NOT NULL GROUP BY 1 ORDER BY 1 DESC");
for (const d of dist) console.error(`  ${d.band}: ${d.count}`);
await closePool();
