# Job Hunt Pipeline

Automated job search system: ingests thousands of postings from multiple sources, filters by
**per-posting geographic eligibility**, ranks by **semantic similarity (embeddings)** against a
candidate profile, and scores the top candidates with a **structured LLM analysis** that applies
**hard stops** (geo, salary, impossible requirements). Output feeds a review dashboard and a
**multi-agent CV refiner** (ATS screener + recruiter + reviser loop) that tailors the CV per posting.

> **The problem it solves:** manually reviewing thousands of postings is not feasible. The pipeline
> reduces ~10k postings to the few dozen that are *genuinely* eligible, desirable, and reachable —
> and for each one it adapts the CV. The philosophy is **KISS**: a few deterministic stages + one LLM
> call where reasoning actually matters.

---

## Architecture

```
sources ──► store (Postgres+pgvector) ──► eligibility ──► embeddings ──► LLM scoring ──► dashboard ──► CV refine
(11 APIs)    raw_text isolated            (per-posting)    (ranking)     (Claude, JSON)   (review)     (multi-agent)
                                               │                               │
                                               └──────── hard-stops ───────────┘
                                           (geo + salary < floor → out of analysis pool)
```

| Stage | File | What it does |
|-------|------|--------------|
| **Multi-source fetch** | `sources/*.mjs` | LinkedIn (guest endpoints), public ATS boards (Greenhouse/Ashby/Lever), Torre, HN Who's Hiring, Get on Board, remote-first boards. Dedup by id + `company::title`. |
| **Store** | `lib/store.mjs`, `db/schema.sql` | Postgres 16 + pgvector. `raw_text` is isolated per row (never bloats model contexts). `getSelectable()` = analysis pool with hard-stops already filtered out. |
| **Eligibility** | `scoring/eligibility.mjs` | **Per-posting**, source-aware geographic classifier: LinkedIn and company ATS are strict (the location binds the posting); remote-first boards are lenient unless there's a hard restriction. Never blocks an entire company. |
| **Embeddings / ranking** | `scoring/embed.mjs` | OpenAI `text-embedding-3-small`; cosine similarity against the candidate profile → `jobs.semantic`. Cheap pre-filter before spending on the LLM. |
| **LLM analysis** | `scoring/analyze-queue.mjs` | Claude analyzes the top postings and returns strict JSON: `want`/`qual`, `requirements` map (req/nice × meets/stretch/gap/blocker), geo, comp, red flags. |
| **Hard-stops** | `scoring/hardstops.mjs` | Persists deterministic discards (ineligible geo, salary below floor) to **avoid re-analyzing** — same way known IDs avoid re-ingesting. |
| **Dashboard** | `review/server.mjs` + `review/public/` | Local HTTP (`:5173`) to review, rate, and approve postings. |
| **CV refiner** | `cv/refine.mjs` | **Multi-agent loop**: an *ATS-screener* and a *recruiter* critique the CV vs the job description; a *reviser* rewrites it (facts from KB only) 2–3 rounds until it passes the threshold. No RAG by design. |
| **Profile** | `profile/*` | `target.json` (criteria), `digest.md` (profile for LLM), `enrich-spec.md` (analysis spec), `learned.json` (learned preferences). |

---

## Stack

- **Node.js 20** (ESM, no frameworks) — single runtime dependency: `pg`.
- **PostgreSQL 16 + pgvector** (Docker).
- **OpenAI** embeddings (semantic ranking) · **Anthropic Claude** (structured reasoning analysis).

---

## Setup

Requirements: Docker (for Postgres) + Node 20.

**1. Keys** — copy `.env.example` → `.env` and fill in two keys:
```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
```

**2. Profile** — copy the templates and edit with your criteria:
```bash
cp profile/target.example.json profile/target.json   # roles, salary floor, stack, keywords
cp profile/digest.example.md   profile/digest.md     # LLM profile description
```

**3. Run**
```bash
docker compose up -d db        # start Postgres+pgvector at localhost:5433
npm install
npm run fetch                  # ingest from all sources
npm run score                  # eligibility + scoring
npm run dash                   # review dashboard → http://localhost:5173
```

---

## Design decisions

**1) Claude Sonnet for analysis, not a cheaper model.**
The analysis is not summarization: it applies *hard stops* that require strict reasoning —
per-posting geographic eligibility, detection of impossible requirements (e.g. "5 years" of a tool
that is one year old), salary vs. floor, and distinguishing **building AI** from **using AI**.
When tested with a cheaper model (`gpt-4o-mini`), the analysis **inflated**: it marked "AI
evaluator / data-labeling" gigs as strong matches, skipped geo restrictions, and confused "using
Copilot" with "building agents". Sonnet holds that bar and returns reliable structured JSON. Cost is
controlled in layers: **embeddings (cheap)** rank the bulk; the **expensive LLM** only touches the
curated top slice.

**2) Vanilla JS, not LangChain / LangGraph.**
The pipeline is a few deterministic stages (fetch → classify → embed → analyze → store). An
orchestration framework adds abstraction, dependency weight, and latency this flow does not need.
Direct `fetch` calls to OpenAI/Anthropic REST APIs + simple async workers keep it **fast, debuggable,
and with a single dependency** (`pg`). If orchestration grew (conditional branches, stateful retries,
chained tools), LangGraph would be worth it — today it would be over-engineering.

**3) Where the "multi-agent" actually is — and why no RAG.**
The *posting analysis* is not multi-agent: it is **parallel inference** (a worker pool making the
same LLM call) — calling it multi-agent would be inflating the claim. The real multi-agent lives in
`cv/refine.mjs`: **distinct roles** (ATS screener, recruiter, reviser) that **coordinate and iterate
with feedback**. And deliberately **no RAG**: the context is 1 CV + 1 job description + 1 knowledge
base — it fits entirely in the prompt. A vector store there would be decoration, not engineering.

---

## Structure

```
sources/    multi-source fetch
scoring/    eligibility · embed · analyze-queue · hardstops · score · normalize-salary
lib/        store (Postgres+pgvector)
review/     HTTP review dashboard
profile/    criteria + profile + analysis spec (real data gitignored)
db/         schema.sql
```

> Personal automation project. Deliberately simple system: optimized to be understood, debugged, and
> extended — not to impress with layers.
