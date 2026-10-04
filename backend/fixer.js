import { Agent, createBuiltinTools, createTool, getValidClineCredentials } from "@cline/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditHtmlFile } from "./audit.js";
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
    "  - Prefer aria-label for icon-only buttons/links and <label> for inputs.",
    "  - You may call run_audit to verify your own work, but it is optional.",
    "  - When you believe the file is fixed, stop without making further edits.",
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

export async function createAgent({ sandboxDir, targetFile }) {
  const systemPrompt = buildSystemPrompt(sandboxDir, targetFile);
  const runAuditTool = createRunAuditTool(targetFile);
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
      tools: [runAuditTool, ...fileTools],
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
      tools: [runAuditTool, ...fileTools],
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
    state.findings = violations;
    if (iteration === 1) state.counts.before = { rules, instances };
    state.counts.after = { rules, instances };

    if (rules === 0) {
      state.status = "completed";
      state.fixedHtml = await fs.promises.readFile(sandboxTarget, "utf8");
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
  console.error(
    `❌ Reached the hard cap of ${MAX_ITERATIONS} iterations without a clean audit.`
  );
  return state;
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
