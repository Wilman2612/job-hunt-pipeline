// Hard-stops report (does NOT block companies — geo is PER-POSTING via recheck-geo + strict
// classifier for ATS). Here we only show the analysis pool funnel and confirm that the
// selection SELECT (jobs_selectable / getSelectable) already has hard-stops filtered.
// Usage: node --env-file=.env scoring/hardstops.mjs
import { q, closePool, getSelectable } from "../lib/store.mjs";

const FLOOR = 45000;
const { rows } = await q(`SELECT
  count(*) total,
  count(*) FILTER (WHERE enrich IS NOT NULL) analizadas,
  count(*) FILTER (WHERE enrich IS NULL) sin_analizar,
  count(*) FILTER (WHERE enrich IS NULL AND (eligibility->>'eligibleForPeru')!='true') stop_geo,
  count(*) FILTER (WHERE enrich IS NULL AND (eligibility->>'eligibleForPeru')='true' AND salary_usd_year IS NOT NULL AND salary_usd_year < ${FLOOR}) stop_salario
  FROM jobs`);
const r = rows[0];
const selectable = await getSelectable({ floor: FLOOR });
console.error("Pool funnel:");
console.error(`  total: ${r.total} | analyzed: ${r.analizadas} | not analyzed: ${r.sin_analizar}`);
console.error(`  hard-stop GEO (per-posting): ${r.stop_geo}`);
console.error(`  hard-stop SALARY (<$${FLOOR}): ${r.stop_salario}`);
console.error(`  SELECTABLE (worth spending Sonnet on): ${selectable.length}`);
await closePool();
