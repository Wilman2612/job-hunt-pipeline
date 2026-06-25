// CLI for the productized facet generator: builds profile/facets.json from the candidate profile
// via the LLM API (no Claude Code session needed). Few commands: this + scoring/embed.mjs.
// Profile source defaults to profile/digest.md + profile/target.json; override with --profile=<file>.
// Usage: node --env-file=.env scoring/gen-facets.mjs [--profile=path] [--out=profile/facets.json] [--model=...]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ROOT } from "../lib/store.mjs";
import { generateFacets } from "../lib/facets.mjs";
import { hasKey, DEFAULT_MODEL, PROVIDER } from "../lib/llm.mjs";

if (!hasKey()) { console.error(`Missing API key for LLM_PROVIDER=${PROVIDER} (set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env)`); process.exit(1); }
const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : d; };
const OUT = arg("out", path.join(ROOT, "profile/facets.json"));
const MODEL = arg("model", DEFAULT_MODEL);

// Build the profile text the LLM will ground facets on.
let profileText;
const profileArg = arg("profile", "");
if (profileArg) {
  profileText = await readFile(profileArg, "utf8");
} else {
  const digest = await readFile(path.join(ROOT, "profile/digest.md"), "utf8");
  let target = "";
  try { target = "\n\nTARGET (structured):\n" + (await readFile(path.join(ROOT, "profile/target.json"), "utf8")); } catch {}
  profileText = digest + target;
}

console.error(`Generating facets via ${PROVIDER}/${MODEL} from ${profileArg || "profile/digest.md + target.json"}…`);
const cfg = await generateFacets({ profileText, model: MODEL });
await writeFile(OUT, JSON.stringify(cfg, null, 2) + "\n");

const pos = cfg.facets.filter((f) => f.role === "positive");
console.error(`Wrote ${OUT}: ${cfg.facets.length} facets (${pos.length} positive).`);
for (const f of cfg.facets) console.error(`  [${f.role}] ${f.name}`);
console.error("\nNext: node --env-file=.env scoring/embed.mjs");
