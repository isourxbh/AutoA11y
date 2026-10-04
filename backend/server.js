import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runFixerLoop } from './fixer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

// Absolute file:// URL to the demo page that gets audited.
const DEMO_PAGE = pathToFileURL(
  path.resolve(__dirname, '..', 'demo-site', 'index.html')
).href;

app.get('/audit', async (req, res) => {
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(DEMO_PAGE, { waitUntil: 'load' });

    const results = await new AxeBuilder({ page }).analyze();

    // Flatten axe results into a JSON-friendly array of violations.
    // Each node includes `selectors` (axe's `target` array), which are the
    // CSS selectors for the offending elements.
    const violations = results.violations.map((violation) => ({
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

    res.json(violations);
  } catch (error) {
    console.error('Audit failed:', error);
    res.status(500).json({ error: 'Audit failed', message: error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

let fixing = false;

app.post('/fix', async (req, res) => {
  if (fixing) {
    return res.status(409).json({ error: 'A fix is already in progress.' });
  }
  fixing = true;
  try {
    const result = await runFixerLoop();
    res.json({
      originalHtml: result.originalHtml,
      fixedHtml: result.fixedHtml,
      violations: result.violations,
      initialViolations: result.initialViolations,
      clean: result.clean,
      iterations: result.iterations,
    });
  } catch (error) {
    console.error('Fix failed:', error);
    res.status(500).json({ error: 'Fix failed', message: error.message });
  } finally {
    fixing = false;
  }
});

app.listen(PORT, () => {
  console.log(`autoa11y backend listening on http://localhost:${PORT}`);
  console.log(`Audit endpoint:  http://localhost:${PORT}/audit`);
  console.log(`Fix endpoint:    http://localhost:${PORT}/fix`);
});
