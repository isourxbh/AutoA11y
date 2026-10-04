import { Agent, createBuiltinTools, createTool, getValidClineCredentials } from "@cline/sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { auditHtmlFile } from "./audit.js";

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

function buildSystemPrompt(targetFile) {
  return [
    "You are an accessibility auto-fixer.",
    "Your job is to eliminate accessibility violations reported by an axe-core audit.",
    "",
    `The single file you are allowed to modify is: ${targetFile}`,
    "Work like this:",
    "  1. Read the file first so you see its current contents.",
    "  2. Apply targeted edits that fix EVERY reported violation.",
    "  3. Do not change anything that is unrelated to accessibility.",
    "",
    "Rules:",
    "  - Fixes must be real accessibility fixes (add alt text, provide a label,",
    "    give buttons discernible text, raise color contrast), not hacks.",
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

// Built-in file tools (read_files, editor, apply_patch) so the agent can
// inspect and patch the HTML. Everything else is disabled to keep the agent
// focused and avoid arbitrary shell/web access.
const fileTools = createBuiltinTools({
  cwd: REPO_ROOT,
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

export async function createAgent(targetFile = DEMO_HTML) {
  const systemPrompt = buildSystemPrompt(targetFile);
  const runAuditTool = createRunAuditTool(targetFile);

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

export async function runFixerLoop(agent, options = {}) {
  const { targetFile = DEMO_HTML } = options;
  if (!agent) agent = await createAgent(targetFile);

  const originalHtml = await fs.promises.readFile(targetFile, "utf8");
  let initialViolations = null;
  let finalViolations = null;

  for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
    console.log(`\n=== Fixer iteration ${iteration}/${MAX_ITERATIONS} ===`);

    const violations = await auditHtmlFile(targetFile);
    if (!Array.isArray(violations)) {
      throw new Error("Audit returned an unexpected payload");
    }

    if (iteration === 1) initialViolations = violations.length;
    finalViolations = violations.length;

    if (violations.length === 0) {
      console.log("✅ Audit is clean. No accessibility violations remain.");
      const fixedHtml = await fs.promises.readFile(targetFile, "utf8");
      return {
        clean: true,
        iterations: iteration,
        originalHtml,
        fixedHtml,
        initialViolations,
        violations: 0,
      };
    }

    console.log(
      `Found ${violations.length} violation(s): ${summarize(violations)}`
    );

    const prompt = [
      "The latest accessibility audit reported these violations:",
      "",
      JSON.stringify(violations, null, 2),
      "",
      `Fix them by editing ${targetFile}. Read the file first, then apply`,
      "targeted edits that resolve every violation. Do not change anything",
      "unrelated to accessibility. You may call run_audit to verify your work,",
      "but it is optional. When you are done, stop.",
    ].join("\n");

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
    }
  }

  console.error(
    `❌ Reached the hard cap of ${MAX_ITERATIONS} iterations without a clean audit.`
  );
  const fixedHtml = await fs.promises.readFile(targetFile, "utf8");
  return {
    clean: false,
    iterations: MAX_ITERATIONS,
    originalHtml,
    fixedHtml,
    initialViolations,
    violations: finalViolations,
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  (async () => {
    const agent = await createAgent();
    const result = await runFixerLoop(agent);
    if (!result.clean) {
      process.exitCode = 1;
    }
  })().catch((err) => {
    console.error("fixer failed:", err);
    process.exitCode = 1;
  });
}

export { DEMO_HTML };
