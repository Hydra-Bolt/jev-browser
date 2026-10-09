// Client for answering typed questions over a state object. Three backends, same return shape:
//  - Levanto Sage (default when LEVANTO_SAGE_API_KEY is set): the /decide/batch API, native yes/no,
//    choice and scale decisions with calibrated probabilities.
//  - OpenRouter (when OPENROUTER_API_KEY is set): a chat model is prompted to return
//    probabilities, emulating Jev's noul/choice/score answers.
//  - Typesafe System One (model: Jev), used when only TYPESAFE_API_KEY is set.
// Force one with JEV_PROVIDER=levanto|openrouter|typesafe. Answers are probabilities, never free text.
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const API_URL = process.env.JEV_API_URL || "https://api.typesafe.ai/v1/systemone";
export const MODEL = process.env.JEV_MODEL || "jev-latest";
const sleep = ms => new Promise(r => setTimeout(r, ms));

const OPENROUTER_URL = process.env.OPENROUTER_API_URL || "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_MODEL = process.env.JEV_OPENROUTER_MODEL || "google/gemini-2.5-flash";

const LEVANTO_URL = process.env.LEVANTO_SAGE_URL || "https://sage.levanto.ai";
const SCALE_MAX = 10; // jev "score" questions are 0..1; Sage scale levels 0..10 are divided back down

const keyCache = {};
function readKey(name) {
  if (keyCache[name]) return keyCache[name];
  if (process.env[name]) return (keyCache[name] = process.env[name]);
  // cwd, this package, then the parent repo (jev-browser lives inside TIEAGENT, whose .env holds OPENROUTER_API_KEY)
  for (const p of [resolve(process.cwd(), ".env"), resolve(ROOT, ".env"), resolve(ROOT, "..", ".env")]) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z_]+)\s*=\s*"?([^"\s]+)"?/);
      if (m && m[1] === name) return (keyCache[name] = m[2]);
    }
  }
  return undefined;
}

export function provider() {
  const forced = process.env.JEV_PROVIDER;
  if (forced === "levanto" || forced === "openrouter" || forced === "typesafe") return forced;
  if (readKey("LEVANTO_SAGE_API_KEY")) return "levanto";
  if (readKey("OPENROUTER_API_KEY")) return "openrouter";
  return "typesafe";
}

export function apiKey() {
  const p = provider();
  const name = p === "levanto" ? "LEVANTO_SAGE_API_KEY" : p === "openrouter" ? "OPENROUTER_API_KEY" : "TYPESAFE_API_KEY";
  const k = readKey(name);
  if (!k) throw new Error(`No API key: set ${name} in the environment or in .env`);
  return k;
}

const SYSTEM = `You answer typed questions about a JSON \`state\` object. You never write free text. Reply with ONE JSON object whose keys are the question names.
- type "noul": a yes/no question. Value: {"p": <probability the answer is yes, 0..1>}.
- type "score": a rating question. Value: {"p": <rating normalised to 0..1>}.
- type "choice": pick one option. The options are the keys of the question's "criteria" (a value, when not null, describes the option). Value: {"top": {"<option key>": <probability>, ...}} with the up to 5 most likely option keys, using keys exactly as given; probabilities should sum to about 1.
Be calibrated: use values near 0 or 1 only when the state makes the answer clear, and spread probability when it is ambiguous. Output JSON only.`;

const clamp01 = n => (Number.isFinite(+n) ? Math.min(1, Math.max(0, +n)) : NaN);

// Turn the model's raw JSON into the System One answer shape.
export function shapeAnswers(raw, questions) {
  const answers = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = raw?.[name];
    if (a == null) throw new Error(`model omitted answer "${name}"`);
    if (q.type === "choice") {
      const keys = Object.keys(q.criteria ?? {});
      const probabilities = Object.fromEntries(keys.map(k => [k, 0]));
      let sum = 0;
      for (const [k, v] of Object.entries(a.top ?? a.probabilities ?? {})) {
        const p = clamp01(v);
        if (k in probabilities && p === p) { probabilities[k] = p; sum += p; }
      }
      if (!sum) throw new Error(`model gave no valid option for "${name}"`);
      for (const k of keys) probabilities[k] /= sum;
      const choice = keys.reduce((b, k) => (probabilities[k] > probabilities[b] ? k : b), keys[0]);
      answers[name] = { choice, probabilities, confidence: probabilities[choice] };
    } else {
      const p = clamp01(a.p ?? a[q.type] ?? a);
      if (p !== p) throw new Error(`model gave a non-numeric answer for "${name}"`);
      answers[name] = q.type === "score" ? { score: p } : { noul: p };
    }
  }
  return answers;
}

