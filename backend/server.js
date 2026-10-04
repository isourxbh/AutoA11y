import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import { runFixerLoop } from './fixer.js';
import { auditHtmlFile } from './audit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_HTML = path.resolve(__dirname, '..', 'demo-site', 'index.html');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());

app.get('/audit', async (req, res) => {
  try {
    const violations = await auditHtmlFile(DEMO_HTML);
    res.json(violations);
  } catch (error) {
    console.error('Audit failed:', error);
    res.status(500).json({ error: 'Audit failed', message: error.message });
  }
});

let fixing = false;
let lastAuditResult = null; // { initialViolations, violations, clean, timestamp }

app.post('/fix', async (req, res) => {
  if (fixing) {
    return res.status(409).json({ error: 'A fix is already in progress.' });
  }
  fixing = true;

  // demo-site/index.html is our read-only test page — audit and fix a temp
  // copy instead so the demo stays broken.
  const tempFile = path.join(
    os.tmpdir(),
    `autoa11y-fix-${Date.now()}-${Math.random().toString(36).slice(2)}.html`
  );

  try {
    await fs.promises.copyFile(DEMO_HTML, tempFile);
    const result = await runFixerLoop(undefined, { targetFile: tempFile });
    lastAuditResult = {
      initialViolations: result.initialViolations,
      violations: result.violations,
      clean: result.clean,
      timestamp: new Date(),
    };
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
    await fs.promises.rm(tempFile, { force: true }).catch(() => {});
    fixing = false;
  }
});

app.get('/report', (req, res) => {
  if (!lastAuditResult) {
    return res.status(404).json({ error: 'No audit results yet. Run a fix first.' });
  }

  const { initialViolations, violations, timestamp } = lastAuditResult;
  const compliant = violations === 0;

  const doc = new PDFDocument({ size: 'A4', margin: 60 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="autoa11y-compliance-report.pdf"');
  doc.pipe(res);

  // Title
  doc.font('Helvetica-Bold').fontSize(22).text('AutoA11y Compliance Report', { align: 'center' });
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(10).fillColor('#666666').text(`Generated: ${timestamp.toISOString()}`, { align: 'center' });
  doc.fillColor('#000000');
  doc.moveDown(2);

  // Audit summary
  doc.font('Helvetica-Bold').fontSize(14).text('Accessibility Audit Summary');
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(12);
  doc.text(`Violations before fix: ${initialViolations}`);
  doc.text(`Violations after fix:  ${violations}`);
  doc.moveDown(2);

  // Compliance certification
  doc.font('Helvetica-Bold').fontSize(14).text('Compliance Certification');
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(12);
  doc.text(
    compliant
      ? 'Certified: this web page complies with the Guidelines for Indian Government Websites (GIGW) 3.0 and the Rights of Persons with Disabilities (RPwD) Act, 2016.'
      : `Not yet compliant: this web page does not fully meet GIGW 3.0 and RPwD Act, 2016 guidelines — ${violations} accessibility violation(s) remain.`
  );

  doc.end();
});

app.listen(PORT, () => {
  console.log(`autoa11y backend listening on http://localhost:${PORT}`);
  console.log(`Audit endpoint:  http://localhost:${PORT}/audit`);
  console.log(`Fix endpoint:    http://localhost:${PORT}/fix`);
  console.log(`Report endpoint: http://localhost:${PORT}/report`);
});
