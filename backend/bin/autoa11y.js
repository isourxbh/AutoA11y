#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { createAgent, runFixerLoop } from "../fixer.js";

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
  console.log("  autoa11y fix <file_path>    Fix accessibility issues in an HTML file");
  console.log("");
  console.log("Example:");
  console.log("  autoa11y fix ./demo-site/index.html");
}

async function fix(fileArg) {
  const targetFile = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(targetFile)) {
    throw new Error(`File not found: ${targetFile}`);
  }

  console.log(bold("AutoA11y fixer"));
  console.log(`${dim("Target:")} ${targetFile}`);
  console.log("");

  const agent = await createAgent(targetFile);

  // Stream live tool activity to stdout while the agent works.
  const unsubscribe = agent.subscribe((event) => {
    if (event.type === "tool-started" && event.toolCall?.toolName) {
      console.log(`  ${dim("⚙️")} ${cyan(event.toolCall.toolName)}`);
    }
  });

  const result = await runFixerLoop(agent, { targetFile });
  unsubscribe();

  console.log("");
  console.log(bold("Summary"));
  console.log(
    `  ${dim("Violations before:")} ${red(String(result.initialViolations))}`
  );
  console.log(
    `  ${dim("Violations after: ")} ${green(String(result.violations))}`
  );

  if (result.clean) {
    console.log("");
    console.log(green(bold("✅ All accessibility issues fixed.")));
  } else {
    console.log("");
    console.log(
      yellow(
        bold(
          `⚠️  ${result.violations} violation(s) remain after ${result.iterations} iteration(s).`
        )
      )
    );
    process.exitCode = 1;
  }
}

async function main() {
  const [command, arg] = process.argv.slice(2);
  if (command === "fix" && arg) {
    await fix(arg);
  } else {
    printUsage();
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`${red("error:")} ${err.message}`);
  process.exitCode = 1;
});
