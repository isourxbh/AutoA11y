import { Agent, createBuiltinTools, createTool, getValidClineCredentials } from "@cline/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditHtmlFile, screenshotElements } from "./audit.js";
import { validateChange } from "./guard.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = path.resolve(__dirname, "..");
const DEMO_HTML = path.resolve(REPO_ROOT, "demo-site", "index.html");

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS || 5);

const CLINE_PROVIDERS_PATH = path.join(
  os.homedir(),
  ".cline",
  "data",
  "settings",
  "providers.json"
);

// ---- In-memory run state (sandboxed fix runs) ----
const runs = new Map();

function createRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getRun(runId) {
  return runs.get(runId);
}

// Copy the target's whole directory (siblings + assets) into a fresh sandbox
// so the agent works on a copy and the original is never touched mid-run.
function createSandbox(targetFile) {
  const sandboxPath = fs.mkdtempSync(path.join(os.tmpdir(), "autoa11y-"));
  fs.cpSync(path.dirname(targetFile), sandboxPath, { recursive: true });
  const sandboxTarget = path.join(sandboxPath, path.basename(targetFile));
  return { sandboxPath, sandboxTarget };
}

// Human approval step: overwrite the original file with the sandboxed result.
export async function applyRun(runId) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== "completed") {
    throw new Error(
      `Run ${runId} is not completed (status: ${run.status}); nothing to apply.`
    );
  }
  await fs.promises.copyFile(run.sandboxTarget, run.targetFile);
  run.status = "applied";
  return run;
}

/**
 * Load Cline account credentials from the Cline CLI data directory.
 *
 * Prefers the active `cline-pass` provider (if present), falling back to
 * `cline`. Validates - and refreshes if needed - the OAuth token via the
 * SDK's `getValidClineCredentials` helper.
 *
 * @returns {{ providerId, modelId, apiKey, baseUrl }} or null
 */
async function loadClineCredentials() {
  let data;
  try {
    data = JSON.parse(await fs.promises.readFile(CLINE_PROVIDERS_PATH, "utf8"));
  } catch {
    return null;
  }

  const now = Date.now();

  // Gather every Cline provider that has an OAuth token. Tokens can live under
  // "cline" (account) or "cline-pass" (subscription), and either one may be
  // fresher than the other depending on which flow refreshed last.
  const candidates = ["cline-pass", "cline"]
    .map((id) => ({ id, settings: data.providers?.[id]?.settings }))
    .filter((c) => c.settings?.auth?.accessToken);

  if (candidates.length === 0) return null;

  // Prefer a non-expired token; among equals, the one expiring latest.
  const chosen = candidates.reduce((best, c) => {
    const bestExp = Number(best.settings.auth.expiresAt) || 0;
    const cExp = Number(c.settings.auth.expiresAt) || 0;
    const bestValid = bestExp > now;
    const cValid = cExp > now;
    if (cValid !== bestValid) return cValid ? c : best;
    return cExp > bestExp ? c : best;
  });

  const auth = chosen.settings.auth;
  const expired = (Number(auth.expiresAt) || 0) <= now;

  // Prefer the Cline Pass model if configured; fall back to the chosen entry.
  const modelId =
    data.providers?.["cline-pass"]?.settings?.model ||
    chosen.settings.model ||
    "cline-pass/deepseek-v4-pro";

  const credentials = {
    access: auth.accessToken,
    refresh: auth.refreshToken,
    expires: Number(auth.expiresAt) || 0,
    accountId: auth.accountId,
    metadata: auth.metadata,
  };

  try {
    const valid = await getValidClineCredentials(
      credentials,
      { apiBaseUrl: "https://api.cline.bot" },
      { forceRefresh: expired }
    );

    if (!valid) {
      console.warn(
        "Cline credentials could not be validated (re-auth may be required)."
      );
      return null;
    }

    // The Cline gateway expects the "workos:" token prefix. The SDK's refresh
    // path can return the raw JWT without it, so re-add it if it's missing.
    const apiKey = valid.access.startsWith("workos:")
      ? valid.access
      : `workos:${valid.access}`;

    return {
      providerId: "cline-pass",
      modelId,
      apiKey,
      baseUrl: "https://api.cline.bot/api/v1",
    };
  } catch (err) {
    console.warn("Failed to validate Cline credentials:", err.message);
    return null;
  }
}

