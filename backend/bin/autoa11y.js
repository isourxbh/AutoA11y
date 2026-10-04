#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runFixerLoop, applyRun } from "../fixer.js";
import { auditHtmlFiles, collectHtmlFiles } from "../audit.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) =>
  useColor ? `\x1b[${code}m${text}\x1b[0m` : `${text}`;
const red = (t) => paint(31, t);
const green = (t) => paint(32, t);
const yellow = (t) => paint(33, t);
const cyan = (t) => paint(36, t);
const dim = (t) => paint(2, t);
const bold = (t) => paint(1, t);

function printUsage() {
  console.log(`${bold("autoa11y")} — accessibility auto-fixer CLI (Cline SDK)`);
  console.log("");
  console.log("Usage:");
  console.log("  autoa11y fix <file_path>         Fix accessibility issues in an HTML file");
  console.log("  autoa11y audit <path...>         Scan files/directories for violations");
  console.log("");
  console.log("Examples:");
  console.log("  autoa11y fix ./demo-site/index.html");
  console.log("  autoa11y audit ./demo-site");
  console.log("  autoa11y audit page.html other.html ./more-pages");
}

async function fix(fileArg) {
  const targetFile = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(targetFile)) {
    throw new Error(`File not found: ${targetFile}`);
  }
  const demoPath = path.resolve(__dirname, "..", "..", "demo-site", "index.html");
  if (targetFile === demoPath) {
    throw new Error(
      "Refusing to fix demo-site/index.html (our read-only test page). Copy it first."
    );
  }

  console.log(bold("AutoA11y fixer"));
  console.log(`${dim("Target:")} ${targetFile}`);
  console.log("");

  let unsubscribe = null;
  const result = await runFixerLoop(targetFile, {
    onAgent: (agent) => {
      unsubscribe = agent.subscribe((event) => {
        if (event.type === "tool-started" && event.toolCall?.toolName) {
          console.log(`  ${dim("⚙️")} ${cyan(event.toolCall.toolName)}`);
        }
      });
    },
  });
  unsubscribe?.();

  console.log("");
  console.log(bold("Summary"));
  console.log(
    `  ${dim("Before:")} ${red(String(result.counts.before.instances))} instances (${result.counts.before.rules} rules)`
  );
  console.log(
    `  ${dim("After: ")} ${green(String(result.counts.after.instances))} instances (${result.counts.after.rules} rules)`
  );

  if (result.status === "completed") {
    console.log("");
    console.log(green(bold("✅ All accessibility issues fixed (in sandbox).")));
    await applyRun(result.runId);
    console.log(green(`Applied to ${targetFile}`));
  } else {
    console.log("");
    console.log(
      yellow(
        bold(
          `⚠️  ${result.counts.after.instances} instance(s) remain after ${result.iterations} iteration(s).`
        )
      )
    );
    process.exitCode = 1;
  }
}

async function audit(paths) {
  const htmlFiles = collectHtmlFiles(paths);
  if (htmlFiles.length === 0) {
    console.log(yellow("No HTML files found."));
    return;
  }

  console.log(bold("AutoA11y audit"));
  console.log(`${dim("Scanning")} ${htmlFiles.length} file(s) in parallel...`);
  console.log("");

  const results = await auditHtmlFiles(htmlFiles);

  let total = 0;
  for (const { file, violations } of results) {
    total += violations.length;
    const mark = violations.length === 0 ? green("✓") : red("✗");
    const countText =
      violations.length === 0
        ? green("clean")
        : red(
            `${violations.length} violation${violations.length === 1 ? "" : "s"}`
          );
    console.log(`  ${mark} ${file} — ${countText}`);
    for (const v of violations) {
      console.log(
        `      ${cyan(v.id)} (${v.impact ?? "unknown"}): ${
          v.help || v.description || ""
        }`
      );
    }
  }

  console.log("");
  console.log(bold("Combined report"));
  console.log(`  ${dim("Files scanned:")} ${htmlFiles.length}`);
  console.log(
    `  ${dim("Total violations:")} ${
      total === 0 ? green(String(total)) : red(String(total))
    }`
  );

  if (total > 0) process.exitCode = 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "fix" && rest.length === 1) {
    await fix(rest[0]);
  } else if (command === "audit" && rest.length >= 1) {
    await audit(rest);
  } else {
    printUsage();
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${red("error:")} ${err.message}`);
  process.exitCode = 1;
});