function parseJson(text) {
  const t = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(t); } catch { /* fall through: take the outermost braces */ }
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) return JSON.parse(t.slice(i, j + 1));
  throw new Error("model reply was not JSON");
}

async function callOpenRouter(key, state, questions, timeout) {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "X-Title": "jev-browser" },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: JSON.stringify({ state, questions }) },
      ],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { res, body };
  const content = body.choices?.[0]?.message?.content;
  return { res, body, answers: shapeAnswers(parseJson(content), questions), tokens: body.usage?.prompt_tokens ?? 0 };
}

// Levanto Sage: one /decide/batch call, one content (the state), one decision per question.
async function callLevanto(key, state, questions, timeout) {
  const names = Object.keys(questions);
  const levels = Array.from({ length: SCALE_MAX + 1 }, (_, i) => ({ level: i }));
  const qs = names.map(name => {
    const q = questions[name];
    const base = { id: name, instructions: q.instructions };
    if (q.type === "choice") {
      return { ...base, kind: "choice", options: Object.entries(q.criteria ?? {}).map(([option, d]) => (d ? { option, description: d } : { option })) };
    }
    if (q.type === "score") return { ...base, kind: "scale", levels };
    return { ...base, kind: "yesno" };
  });
  const res = await fetch(`${LEVANTO_URL}/decide/batch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ content: JSON.stringify(state), questions: qs }] }),
    signal: AbortSignal.timeout(timeout),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { res, body };
  const out = body.results?.[0]?.answers ?? [];
  const answers = {};
  names.forEach((name, i) => {
    const a = out[i];
    if (!a?.ok) throw new Error(`Sage failed "${name}": ${JSON.stringify(a?.error ?? a).slice(0, 200)}`);
    const r = a.result.result, q = questions[name];
    if (q.type === "choice") {
      const probabilities = Object.fromEntries(Object.keys(q.criteria ?? {}).map(k => [k, 0]));
      for (const { option, probability } of r.probabilities ?? []) if (option in probabilities) probabilities[option] = probability;
      const keys = Object.keys(probabilities);
      // chosen is null on a near-tie; fall back to the most probable option
      const choice = r.chosen ?? keys.reduce((b, k) => (probabilities[k] > probabilities[b] ? k : b), keys[0]);
      answers[name] = { choice, probabilities, confidence: probabilities[choice] };
    } else if (q.type === "score") {
      answers[name] = { score: clamp01(r.expectation / SCALE_MAX) };
    } else {
      answers[name] = { noul: clamp01(r.probability) };
    }
  });
  return { res, body, answers, tokens: body.meta?.usage?.input_tokens ?? 0 };
}

// questions: { name: { type: "noul" | "choice" | "score", instructions, criteria? } }
export async function jev(state, questions, { retries = 2, timeout = 60_000 } = {}) {
  const key = apiKey();
  const prov = provider();
  const viaOpenRouter = prov === "openrouter";
  for (let attempt = 0; ; attempt++) {
    const t = performance.now();
    let res, body, answers, tokens;
    try {
      if (prov === "levanto") {
        ({ res, body, answers, tokens } = await callLevanto(key, state, questions, timeout));
      } else if (viaOpenRouter) {
        ({ res, body, answers, tokens } = await callOpenRouter(key, state, questions, timeout));
      } else {
        res = await fetch(API_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state, model: MODEL, questions }),
          signal: AbortSignal.timeout(timeout),
        });
        body = await res.json().catch(() => ({}));
        answers = body.answers; tokens = body.usage?.input_tokens ?? 0;
      }
    } catch (e) {
      if (attempt < retries) { await sleep(800 * (attempt + 1)); continue; }
      throw e;
    }
    const ms = Math.round(performance.now() - t);
    if (res.ok) return { answers, ms, tokens };
    if (attempt < retries && (res.status === 429 || res.status >= 500)) { await sleep(800 * (attempt + 1)); continue; }
    throw new Error(`${prov === "levanto" ? "Levanto Sage" : viaOpenRouter ? "OpenRouter" : "Jev"} ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
}
