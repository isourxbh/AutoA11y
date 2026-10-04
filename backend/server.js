import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import PDFDocument from 'pdfkit';
import { runFixerLoop, getRun, applyRun, answerRunQuestions } from './fixer.js';
import { auditHtmlFile } from './audit.js';
import { screenReaderTranscript, keyboardWalk } from './experience.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_HTML = path.resolve(__dirname, '..', 'demo-site', 'index.html');

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

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
  try {
    // runFixerLoop sandboxes the demo itself — the original is never touched.
    const state = await runFixerLoop(DEMO_HTML);
    lastAuditResult = {
      initialViolations: state.counts.before.instances,
      violations: state.counts.after.instances,
      clean: state.status === 'completed',
      timestamp: new Date(),
    };
    res.json({
      runId: state.runId,
      status: state.status,
      originalHtml: state.originalHtml,
      fixedHtml: state.fixedHtml,
      counts: state.counts,
      findings: state.findings,
      questions: state.questions,
      guardRejections: state.guardRejections,
      iterations: state.iterations,
    });
  } catch (error) {
    console.error('Fix failed:', error);
    res.status(500).json({ error: 'Fix failed', message: error.message });
  } finally {
    fixing = false;
  }
});

app.get('/runs/:runId', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: `Run not found: ${req.params.runId}` });
  }
  res.json({
    runId: run.runId,
    status: run.status,
    originalHtml: run.originalHtml,
    fixedHtml: run.fixedHtml,
    counts: run.counts,
    findings: run.findings,
    questions: run.questions,
    guardRejections: run.guardRejections,
    iterations: run.iterations,
  });
});

