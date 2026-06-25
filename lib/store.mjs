// Store over Postgres + pgvector. Same API consumed by fetch/score/server/learn,
// so the rest of the system stays unchanged. Structured columns + JSONB for nested data.
import pg from "pg";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const INCOMING = path.join(ROOT, "data", "incoming");
const CONN = process.env.DATABASE_URL || "postgres://jobhunt:jobhunt_local@localhost:5433/jobhunt";

let _pool, _schemaReady;
function pool() {
  if (!_pool) _pool = new pg.Pool({ connectionString: CONN, max: 8 });
  return _pool;
}
async function ensureSchema() {
  if (_schemaReady) return;
  const sql = await readFile(path.join(ROOT, "db", "schema.sql"), "utf8");
  await pool().query(sql);
  _schemaReady = true;
}
export async function q(text, params) { await ensureSchema(); return pool().query(text, params); }
export async function closePool() { if (_pool) await _pool.end(); _pool = null; }

const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
export const jobKey = (j) => `${norm(j.company)}::${norm(j.title).replace(/\(.*?\)/g, "").trim()}`;

export async function ensureDirs() {
  await mkdir(INCOMING, { recursive: true });
  await ensureSchema();
}

// --- dedup (deduplication) ---
export async function loadKnown() {
  const ids = new Set(), keys = new Set();
  const a = await q("SELECT ext_id, job_key FROM jobs");
  const b = await q("SELECT ext_id, job_key FROM exclusions");
  for (const r of [...a.rows, ...b.rows]) { if (r.ext_id) ids.add(String(r.ext_id)); if (r.job_key) keys.add(r.job_key); }
  return { ids, keys };
}
export function isKnown(known, job) {
  return known.ids.has(String(job.id)) || known.keys.has(jobKey(job));
}

// --- upsert ---
// Inserts/updates a job posting. Only overwrites raw_text if a new one arrives (COALESCE).
async function upsertJob(job) {
  await q(
    `INSERT INTO jobs (source, ext_id, job_key, title, company, location, url, salary, posted, easy_apply, raw_text, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULLIF($11,''),now())
     ON CONFLICT (source, ext_id) DO UPDATE SET
       title=EXCLUDED.title, company=EXCLUDED.company, location=EXCLUDED.location,
       url=COALESCE(EXCLUDED.url, jobs.url), salary=COALESCE(EXCLUDED.salary, jobs.salary),
       posted=COALESCE(EXCLUDED.posted, jobs.posted), easy_apply=EXCLUDED.easy_apply,
       raw_text=COALESCE(NULLIF(EXCLUDED.raw_text,''), jobs.raw_text)`,
    [job.source, String(job.id), jobKey(job), job.title, job.company || null, job.location || null,
     job.url || null, job.salary || null, job.posted || null, !!job.easyApply, job.raw_text || job.description || ""]
  );
}
export const upsertIndex = upsertJob;  // compatibility alias
export const writeJob = upsertJob;

export async function readJob(source, id) {
  const { rows } = source
    ? await q("SELECT * FROM jobs WHERE source=$1 AND ext_id=$2", [source, String(id)])
    : await q("SELECT * FROM jobs WHERE ext_id=$1 LIMIT 1", [String(id)]);
  return rows[0] || null;
}

export async function addExclusion(job, reason) {
  await q(
    `INSERT INTO exclusions (job_key, ext_id, title, company, reason)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (job_key) DO UPDATE SET reason=EXCLUDED.reason, ts=now()`,
    [jobKey(job), String(job.id ?? ""), job.title, job.company || null, reason]
  );
  await q("DELETE FROM jobs WHERE source=$1 AND ext_id=$2", [job.source, String(job.id)]);
}

export async function appendDecision(d) {
  await q(
    `INSERT INTO decisions (source, ext_id, decision, rating, note) VALUES ($1,$2,$3,$4,$5)`,
    [d.source || "", String(d.id), d.decision, d.rating ?? null, d.note || ""]
  );
}

// --- scoring ---
// Fetches EVERYTHING needed for scoring (includes raw_text). Not used for the model: runs in Node.
export async function jobsForScoring({ rescore = false } = {}) {
  const filter = rescore ? "" : "WHERE score IS NULL";
  const { rows } = await q(`SELECT source, ext_id, title, company, location, url, salary, posted, easy_apply, raw_text FROM jobs ${filter}`);
  return rows.map((r) => ({ ...r, id: r.ext_id, easyApply: r.easy_apply, raw_text: r.raw_text || "" }));
}

// --- selection for ANALYSIS (hard-stops already filtered in the SELECT) ---
// getAll = entire pool; getSelectable = only what's worth Sonnet:
//   not yet analyzed + eligible PER-POSTING + above salary floor. Geo is NEVER blocked at the company level.
export async function getAll() {
  const { rows } = await q(
    "SELECT source, ext_id, title, company, location, semantic, salary_usd_year, (enrich IS NOT NULL) analizada, (eligibility->>'eligibleForPeru')='true' AS elegible FROM jobs ORDER BY semantic DESC NULLS LAST");
  return rows;
}
export async function getSelectable({ floor = 45000 } = {}) {
  const { rows } = await q(
    `SELECT source, ext_id, title, company, location, semantic, salary_usd_year FROM jobs
     WHERE enrich IS NULL AND (eligibility->>'eligibleForPeru')='true'
       AND (salary_usd_year IS NULL OR salary_usd_year >= $1)
     ORDER BY semantic DESC NULLS LAST`, [floor]);
  return rows;
}

export async function writeScored(rows) {
  for (const r of rows) {
    await q(
      `UPDATE jobs SET score=$3, eligibility=$4, breakdown=$5, matched=$6, flags=$7, scored_at=now()
       WHERE source=$1 AND ext_id=$2`,
      [r.source, String(r.id), r.score, JSON.stringify(r.eligibility), JSON.stringify(r.breakdown),
       JSON.stringify(r.matched), r.flags || []]
    );
  }
}

// Lightweight for the UI (no raw_text or embedding).
export async function loadScored() {
  const { rows } = await q(
    `SELECT l.*, c.intel AS company_intel
     FROM jobs_light l
     LEFT JOIN companies c ON lower(trim(l.company)) = c.name
     WHERE l.score IS NOT NULL
     ORDER BY l.score DESC, l.semantic DESC NULLS LAST`
  );
  return rows.map((r) => ({
    id: r.ext_id, source: r.source, title: r.title, company: r.company, location: r.location,
    url: r.url, salary: r.salary, posted: r.posted, easyApply: r.easy_apply, score: r.score,
    eligibility: r.eligibility, breakdown: r.breakdown, matched: r.matched, flags: r.flags || [],
    semantic: r.semantic, hasDetail: r.has_detail, salaryUsd: r.salary_usd_year,
    enrich: r.enrich, want: r.want_score, qual: r.qual_score, enriched: r.enriched,
    companyIntel: r.company_intel,
  }));
}

// Latest decision per posting, mapped by `${source}::${ext_id}`.
export async function loadDecisions() {
  const { rows } = await q(
    `SELECT DISTINCT ON (source, ext_id) source, ext_id, decision, rating, note
     FROM decisions ORDER BY source, ext_id, ts DESC`
  );
  const m = new Map();
  for (const r of rows) m.set(`${r.source}::${r.ext_id}`, r);
  return m;
}
