import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The backend server (started by CI or locally) exposes GET /audit, which runs
// axe-core against demo-site/index.html and returns an array of violations.
const AUDIT_URL = process.env.AUDIT_URL || "http://localhost:3000/audit";
const REPORT_PATH = path.join(__dirname, "audit-report.md");
const RETRY_MS = 2000;
const MAX_WAIT_MS = Number(process.env.AUDIT_WAIT_MS || 60000);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getViolations() {
  const res = await fetch(AUDIT_URL);
  if (!res.ok) {
    throw new Error(`Audit endpoint returned HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!Array.isArray(data)) {
    throw new Error("Unexpected audit payload (expected an array of violations)");
  }
  return data;
}

// Wait for the backend server to come up (it takes a moment to bind the port
// and launch Chromium on the first audit).
async function waitForServer() {
  const deadline = Date.now() + MAX_WAIT_MS;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await getViolations();
    } catch (err) {
      lastError = err;
      await delay(RETRY_MS);
    }
  }
  throw new Error(
    `Backend server did not become ready: ${lastError?.message ?? "timeout"}`
  );
}

function truncate(text, max) {
  const t = String(text ?? "").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function formatReport(violations) {
  const lines = [];
  const n = violations.length;
  lines.push(`## ♿ Accessibility audit failed`);
  lines.push("");
  lines.push(
    `Found **${n} violation${n === 1 ? "" : "s"}** in \`demo-site/index.html\`.`
  );
  lines.push("");

  for (const v of violations) {
    lines.push(`### \`${v.id}\` — ${v.impact ?? "unknown"}`);
    lines.push(`**${v.help || v.description || ""}**`);
    if (v.helpUrl) lines.push(`- [Rule reference](${v.helpUrl})`);

    for (const node of v.nodes ?? []) {
      const selector = (node.selectors ?? []).join(" ");
      lines.push(`- Element: \`${selector}\``);
      if (node.html) {
        lines.push("  ```html");
        lines.push(`  ${node.html}`);
        lines.push("  ```");
      }
      if (node.failureSummary) {
        lines.push(`  How to fix: ${truncate(node.failureSummary.replace(/\n+/g, " "), 400)}`);
      }
    }
    lines.push("");
  }

  lines.push("<!-- autoa11y-audit -->");
  return lines.join("\n");
}

async function main() {
  const violations = await waitForServer();

  if (violations.length === 0) {
    console.log("✅ Accessibility audit passed — no violations found.");
    // Remove a stale report so a previous failure's comment is not reused.
    if (fs.existsSync(REPORT_PATH)) fs.rmSync(REPORT_PATH);
    return;
  }

  const report = formatReport(violations);
  console.log(report);
  fs.writeFileSync(REPORT_PATH, report);
  console.error(`\n❌ Found ${violations.length} accessibility violation(s).`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("audit-ci failed:", err.message);
  process.exitCode = 1;
});