app.post('/runs/:runId/apply', async (req, res) => {
  try {
    const run = await applyRun(req.params.runId);
    res.json({ runId: run.runId, status: run.status });
  } catch (error) {
    console.error('Apply failed:', error);
    res.status(400).json({ error: 'Apply failed', message: error.message });
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

app.post('/runs/:runId/answers', async (req, res) => {
  const { answers } = req.body || {};
  if (!Array.isArray(answers) || answers.length === 0) {
    return res
      .status(400)
      .json({ error: 'answers must be a non-empty array of { questionId, answer }' });
  }
  try {
    const run = await answerRunQuestions(req.params.runId, answers);
    res.json({
      runId: run.runId,
      status: run.status,
      counts: run.counts,
      findings: run.findings,
      questions: run.questions,
      fixedHtml: run.fixedHtml,
      guardRejections: run.guardRejections,
    });
  } catch (error) {
    console.error('Answers failed:', error);
    res.status(400).json({ error: 'Answers failed', message: error.message });
  }
});

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildSharePage(run) {
  const questions = (run.questions || []).filter((q) => q.status === "open");
  if (questions.length === 0) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>No pending questions</title></head><body><p>No pending questions.</p></body></html>`;
  }

  const fields = questions
    .map((q, i) => {
      const radios = (q.suggestedAnswers || [])
        .map(
          (ans) =>
            `<label class="opt"><input type="radio" name="${escapeHtml(q.id)}" value="${escapeHtml(ans)}"> <span>${escapeHtml(ans)}</span></label>`
        )
        .join("");
      const shot = q.screenshot
        ? `<img class="shot" src="${q.screenshot}" alt="Screenshot of the element for question ${i + 1}">`
        : "";
      return `
      <fieldset class="q">
        <legend><span class="lang">${escapeHtml(q.question)}</span><span class="en">${escapeHtml(q.questionEnglish)}</span></legend>
        ${shot}
        <div class="opts">${radios}</div>
        <label class="free-label" for="free_${escapeHtml(q.id)}">Other (your own words)</label>
        <input class="free" type="text" id="free_${escapeHtml(q.id)}" data-q="${escapeHtml(q.id)}">
      </fieldset>`;
    })
    .join("");

  return `<!doctype html>
<html lang="hi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Review accessibility questions</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 16px; background: #f4f4f5; color: #0f172a; }
  .wrap { max-width: 520px; margin: 0 auto; }
  h1 { font-size: 1.3rem; }
  fieldset.q { background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; margin: 16px 0; }
  legend { padding: 0 6px; }
  legend .lang { display: block; font-weight: 600; font-size: 1.05rem; }
  legend .en { display: block; color: #64748b; font-size: .9rem; margin-top: 4px; }
  img.shot { max-width: 100%; border: 1px solid #e2e8f0; border-radius: 6px; margin: 8px 0; }
  .opts label.opt { display: flex; gap: 10px; align-items: center; padding: 10px 0; }
  .opts input { width: 1.2em; height: 1.2em; }
  .free-label { display: block; margin-top: 8px; font-weight: 600; }
  input.free { width: 100%; padding: 10px; border: 1px solid #cbd5e1; border-radius: 6px; margin-top: 4px; font-size: 1rem; box-sizing: border-box; }
  button { width: 100%; padding: 14px; background: #4f46e5; color: #fff; border: 0; border-radius: 8px; font-size: 1rem; font-weight: 600; }
  button:focus-visible, input:focus-visible { outline: 3px solid #2563eb; outline-offset: 2px; }
  #status { margin-top: 12px; font-weight: 600; }
</style>
</head>
<body>
<div class="wrap">
<h1>Accessibility questions</h1>
<p>Please answer these so we can finish making this page accessible.</p>
<form id="form">${fields}<button type="submit">Submit answers</button></form>
<div id="status" role="status" aria-live="polite"></div>
</div>
<script>
const form = document.getElementById("form");
const status = document.getElementById("status");
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const answers = [];
  document.querySelectorAll("fieldset.q").forEach((fs) => {
    const free = fs.querySelector("input.free");
    const qid = free.dataset.q;
    const custom = free.value.trim();
    const radio = fs.querySelector("input[type=radio]:checked");
    const answer = custom || (radio ? radio.value : "");
    if (answer) answers.push({ questionId: qid, answer });
  });
  if (answers.length === 0) { status.textContent = "Please answer at least one question."; return; }
  status.textContent = "Submitting…";
  try {
    const res = await fetch("/runs/${run.runId}/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.message || res.status); }
    status.textContent = "Thank you! Your answers were submitted.";
    form.style.display = "none";
  } catch (err) {
    status.textContent = "Error: " + err.message;
  }
});
</script>
</body>
</html>`;
}

app.get('/runs/:runId/share', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).send('Run not found');
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(buildSharePage(run));
});

app.get('/runs/:runId/experience', async (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: `Run not found: ${req.params.runId}` });
  }
  try {
    const [beforeTranscript, afterTranscript, beforeKeyboard, afterKeyboard] = await Promise.all([
      screenReaderTranscript(run.targetFile),
      screenReaderTranscript(run.sandboxTarget),
      keyboardWalk(run.targetFile),
      keyboardWalk(run.sandboxTarget),
    ]);
    res.json({
      before: { transcript: beforeTranscript, keyboard: beforeKeyboard },
      after: { transcript: afterTranscript, keyboard: afterKeyboard },
    });
  } catch (error) {
    console.error('Experience failed:', error);
    res.status(500).json({ error: 'Experience failed', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`autoa11y backend listening on http://localhost:${PORT}`);
  console.log(`Audit endpoint:  http://localhost:${PORT}/audit`);
  console.log(`Fix endpoint:    http://localhost:${PORT}/fix`);
  console.log(`Runs endpoint:   http://localhost:${PORT}/runs/:runId`);
  console.log(`Share endpoint:  http://localhost:${PORT}/runs/:runId/share`);
  console.log(`Experience:      http://localhost:${PORT}/runs/:runId/experience`);
  console.log(`Report endpoint: http://localhost:${PORT}/report`);
  console.log(`CORS origin:     ${FRONTEND_ORIGIN}`);
});
