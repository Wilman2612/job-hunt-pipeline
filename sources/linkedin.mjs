// LinkedIn vía endpoints GUEST (sin login, sin navegador, sin CSP).
// Bypass conocido (lo usan JobSpy y otros): seeMoreJobPostings/search devuelve tarjetas,
// jobPosting/<id> devuelve la descripción completa. Todo HTTP → entra al pipeline normal.
// Va LENTO a propósito (pausas aleatorias) para no gatillar rate-limit/ban.
// Uso: node --env-file=.env sources/linkedin.mjs
import { ensureDirs, loadKnown, isKnown, writeJob, closePool } from "../lib/store.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (a, b) => a + Math.random() * (b - a);

// Búsquedas objetivo de the candidate (remoto). f_WT=2 = remoto. Escala: ubicación Perú/Lima (empresas
// contratando aquí) + LATAM + US/Worldwide (la regla estricta filtra los que no aceptan LATAM/Perú).
const QUERIES = ["AI Engineer", "LLM Engineer", "Generative AI Engineer", "Machine Learning Engineer", "AI Developer"];
const LOCATIONS = ["Peru", "Lima", "Latin America", "United States", "Worldwide"];
const PAGES = 5; // start=0,25,50,75,100 por query/location (discovery más profundo)

const decode = (s) => (s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&[a-z]+;/g, " ");
const stripTags = (s) => decode((s || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function get(url, type = "text") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" }, signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}

function parseCards(html) {
  const cards = [];
  for (const block of html.split("<li").slice(1)) {
    const id = (block.match(/jobPosting:(\d+)/) || block.match(/jobs\/view\/(\d+)/) || [])[1];
    if (!id) continue;
    const title = (block.match(/base-search-card__title[^>]*>([\s\S]*?)<\//) || [])[1];
    const company = (block.match(/base-search-card__subtitle[^>]*>[\s\S]*?>([\s\S]*?)<\/a/) ||
                     block.match(/base-search-card__subtitle[^>]*>([\s\S]*?)</) || [])[1];
    const loc = (block.match(/job-search-card__location[^>]*>([\s\S]*?)</) || [])[1];
    if (title) cards.push({ id, title: stripTags(title), company: stripTags(company || ""), loc: stripTags(loc || "Remote") });
  }
  return cards;
}

async function fetchDetail(id) {
  try {
    const html = await get(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`);
    const m = html.match(/show-more-less-html__markup[^>]*>([\s\S]*?)<\/div>/) ||
              html.match(/description__text[^>]*>([\s\S]*?)<\/section>/);
    // criteria (seniority/employment) bonus
    const crit = [...html.matchAll(/description__job-criteria-text[^>]*>([\s\S]*?)<\//g)].map((x) => stripTags(x[1]));
    return { text: stripTags(m ? m[1] : ""), criteria: crit };
  } catch (e) { return { text: "", criteria: [], err: e.message }; }
}

const main = async () => {
  await ensureDirs();
  const known = await loadKnown();
  const seen = new Set();
  const queue = [];
  // 1) recolectar tarjetas (rápido)
  for (const q of QUERIES) {
    for (const loc of LOCATIONS) {
      for (let p = 0; p < PAGES; p++) {
        const url = `https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords=${encodeURIComponent(q)}&location=${encodeURIComponent(loc)}&f_WT=2&start=${p * 25}`;
        try {
          const cards = parseCards(await get(url));
          for (const c of cards) {
            if (seen.has(c.id)) continue; seen.add(c.id);
            const job = { source: "linkedin", id: c.id, title: c.title, company: c.company, location: c.loc, url: `https://www.linkedin.com/jobs/view/${c.id}/` };
            if (isKnown(known, job)) continue;
            queue.push(job);
          }
          process.stderr.write(`  [${q} / ${loc} p${p}] +${cards.length} cards (cola: ${queue.length})\n`);
        } catch (e) { console.error(`[search ${q}/${loc}] ${e.message}`); }
        await sleep(jitter(800, 1600));
      }
    }
  }
  console.error(`\nTarjetas nuevas a enriquecer con detalle: ${queue.length}`);
  // 2) traer descripción de cada una (LENTO) y guardar con raw_text
  let ok = 0;
  for (const job of queue) {
    const d = await fetchDetail(job.id);
    job.raw_text = d.text;
    if (d.criteria?.length) job.raw_text += `\n\n[Criterios: ${d.criteria.join(" · ")}]`;
    await writeJob(job);
    ok++;
    if (ok % 10 === 0) process.stderr.write(`  detalle ${ok}/${queue.length}\n`);
    await sleep(jitter(900, 1900)); // pausa humana entre detalles
  }
  console.error(`\nLinkedIn guest: ${ok} ofertas guardadas con descripción → Postgres`);
  await closePool();
};

main();
