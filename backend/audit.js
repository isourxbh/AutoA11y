import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { AxeBuilder } from "@axe-core/playwright";

// Run axe-core against a single local HTML file and return a flattened array
// of violations (the same shape as the GET /audit endpoint response).
// When a shared browser is supplied, it is reused (and not closed) so callers
// can audit many files concurrently.
export async function auditHtmlFile(filePath, sharedBrowser) {
  const browser = sharedBrowser ?? (await chromium.launch());
  try {
    const context = await browser.newContext();
    try {
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
      await context.close();
    }
  } finally {
    if (!sharedBrowser) await browser.close();
  }
}

// Expand a mix of file and directory paths into a deduped list of absolute
// HTML file paths. Directories are walked recursively for *.html / *.htm.
export function collectHtmlFiles(paths) {
  const found = new Set();

  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.html?$/i.test(entry.name)) found.add(full);
    }
  };

  for (const p of paths) {
    const abs = path.resolve(p);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      throw new Error(`Path not found: ${abs}`);
    }
    if (stat.isDirectory()) visit(abs);
    else found.add(abs);
  }

  return [...found];
}

// Audit many HTML files concurrently on a single shared browser (one isolated
// context per file) and return a combined report: [{ file, violations }].
export async function auditHtmlFiles(filePaths) {
  const browser = await chromium.launch();
  try {
    return await Promise.all(
      filePaths.map(async (file) => ({
        file,
        violations: await auditHtmlFile(file, browser),
      }))
    );
  } finally {
    await browser.close();
  }
}

// Screenshot specific elements (by CSS selector) in a local HTML file, one
// shared browser. Returns base64 PNG data URIs in the same order as selectors
// (null for elements that no longer exist).
export async function screenshotElements(filePath, selectors) {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 480, height: 480 } });
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.resolve(filePath)).href, {
      waitUntil: "load",
    });
    const results = [];
    for (const selector of selectors) {
      const el = await page.$(selector).catch(() => null);
      if (!el) {
        results.push(null);
        continue;
      }
      const buf = await el.screenshot();
      results.push(`data:image/png;base64,${buf.toString("base64")}`);
    }
    return results;
  } finally {
    await browser.close();
  }
}
