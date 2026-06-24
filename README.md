# Job Hunt Pipeline

Sistema automatizado de búsqueda de empleo: ingiere miles de ofertas de múltiples fuentes, las
clasifica por **elegibilidad geográfica (por-anuncio)**, las rankea por **similitud semántica
(embeddings)** contra un perfil, y puntúa las más prometedoras con un **LLM (Claude)** que emite un
veredicto estructurado y aplica **"hard stops"** (geo, salario, requisitos imposibles). La salida
alimenta un dashboard de revisión y un **refinador de CV multi-agente** (ATS + reclutador + reviser
en bucle) que adapta el CV por oferta.

> **El problema que resuelve:** revisar miles de ofertas a mano es inviable. El pipeline reduce
> ~10k ofertas a las pocas decenas que son *realmente* elegibles, deseables y alcanzables — y para
> cada una adapta el CV. La filosofía es **KISS**: pocas etapas deterministas + una llamada LLM
> donde el razonamiento importa.

---

## Arquitectura

```
fuentes ──► store (Postgres+pgvector) ──► elegibilidad ──► embeddings ──► scoring LLM ──► dashboard ──► CV refine
(11 APIs)    raw_text aislado            (geo por-anuncio)  (ranking)      (Claude, JSON)   (revisión)   (multi-agente)
                                              │                                │
                                              └────────── hard-stops ──────────┘
                                          (geo + salario < piso → fuera del pool de análisis)
```

| Etapa | Archivo | Qué hace |
|-------|---------|----------|
| **Fetch multifuente** | `sources/*.mjs` | LinkedIn (guest endpoints), ATS públicos (Greenhouse/Ashby/Lever), Torre, HN Who's Hiring, Get on Board, boards remote-first. Dedup por id + `company::title`. |
| **Store** | `lib/store.mjs`, `db/schema.sql` | Postgres 16 + pgvector. El `raw_text` queda aislado por fila (no infla contextos). `getSelectable()` = pozo de análisis con hard-stops ya filtrados. |
| **Elegibilidad** | `scoring/eligibility.mjs` | Clasificador geográfico **por-anuncio** y *source-aware*: LinkedIn y ATS de empresa son estrictos (la ubicación ata el anuncio); boards remote-first son laxos salvo restricción dura. Nunca bloquea una empresa entera. |
| **Embeddings / ranking** | `scoring/embed.mjs` | OpenAI `text-embedding-3-small`; similitud coseno contra el perfil → `jobs.semantic`. Filtra barato el grueso antes de gastar en el LLM. |
| **Análisis LLM** | `scoring/analyze-queue.mjs` | Claude analiza las mejores ofertas y devuelve JSON estricto: `want`/`qual`, mapa de `requirements` (req/nice, meets/stretch/gap/blocker), geo, comp, red flags. |
| **Hard-stops** | `scoring/hardstops.mjs` | Persisten los descartes deterministas (geo no-elegible, salario < piso) para **no re-analizar** — igual que los IDs conocidos evitan re-ingestar. |
| **Dashboard** | `review/server.mjs` + `review/public/` | HTTP local (`:5173`) para revisar, calificar y aprobar ofertas. |
| **Refinador de CV** | `cv/refine.mjs` | Bucle **multi-agente**: un *ATS-screener* y un *reclutador* critican el CV vs la oferta; un *reviser* lo reescribe (solo con hechos de la KB) 2-3 vueltas hasta pasar umbral. Sin RAG a propósito. |
| **Perfil** | `profile/*` | `target.json` (criterios), `digest.md` (perfil para el LLM), `enrich-spec.md` (spec de análisis), `learned.json` (preferencias aprendidas). |

---

## Stack

- **Node.js 20** (ESM, sin frameworks) — única dependencia runtime: `pg`.
- **PostgreSQL 16 + pgvector** (Docker).
- **OpenAI** embeddings (ranking semántico) · **Anthropic Claude** (análisis con razonamiento estricto).

