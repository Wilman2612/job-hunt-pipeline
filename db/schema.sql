-- Job-hunt store schema. Structured columns + JSONB for nested data + vector for semantics.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
  pk          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  ext_id      TEXT NOT NULL,                 -- source id
  job_key     TEXT NOT NULL,                 -- company::title normalized (semantic dedup of duplicates)
  title       TEXT NOT NULL,
  company     TEXT,
  location    TEXT,
  url         TEXT,
  salary      TEXT,
  posted      TEXT,
  easy_apply  BOOLEAN DEFAULT FALSE,
  raw_text    TEXT,                          -- full description (NOT projected except on /detail)
  score       INT,
  eligibility JSONB,                         -- {region, eligibleForPeru, evidence}
  breakdown   JSONB,                         -- score breakdown
  matched     JSONB,                         -- {ai:[], stack:[]}
  flags       TEXT[],
  embedding   vector(1536),                  -- text-embedding-3-small
  semantic    REAL,                          -- similarity against the profile (0-1)
  enrich      JSONB,                          -- subagent analysis (summary, tz, hooks, gaps, red_flags…)
  want_score  INT,                            -- how much the candidate WANTS this role (0-100)
  qual_score  INT,                            -- how well the candidate QUALIFIES (0-100)
  enriched_at TIMESTAMPTZ,
  fetched_at  TIMESTAMPTZ DEFAULT now(),
  scored_at   TIMESTAMPTZ,
  UNIQUE (source, ext_id)
);
-- Idempotent for existing DBs:
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS enrich JSONB;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS want_score INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS qual_score INT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS salary_usd_year INT;
CREATE INDEX IF NOT EXISTS jobs_score_idx   ON jobs (score DESC);
CREATE INDEX IF NOT EXISTS jobs_source_idx  ON jobs (source);
CREATE INDEX IF NOT EXISTS jobs_key_idx     ON jobs (job_key);

CREATE TABLE IF NOT EXISTS decisions (
  id        BIGSERIAL PRIMARY KEY,
  source    TEXT NOT NULL,
  ext_id    TEXT NOT NULL,
  decision  TEXT NOT NULL CHECK (decision IN ('approve','reject','maybe')),
  rating    INT,
  note      TEXT,
  ts        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_job_idx ON decisions (source, ext_id, ts DESC);

-- Tombstones for ineligible / discarded jobs: store title/company to avoid re-spending resources.
CREATE TABLE IF NOT EXISTS exclusions (
  job_key  TEXT PRIMARY KEY,
  ext_id   TEXT,
  title    TEXT,
  company  TEXT,
  reason   TEXT,
  ts       TIMESTAMPTZ DEFAULT now()
);

-- Company reputation (researched by web subagent). Once per company, reusable.
CREATE TABLE IF NOT EXISTS companies (
  name          TEXT PRIMARY KEY,   -- lower(trim(company))
  display       TEXT,
  intel         JSONB,              -- {rating,size,culture,pay,flags[],verdict,sources[]}
  researched_at TIMESTAMPTZ DEFAULT now()
);

-- Lightweight view for listing/scoring WITHOUT fetching raw_text or embedding.
DROP VIEW IF EXISTS jobs_light;
CREATE VIEW jobs_light AS
  SELECT source, ext_id, job_key, title, company, location, url, salary, salary_usd_year, posted,
         easy_apply, score, eligibility, breakdown, matched, flags, semantic,
         enrich, want_score, qual_score,
         (raw_text IS NOT NULL AND length(raw_text) > 0) AS has_detail,
         (enrich IS NOT NULL) AS enriched,
         fetched_at, scored_at
  FROM jobs;

-- Selection for ANALYSIS with hard-stops ALREADY filtered (per-posting geo + salary floor + not yet analyzed).
-- "getSelectable": the only jobs worth spending Sonnet on. Geo is NOT blocked at the company level.
DROP VIEW IF EXISTS jobs_selectable;
CREATE VIEW jobs_selectable AS
  SELECT source, ext_id, title, company, location, semantic, salary_usd_year
  FROM jobs
  WHERE enrich IS NULL
    AND (eligibility->>'eligibleForPeru') = 'true'
    AND (salary_usd_year IS NULL OR salary_usd_year >= 45000);
