// Product service: candidate profile -> multi-query search facets, via the LLM API.
// This is the productized facet-generator: a backend (or CLI) calls generateFacets(profileText) for
// ANY user — no Claude Code session required. The agent spec (.claude/agents/facet-generator.md) is the
// canonical system prompt, shared with the local subagent path so the two never drift.
import { callJson, loadAgentPrompt, DEFAULT_MODEL } from "./llm.mjs";

const ROLES = new Set(["positive", "negative", "skills"]);

// Validate the LLM output against the facets.json contract embed.mjs consumes.
export function validateFacets(cfg) {
  if (!cfg || typeof cfg !== "object" || !Array.isArray(cfg.facets)) throw new Error("facets: missing facets[] array");
  if (cfg.combination !== "top2-mean-positive") throw new Error(`facets: unexpected combination "${cfg.combination}"`);
  const names = new Set();
  for (const f of cfg.facets) {
    if (!f.name || !ROLES.has(f.role) || !f.text) throw new Error(`facets: bad facet ${JSON.stringify(f).slice(0, 80)}`);
    if (names.has(f.name)) throw new Error(`facets: duplicate name "${f.name}"`);
    names.add(f.name);
  }
  const pos = cfg.facets.filter((f) => f.role === "positive").length;
  if (pos < 4 || pos > 5) throw new Error(`facets: expected 4-5 positive, got ${pos}`);
  if (!cfg.facets.some((f) => f.role === "skills")) throw new Error("facets: missing a skills facet");
  return cfg;
}

// profileText: the candidate's profile (digest + target, or any user's profile prose).
// provider/model default to the configured LLM (LLM_PROVIDER/LLM_MODEL) — swappable per call.
export async function generateFacets({ profileText, provider, model = DEFAULT_MODEL }) {
  if (!profileText || profileText.trim().length < 50) throw new Error("generateFacets: profileText too short");
  const system = await loadAgentPrompt("facet-generator");
  const cfg = await callJson({
    system,
    user: `CANDIDATE PROFILE:\n\n${profileText}\n\nGenerate the facets JSON object now (object only, no prose).`,
    provider, model, maxTokens: 1600, temperature: 0.3,
  });
  cfg._generated_by = model;
  cfg._generated_at = new Date().toISOString().slice(0, 10);
  return validateFacets(cfg);
}
