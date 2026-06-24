// Dashboard de revisión local — servidor HTTP sin dependencias (Node nativo).
// - GET  /                  -> UI
// - GET  /api/jobs          -> ofertas puntuadas (con filtros por query string)
// - GET  /api/jobs/:id/text -> raw_text bajo demanda (lazy) desde jobs/<id>.json
// - POST /api/ingest        -> SUMIDERO: navegador -> disco (el texto no pasa por el chat)
// - POST /api/decision      -> append a decisions.jsonl
// - POST /api/learn         -> corre learn.mjs + re-scorea
// Uso: node review/server.mjs   ->  http://localhost:5173
import { createServer } from "node:http";
import { readFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  ROOT, loadScored, loadDecisions, readJob, appendDecision,
  ensureDirs, loadKnown, isKnown, upsertIndex, writeJob,
} from "../lib/store.mjs";

const PORT = 5173;
const PUBLIC = path.join(ROOT, "review", "public");

const send = (res, code, body, type = "application/json") => {
  res.writeHead(code, { "Content-Type": type, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

const readBody = (req) => new Promise((resolve) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(JSON.parse(d || "{}")); } catch { resolve({}); } });
});

function runNode(script) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, script)], { cwd: ROOT });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204, "");

  try {
    // --- API ---
    if (p === "/api/jobs" && req.method === "GET") {
      const q = url.searchParams;
      const minScore = Number(q.get("minScore") || 0);
      const source = q.get("source");
      const status = q.get("status"); // new|approve|reject|maybe|all
      const region = q.get("region"); // eligible|unknown|all
      const decisions = await loadDecisions();
      let rows = await loadScored();
      rows = rows.map((r) => { const d = decisions.get(`${r.source}::${r.id}`);
        return { ...r, decision: d?.decision || null, rating: d?.rating || null, note: d?.note || "" }; });
      const sources = [...new Set(rows.map((r) => r.source))];
      rows = rows.filter((r) => r.score >= minScore);
      if (source) rows = rows.filter((r) => r.source === source);
      if (status && status !== "all") rows = rows.filter((r) => (status === "new" ? !r.decision : r.decision === status));
      if (region === "eligible") rows = rows.filter((r) => r.eligibility?.region !== "unknown");
      if (region === "unknown") rows = rows.filter((r) => r.eligibility?.region === "unknown");
      return send(res, 200, { count: rows.length, sources, jobs: rows });
    }

    let m;
    if ((m = p.match(/^\/api\/jobs\/(.+)\/text$/)) && req.method === "GET") {
      const id = decodeURIComponent(m[1]);
      const src = url.searchParams.get("source");
      const job = await readJob(src, id);
      return send(res, 200, { text: job?.raw_text || job?.description || "(sin detalle cargado todavía)" });
    }

    if (p === "/api/ingest" && req.method === "POST") {
      // Sumidero: texto del navegador -> disco. NO pasa por el contexto del modelo.
      const c = await readBody(req);
      const job = {
        source: c.source || "linkedin", id: String(c.id), title: c.t || c.title,
        company: c.co || c.company, location: c.loc || c.location, url: c.url,
        raw_text: c.raw_text || c.text || "", easyApply: !!c.ea, posted: c.posted || null,
        salary: c.salary || null, fetched_at: new Date().toISOString(),
      };
      if (!job.id || !job.title) return send(res, 400, { ok: false, error: "faltan id/title" });
      await ensureDirs();
      const known = await loadKnown();
      const isNew = !isKnown(known, job);
      if (isNew) await upsertIndex(job);
      if (job.raw_text) await writeJob(job); // siempre actualiza el detalle si llegó
      return send(res, 200, { ok: true, isNew, id: job.id });
    }

    if (p === "/api/decision" && req.method === "POST") {
      const d = await readBody(req);
      if (!d.id || !d.decision) return send(res, 400, { ok: false });
      await appendDecision({ source: d.source || "", id: String(d.id), decision: d.decision, rating: d.rating ?? null, note: d.note || "" });
      return send(res, 200, { ok: true });
    }

    if (p === "/api/feedback" && req.method === "POST") {
      // Caja de feedback/preguntas: el usuario deja notas y yo las leo en lote.
      const f = await readBody(req);
      if (!f.text) return send(res, 400, { ok: false });
      await appendFile(path.join(ROOT, "data", "feedback.jsonl"),
        JSON.stringify({ text: f.text, jobId: f.jobId || null, company: f.company || null, ts: new Date().toISOString() }) + "\n");
      return send(res, 200, { ok: true });
    }

    if (p === "/api/learn" && req.method === "POST") {
      const learn = await runNode("scoring/learn.mjs");
      const score = await runNode("scoring/score.mjs");
      return send(res, 200, { ok: true, log: (learn.out + "\n" + score.out).slice(-2000) });
    }

    // --- estáticos ---
    if (p === "/" || p === "/index.html") {
      return send(res, 200, await readFile(path.join(PUBLIC, "index.html")), "text/html; charset=utf-8");
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => console.error(`Dashboard de revisión -> http://localhost:${PORT}`));