function buildSystemPrompt(sandboxDir, targetFile) {
  return [
    "You are an accessibility auto-fixer.",
    "Your job is to eliminate accessibility violations reported by an axe-core audit.",
    "",
    `You are working inside an isolated sandbox directory: ${sandboxDir}`,
    `The single file you are allowed to modify is: ${targetFile}`,
    "You may READ other files in the sandbox (images, CSS) but you may only EDIT",
    "the target HTML file. Never read or edit anything outside this sandbox —",
    "especially not the project's backend/ or demo-site/ directories.",
    "",
    "Work like this:",
    "  1. Read the target file first so you see its current contents.",
    "  2. Apply targeted edits that fix EVERY reported violation.",
    "  3. Do not change anything that is unrelated to accessibility.",
    "",
    "Rules:",
    "  - Fixes must be real accessibility fixes (add alt text, provide a label,",
    "    give buttons discernible text, raise color contrast), not hacks.",
    "  - Never use alt=\"\" (that marks an image as decorative). Write a meaningful",
    "    description instead.",
    "  - Never delete elements, hide them (aria-hidden, role=presentation,",
    "    display:none, visibility:hidden, tabindex=-1), or rewrite visible text.",
    "  - You may call run_audit to verify your own work, but it is optional.",
    "  - When you believe the file is fixed, stop without making further edits.",
    "",
    "Evidence & honesty (required):",
    "  - ONLY write an accessible name or alt if something in the file backs it",
    "    up: visible text, nearby headings, href, id/name, title, the surrounding",
    "    form, or the table row. A filename alone is weak — treat it as 'inferred'.",
    "  - Call record_fix for EVERY change you make, quoting the evidence.",
    "  - Use confidence 'proven' for unambiguous evidence (href, id, name, title,",
    "    visible text); use 'inferred' for weak clues (filename alone).",
    "  - ALWAYS call ask_human (never invent a name) for:",
    "      * icon-only controls with no textual clue anywhere",
    "      * informative images you cannot see (maps, charts, photos)",
    "      * mixed-language content where the right language is unclear",
    "      * any captcha",
    "  - ask_human questions are for a non-technical site owner (a panchayat",
    "    official): plain words, no jargon, in the page's main language, with",
    "    questionEnglish as the English version. Give up to 3 suggested answers.",
    "  - When ask_human queues a question, do exactly what the tool's reply says:",
    "    add the data-autoa11y-pending attribute and the temporary accessible",
    "    name 'Pending owner review', then continue with other violations.",
    "",
    "Language & localization (required for compliance):",
    "  - Before writing ANY replacement text (alt text, labels, button names),",
    "    analyze the surrounding content to detect the page's language.",
    "  - If the page is in a regional Indian language such as Hindi, generate the",
    "    new text in THAT language, never in English.",
    "  - Example: for a Hindi page, an image's alt attribute must be written in",
    "    Hindi (Devanagari script), matching the language of the surrounding text.",
  ].join("\n");
}

// Custom tool: run an axe-core audit against the target file so the agent can
// verify its own work.
function createRunAuditTool(targetFile) {
  return createTool({
    name: "run_audit",
    description:
      "Run the axe-core accessibility audit against the target HTML file and return the JSON array of violations. An empty array means the page passes the audit.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async () => {
      return await auditHtmlFile(targetFile);
    },
  });
}

