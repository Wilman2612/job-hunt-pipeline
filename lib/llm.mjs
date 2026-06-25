// Provider-agnostic LLM layer (LangChain) — the SINGLE place LLM calls go through.
// Swap model/provider by config: LLM_PROVIDER=openai|anthropic and LLM_MODEL=<id>. Auto-detects the
// provider from whichever API key is present, so the same code runs on OpenAI locally (key in .env)
// and on Anthropic in the product (set ANTHROPIC_API_KEY). Agent specs in .claude/agents/*.md are the
// canonical system prompts (loadAgentPrompt), shared with Claude Code subagents → no drift.
import { ChatOpenAI } from "@langchain/openai";
import { ChatAnthropic } from "@langchain/anthropic";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODELS = { openai: "gpt-4o-mini", anthropic: "claude-sonnet-4-6" };

// Provider: explicit env wins; else whichever key is configured (OpenAI is present locally).
export const PROVIDER = process.env.LLM_PROVIDER
  || (process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : "openai");
export const DEFAULT_MODEL = process.env.LLM_MODEL || DEFAULT_MODELS[PROVIDER];

export const hasKey = (provider = PROVIDER) =>
  provider === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : !!process.env.OPENAI_API_KEY;

function getModel({ provider = PROVIDER, model = DEFAULT_MODEL, temperature = 0.2, maxTokens = 1500 }) {
  const cfg = { model, temperature, maxTokens, maxRetries: 3 };
  if (provider === "anthropic") return new ChatAnthropic(cfg);
  if (provider === "openai") return new ChatOpenAI(cfg);
  throw new Error(`Unknown LLM_PROVIDER "${provider}" (use openai|anthropic)`);
}

// One chat call → assistant text. LangChain handles provider auth (reads *_API_KEY) and retries.
export async function callText({ system, user, provider, model, temperature = 0.2, maxTokens = 1500 }) {
  const llm = getModel({ provider, model, temperature, maxTokens });
  const res = await llm.invoke([new SystemMessage(system), new HumanMessage(user)]);
  return typeof res.content === "string" ? res.content : res.content.map((c) => c.text || "").join("");
}

// Extract the first JSON object/array from model text (handles prose wrapping / ``` fences).
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) return JSON.parse(fenced[1]);
  const objStart = text.indexOf("{"), arrStart = text.indexOf("[");
  const start = arrStart >= 0 && (arrStart < objStart || objStart < 0) ? arrStart : objStart;
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  return JSON.parse(text.slice(start, end + 1));
}

export async function callJson(opts) { return parseJson(await callText(opts)); }

// Load an agent spec as a system prompt (single source of truth shared with Claude Code subagents).
// A plain LLM API call has no tools, so it can't "load skill X" or "read file Y" the way a Claude Code
// subagent does. The fix: RESOLVE those references here, at prompt-build time. A spec declares its static
// dependencies in frontmatter `context:` (a list of repo-relative paths — skills or docs); we read each and
// inline it. The spec stays Claude-Code-style (single source); the API receives a self-contained prompt.
// (Runtime data — the job text, the candidate profile, the CV — is still passed by the caller in the user
// message; `context:` is only for STATIC shared resources like a skill section or the enrich-spec.)
export async function loadAgentPrompt(name) {
  const md = await readFile(path.join(ROOT, ".claude", "agents", `${name}.md`), "utf8");
  const body = md.replace(/^---[\s\S]*?---\n?/, "").trim();
  const fm = md.match(/^---\n([\s\S]*?)\n---/);
  const refs = [];
  const ctx = fm && fm[1].match(/(?:^|\n)context:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/);
  if (ctx) for (const line of ctx[1].split("\n")) { const m = line.match(/-[ \t]*(.+\S)/); if (m) refs.push(m[1].trim()); }
  let out = body;
  for (const ref of refs) {
    try {
      const content = (await readFile(path.join(ROOT, ref), "utf8")).replace(/^---[\s\S]*?---\n?/, "").trim();
      out += `\n\n---\n# Referenced context: ${ref}\n\n${content}`;
    } catch (e) {
      out += `\n\n---\n# Referenced context: ${ref}\n\n(could not load: ${e.message})`;
    }
  }
  return out;
}
