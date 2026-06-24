-- Esquema del job-hunt store. Estructurado + JSONB para lo anidado + vector para semántica.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS jobs (
  pk          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  ext_id      TEXT NOT NULL,                 -- id de la fuente
  job_key     TEXT NOT NULL,                 -- company::title normalizado (dedup semántico de duplicados)
  title       TEXT NOT NULL,
  company     TEXT,
  location    TEXT,
  url         TEXT,
  salary      TEXT,
  posted      TEXT,
  easy_apply  BOOLEAN DEFAULT FALSE,
  raw_text    TEXT,                          -- descripción completa (NO se proyecta salvo /detalle)
  score       INT,
  eligibility JSONB,                         -- {region, eligibleForPeru, evidence}
  breakdown   JSONB,                         -- desglose del score
  matched     JSONB,                         -- {ai:[], stack:[]}
  flags       TEXT[],
  embedding   vector(1536),                  -- text-embedding-3-small
  semantic    REAL,                          -- similitud contra el perfil (0-1)
  enrich      JSONB,                          -- análisis de subagente (resumen, tz, hooks, gaps, red_flags…)
  want_score  INT,                            -- qué tanto LO QUIERE the candidate (0-100)
  qual_score  INT,                            -- qué tanto CALIFICA the candidate (0-100)
  enriched_at TIMESTAMPTZ,
  fetched_at  TIMESTAMPTZ DEFAULT now(),
  scored_at   TIMESTAMPTZ,
  UNIQUE (source, ext_id)
);
-- Idempotente para DBs ya existentes:
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

-- Tombstones de no-elegibles / descartadas: guardan título/empresa para no re-gastar recursos.
CREATE TABLE IF NOT EXISTS exclusions (
  job_key  TEXT PRIMARY KEY,
  ext_id   TEXT,
  title    TEXT,
  company  TEXT,
  reason   TEXT,
  ts       TIMESTAMPTZ DEFAULT now()
);

-- Reputación de empresas (investigada por subagente web). Una vez por empresa, reusable.
CREATE TABLE IF NOT EXISTS companies (
  name          TEXT PRIMARY KEY,   -- lower(trim(company))
  display       TEXT,
  intel         JSONB,              -- {rating,size,culture,pay,flags[],verdict,sources[]}
  researched_at TIMESTAMPTZ DEFAULT now()
);

-- Vista liviana para listar/puntuar SIN traer raw_text ni embedding.
DROP VIEW IF EXISTS jobs_light;
CREATE VIEW jobs_light AS
  SELECT source, ext_id, job_key, title, company, location, url, salary, salary_usd_year, posted,
         easy_apply, score, eligibility, breakdown, matched, flags, semantic,
         enrich, want_score, qual_score,
         (raw_text IS NOT NULL AND length(raw_text) > 0) AS has_detail,
         (enrich IS NOT NULL) AS enriched,
         fetched_at, scored_at
  FROM jobs;

-- Selección para ANÁLISIS con hard-stops YA filtrados (geo por-anuncio + piso salarial + no analizada).
-- "getSelectable": lo único que vale gastar en Sonnet. La geo NO se bloquea por empresa.
DROP VIEW IF EXISTS jobs_selectable;
CREATE VIEW jobs_selectable AS
  SELECT source, ext_id, title, company, location, semantic, salary_usd_year
  FROM jobs
  WHERE enrich IS NULL
    AND (eligibility->>'eligibleForPeru') = 'true'
    AND (salary_usd_year IS NULL OR salary_usd_year >= 45000);
