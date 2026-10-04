import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Run axe-core against a local HTML file and return a flattened array of
// violations (the same shape as the GET /audit endpoint response).
export async function auditHtmlFile(filePath) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.resolve(filePath)).href, {
      waitUntil: "load",
    });

    const results = await new AxeBuilder({ page }).analyze();

    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      description: violation.description,
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodes: violation.nodes.map((node) => ({
        html: node.html,
        selectors: node.target,
        failureSummary: node.failureSummary,
      })),
    }));
  } finally {
    await browser.close();
  }
}