---

## Setup

Requisitos: Docker + Docker Compose, y Node 20 (si corres los scripts fuera de Docker).

```bash
# 1) Config
cp .env.example .env            # rellena ANTHROPIC_API_KEY y OPENAI_API_KEY

# 2) Perfil (datos personales — NO se versionan; parten de plantillas)
cp profile/target.example.json  profile/target.json
cp profile/digest.example.md    profile/digest.md
cp profile/learned.example.json profile/learned.json
#   edita esos 3 con tus datos / criterios

# 3) Base de datos
docker compose up -d db         # Postgres+pgvector en localhost:5433
```

## Ejecución

### Con Docker (pipeline + dashboard)

```bash
docker compose up --build       # levanta db + app (dashboard en http://localhost:5173)
# correr una etapa puntual dentro del contenedor:
docker compose run --rm app node sources/fetch.mjs
```

### Local (Node directo)

```bash
npm install
npm run fetch     # 1) ingiere ofertas de todas las fuentes
npm run embed     # 2) embeddings + ranking semántico
npm run score     # 3) elegibilidad + scoring heurístico
node --env-file=.env scoring/analyze-queue.mjs   # 4) análisis LLM de las mejores
node --env-file=.env scoring/hardstops.mjs       # 5) persiste hard-stops
npm run dash      # 6) dashboard de revisión → http://localhost:5173
```

---

## Trade-offs técnicos

**1) Claude Sonnet para el análisis, no un modelo más barato.**
El análisis no es un resumen: aplica *hard stops* que exigen razonamiento estricto — elegibilidad
geográfica por-anuncio, detección de requisitos imposibles (p.ej. "5 años" de una herramienta
nacida hace uno), salario vs. piso, y distinguir **construir IA** de **usar IA**. Probado con un
modelo barato (`gpt-4o-mini`), el análisis **inflaba**: marcaba gigs de "AI evaluator/data-labeling"
como matches fuertes, se saltaba restricciones de geo y confundía "usar Copilot" con "construir
agentes". Sonnet sostiene ese criterio y devuelve JSON estructurado confiable. El costo se controla
en capas: los **embeddings (baratos)** rankean el grueso; el **LLM caro** solo toca la crema curada.

**2) Vanilla JS, no LangChain / LangGraph.**
El pipeline son pocas etapas deterministas (fetch → clasificar → embeber → analizar → guardar). Un
framework de orquestación agrega abstracción, peso de dependencias y latencia que este flujo no
necesita. Llamadas `fetch` directas a las APIs REST de OpenAI/Anthropic + workers async simples lo
mantienen **rápido, depurable y con una sola dependencia** (`pg`). Si la orquestación creciera
(ramas condicionales, reintentos con estado, herramientas encadenadas), LangGraph valdría la pena —
hoy sería sobre-ingeniería.

**3) Dónde está (y dónde NO está) el "multi-agente", y por qué sin RAG.**
El *análisis* de ofertas no es multi-agente: es **inferencia en paralelo** (un pool de workers que
hacen la misma llamada al LLM) — llamarlo multi-agente sería inflarlo. El multi-agente real vive en
`cv/refine.mjs`: roles **distintos** (ATS, reclutador, reviser) que **coordinan e iteran con
feedback**. Y deliberadamente **no usa RAG**: el contexto es 1 CV + 1 oferta + 1 knowledge base —
cabe entero en el prompt. Un vector store ahí sería decoración, no ingeniería.

---

## Estructura

```
sources/    fetch multifuente
scoring/    eligibility · embed · analyze-queue · hardstops · score · normalize-salary
lib/        store (Postgres+pgvector)
review/     dashboard HTTP de revisión
profile/    criterios + perfil + spec de análisis (datos reales gitignored)
db/         schema.sql
```

> Proyecto personal de automatización. Sistema deliberadamente simple: optimizado para entender,
> depurar y extender, no para impresionar con capas.