// Custom tool: record a fix with the evidence that justifies the name.
function createRecordFixTool(state) {
  return createTool({
    name: "record_fix",
    description:
      "Record an accessibility fix you made, with the evidence that justifies the accessible name you chose. Call this for EVERY change.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element" },
        rule: { type: "string", description: "axe rule id, e.g. button-name" },
        change: { type: "string", description: "What you changed" },
        evidence: { type: "string", description: "Quote where the meaning came from" },
        confidence: { type: "string", enum: ["proven", "inferred"] },
      },
      required: ["selector", "rule", "change", "evidence", "confidence"],
      additionalProperties: false,
    },
    execute: async (input) => {
      state.findings.push({ ...input, at: new Date().toISOString() });
      return { recorded: true };
    },
  });
}

// Custom tool: ask the site owner to resolve an ambiguous element.
function createAskHumanTool(state) {
  return createTool({
    name: "ask_human",
    description:
      "Ask the site owner to clarify the meaning of an element you cannot determine from the code. Use for icon-only controls with no clues, unseen informative images (maps/charts/photos), mixed-language ambiguity, and captchas.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector of the element" },
        rule: { type: "string", description: "axe rule id" },
        question: { type: "string", description: "In the page's main language, plain words" },
        questionEnglish: { type: "string", description: "English version" },
        whyUnknowable: { type: "string", description: "Why you cannot determine it" },
        suggestedAnswers: {
          type: "array",
          items: { type: "string" },
          maxItems: 3,
        },
      },
      required: ["selector", "rule", "question", "questionEnglish", "whyUnknowable", "suggestedAnswers"],
      additionalProperties: false,
    },
    execute: async (input) => {
      const id = `q_${state.questions.length + 1}_${Date.now().toString(36).slice(-4)}`;
      state.questions.push({
        id,
        ...input,
        status: "open",
        createdAt: new Date().toISOString(),
      });
      return (
        `Question ${id} queued. Add data-autoa11y-pending="${id}" to the element ` +
        `and give it the temporary accessible name 'Pending owner review'. ` +
        `Do not invent a meaning. Continue with other violations.`
      );
    },
  });
}

// Built-in file tools (read_files, editor, apply_patch) scoped to the sandbox
// directory so the agent cannot reach backend/ or demo-site/.
function createFileTools(sandboxDir) {
  return createBuiltinTools({
    cwd: sandboxDir,
    enableReadFiles: true,
    enableEditor: true,
    enableApplyPatch: true,
    enableSearch: false,
    enableBash: false,
    enableWebFetch: false,
    enableSkills: false,
    enableAskQuestion: false,
    enableSubmitAndExit: false,
  });
}

export async function createAgent({ sandboxDir, targetFile, state }) {
  const systemPrompt = buildSystemPrompt(sandboxDir, targetFile);
  const runAuditTool = createRunAuditTool(targetFile);
  const recordFixTool = createRecordFixTool(state);
  const askHumanTool = createAskHumanTool(state);
  const fileTools = createFileTools(sandboxDir);

  console.log(`Agent file tools cwd: ${sandboxDir}`);

  // 1. Explicit env credentials take priority.
  const envKey =
    process.env.CLINE_API_KEY || process.env.ANTHROPIC_API_KEY;
  if (envKey) {
    return new Agent({
      providerId: process.env.CLINE_PROVIDER || "anthropic",
      modelId: process.env.CLINE_MODEL || "claude-sonnet-4-20250514",
      apiKey: envKey,
      systemPrompt,
      tools: [runAuditTool, recordFixTool, askHumanTool, ...fileTools],
      maxIterations: 25,
    });
  }

  // 2. Fall back to Cline account credentials (extension / Cline Pass).
  const clineCreds = await loadClineCredentials();
  if (clineCreds) {
    console.log(
      `Using Cline account: provider=${clineCreds.providerId} model=${clineCreds.modelId}`
    );
    return new Agent({
      providerId: clineCreds.providerId,
      modelId: clineCreds.modelId,
      apiKey: clineCreds.apiKey,
      baseUrl: clineCreds.baseUrl,
      systemPrompt,
      tools: [runAuditTool, recordFixTool, askHumanTool, ...fileTools],
      maxIterations: 25,
    });
  }

  throw new Error(
    "No API credentials found. Set ANTHROPIC_API_KEY / CLINE_API_KEY, " +
      "or log in with the Cline CLI (`cline login`)."
  );
}

