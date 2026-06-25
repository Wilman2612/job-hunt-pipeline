// Master runner: executes ALL sources in sequence, then scores.
// Usage: node --env-file=.env sources/run-all.mjs
// Flags: --skip-linkedin (fast, no guest API)  --only-ats  --skip-score
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f) => args.includes(f);

function run(script, label) {
  console.log(`\n${"=".repeat(60)}\n▶  ${label}\n${"=".repeat(60)}`);
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [script],
    { cwd: ROOT, stdio: "inherit", env: process.env, timeout: 600_000 }
  );
  const s = ((Date.now() - t0) / 1000).toFixed(1);
  if (r.status !== 0) console.error(`  ⚠  ${label} exited with code ${r.status} (${s}s)`);
  else console.log(`  ✓  ${label} done in ${s}s`);
}

// --- API/RSS sources (fast, unauthenticated) ---
if (!has("--only-ats") && !has("--only-linkedin")) {
  run("sources/fetch.mjs",       "fetch (remotive/remoteok/arbeitnow/wwr/himalayas/workingnomads/jobicy/torre)");
  run("sources/muse.mjs",        "The Muse API");
  run("sources/hn.mjs",          "Hacker News: Who is hiring?");
}

// --- Direct ATS boards (Greenhouse / Ashby / Lever — 100+ AI companies) ---
if (!has("--skip-ats")) {
  run("sources/ats.mjs",         "ATS (Greenhouse/Ashby/Lever — OpenAI, Anthropic, Cursor, Vercel…)");
}

// --- LinkedIn guest (slow: ~10-15 min) ---
if (!has("--skip-linkedin") && !has("--only-ats")) {
  run("sources/linkedin.mjs",    "LinkedIn guest API (LATAM/US/Worldwide)");
}

// --- Score + eligibility (new jobs only) ---
if (!has("--skip-score")) {
  run("scoring/score.mjs",       "Score + eligibility (new jobs)");
  run("scoring/embed.mjs",       "OpenAI embeddings (unembedded jobs)");
}

console.log("\n✅  run-all done.");
