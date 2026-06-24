// Reporte de hard-stops (NO bloquea empresas — geo es POR-ANUNCIO vía recheck-geo + clasificador
// estricto para ATS). Aquí solo se muestra el embudo del pozo de análisis y se confirma que el
// SELECT de selección (jobs_selectable / getSelectable) ya trae los hard-stops filtrados.
// Uso: node --env-file=.env scoring/hardstops.mjs
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
console.error("Embudo del pozo:");
console.error(`  total: ${r.total} | analizadas: ${r.analizadas} | sin analizar: ${r.sin_analizar}`);
console.error(`  hard-stop GEO (por-anuncio): ${r.stop_geo}`);
console.error(`  hard-stop SALARIO (<$${FLOOR}): ${r.stop_salario}`);
console.error(`  SELECTABLE (lo que vale Sonnet): ${selectable.length}`);
await closePool();