function summarize(violations) {
  return violations
    .map((v) => `${v.id} (${v.impact})`)
    .join(", ");
}

function buildPrompt(violations, targetFile, state) {
  const lines = [
    "The latest accessibility audit reported these violations:",
    "",
    JSON.stringify(violations, null, 2),
    "",
    `Fix them by editing ${targetFile}. Read the file first, then apply`,
    "targeted edits that resolve every violation. Do not change anything",
    "unrelated to accessibility. You may call run_audit to verify your work,",
    "but it is optional. When you are done, stop.",
  ];

  if (state.guardRejections.length > 0) {
    const last = state.guardRejections[state.guardRejections.length - 1];
    lines.push(
      "",
      "Your previous changes were REJECTED by the guard for these reasons:",
      ...last.reasons.map((r) => `  - ${r}`),
      "The file was reverted. Try a different, compliant approach."
    );
  }

  return lines.join("\n");
}

export async function runFixerLoop(targetFile, options = {}) {
  const { onAgent } = options;

  // 1. Fresh sandbox with a copy of the target + its siblings/assets.
  const { sandboxPath, sandboxTarget } = createSandbox(targetFile);

  const runId = createRunId();
  const originalHtml = await fs.promises.readFile(targetFile, "utf8");
  const state = {
    runId,
    targetFile,
    sandboxPath,
    sandboxTarget,
    originalHtml,
    fixedHtml: null,
    findings: [],
    questions: [],
    counts: {
      before: { rules: 0, instances: 0 },
      after: { rules: 0, instances: 0 },
    },
    status: "running",
    guardRejections: [],
    iterations: 0,
  };
  runs.set(runId, state);

  console.log(`📦 Sandbox: ${sandboxPath}`);

  const agent = await createAgent({
    sandboxDir: sandboxPath,
    targetFile: sandboxTarget,
    state,
  });
  onAgent?.(agent);

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    state.iterations = iteration;
    console.log(`\n=== Fixer iteration ${iteration}/${MAX_ITERATIONS} ===`);

    const violations = await auditHtmlFile(sandboxTarget);
    if (!Array.isArray(violations)) {
      throw new Error("Audit returned an unexpected payload");
    }

    const rules = violations.length;
    const instances = violations.reduce(
      (sum, v) => sum + (Array.isArray(v.nodes) ? v.nodes.length : 0),
      0
    );
    if (iteration === 1) state.counts.before = { rules, instances };
    state.counts.after = { rules, instances };

    if (rules === 0) {
      state.status = "completed";
      state.fixedHtml = await fs.promises.readFile(sandboxTarget, "utf8");
      await attachQuestionScreenshots(state);
      console.log("✅ Audit is clean. No accessibility violations remain.");
      return state;
    }

    console.log(
      `Found ${rules} rule(s) / ${instances} instance(s): ${summarize(violations)}`
    );

    const beforeRunHtml = await fs.promises.readFile(sandboxTarget, "utf8");
    const prompt = buildPrompt(violations, sandboxTarget, state);

    try {
      const result = await agent.run(prompt);
      console.log(
        `Agent run finished: status=${result.status}, agentIterations=${result.iterations}`
      );
      if (result.error) {
        console.error(`Agent reported an error: ${result.error.message}`);
      }
      if (result.outputText) {
        console.log(`Agent output:\n${result.outputText}`);
      }
    } catch (err) {
      console.error(`Agent run failed: ${err.message}`);
      continue;
    }

    // Guard the change: reject cheating fixes, restore the file if rejected.
    const afterRunHtml = await fs.promises.readFile(sandboxTarget, "utf8");
    const validation = validateChange(beforeRunHtml, afterRunHtml);
    if (!validation.ok) {
      console.log(`🛡️ Guard rejected ${validation.reasons.length} change(s):`);
      for (const r of validation.reasons) console.log(`   - ${r}`);
      await fs.promises.writeFile(sandboxTarget, beforeRunHtml);
      state.guardRejections.push({ iteration, reasons: validation.reasons });
      continue;
    }
  }

  state.status = "failed";
  state.fixedHtml = await fs.promises.readFile(sandboxTarget, "utf8");
  await attachQuestionScreenshots(state);
  console.error(
    `❌ Reached the hard cap of ${MAX_ITERATIONS} iterations without a clean audit.`
  );
  return state;
}

// Attach base64 element screenshots to each open question (idempotent).
async function attachQuestionScreenshots(run) {
  const open = run.questions.filter((q) => q.status === "open" && !q.screenshot);
  if (open.length === 0) return;
  const selectors = open.map((q) => `[data-autoa11y-pending="${q.id}"]`);
  const shots = await screenshotElements(run.sandboxTarget, selectors);
  open.forEach((q, i) => {
    q.screenshot = shots[i];
  });
}

// Apply the site owner's answers: re-run the agent on the same sandbox.
export async function answerRunQuestions(runId, answers) {
  const run = runs.get(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status === "running") {
    throw new Error(`Run ${runId} is still running.`);
  }

  const answerMap = new Map(answers.map((a) => [a.questionId, a.answer]));
  for (const q of run.questions) {
    if (answerMap.has(q.id)) {
      q.status = "answered";
      q.answer = answerMap.get(q.id);
    }
  }

  const lines = ["The site owner answered these pending questions:", ""];
  for (const a of answers) {
    const q = run.questions.find((x) => x.id === a.questionId);
    lines.push(`- ${a.questionId}${q ? ` (${q.rule})` : ""}: ${a.answer}`);
  }
  lines.push(
    "",
    "For EACH answer:",
    "  1. Find the element with the matching data-autoa11y-pending attribute.",
    "  2. Replace its temporary accessible name 'Pending owner review' with the",
    "     owner's answer (alt for images, aria-label for icon buttons/links, a",
    "     <label> or visible text where a control needs it).",
    "  3. Remove the data-autoa11y-pending attribute.",
    `  4. Call record_fix with confidence "proven" and evidence "Owner answer: <answer>".`,
    "  5. When all are applied, call run_audit to confirm the audit is clean.",
    "",
    "Do not invent anything beyond what the owner answered."
  );

  const agent = await createAgent({
    sandboxDir: run.sandboxPath,
    targetFile: run.sandboxTarget,
    state: run,
  });

  let rejected = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const beforeHtml = await fs.promises.readFile(run.sandboxTarget, "utf8");
    const result = await agent.run(lines.join("\n"));
    if (result.error) {
      console.error(`Agent reported an error: ${result.error.message}`);
    }
    if (result.outputText) {
      console.log(`Agent output:\n${result.outputText}`);
    }

    const afterHtml = await fs.promises.readFile(run.sandboxTarget, "utf8");
    const validation = validateChange(beforeHtml, afterHtml);
    if (validation.ok) {
      rejected = false;
      break;
    }
    console.log(`🛡️ Guard rejected answer application:`);
    for (const r of validation.reasons) console.log(`   - ${r}`);
    await fs.promises.writeFile(run.sandboxTarget, beforeHtml);
    run.guardRejections.push({ phase: "answers", reasons: validation.reasons });
    rejected = true;
  }

  const violations = await auditHtmlFile(run.sandboxTarget);
  const rules = violations.length;
  const instances = violations.reduce(
    (sum, v) => sum + (Array.isArray(v.nodes) ? v.nodes.length : 0),
    0
  );
  run.counts.after = { rules, instances };
  run.fixedHtml = await fs.promises.readFile(run.sandboxTarget, "utf8");
  run.status = rules === 0 && !rejected ? "completed" : "failed";

  return run;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  (async () => {
    const result = await runFixerLoop(DEMO_HTML);
    if (result.status !== "completed") {
      process.exitCode = 1;
    }
  })().catch((err) => {
    console.error("fixer failed:", err);
    process.exitCode = 1;
  });
}

export { DEMO_HTML };
