import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import PDFDocument from 'pdfkit';
import { startFix, getRun, applyRun, answerRunQuestions, subscribeToRun } from './fixer.js';
import { auditHtmlFile } from './audit.js';
import { screenReaderTranscript, keyboardWalk } from './experience.js';
import { wcagFor } from './wcag-map.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_HTML = path.resolve(__dirname, '..', 'demo-site', 'index.html');

// Embed GNU FreeSans so the report can render Devanagari (Hindi) as well as
// Latin. Fall back to pdfkit's built-in Helvetica if the font is absent.
const FREE_SANS = '/usr/share/fonts/truetype/freefont/FreeSans.ttf';
const FREE_SANS_BOLD = '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf';
const hasFreeSans = fs.existsSync(FREE_SANS) && fs.existsSync(FREE_SANS_BOLD);
const FONT = hasFreeSans ? 'FreeSans' : 'Helvetica';
const FONT_BOLD = hasFreeSans ? 'FreeSansBold' : 'Helvetica-Bold';

function registerReportFonts(doc) {
  if (hasFreeSans) {
    doc.registerFont('FreeSans', FREE_SANS);
    doc.registerFont('FreeSansBold', FREE_SANS_BOLD);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(cors({ origin: FRONTEND_ORIGIN }));
app.use(express.json());

// Accepts a zip upload (multipart field "zip") for static-site fixing.
const upload = multer({ dest: os.tmpdir() });

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

// Run the fixer against the demo, a URL, or an uploaded zip of a static site.
app.post('/fix', upload.single('zip'), async (req, res) => {
  if (fixing) {
    return res.status(409).json({ error: 'A fix is already in progress.' });
  }
  fixing = true;
  let input;
  try {
    if (req.file) {
      input = { mode: 'zip', zipPath: req.file.path };
    } else if (req.body?.url) {
      input = { mode: 'url', url: req.body.url };
    } else {
      input = { mode: 'demo' };
    }
    const state = await startFix(input);
    res.json({
      runId: state.runId,
      status: state.status,
      mode: state.mode,
      source: state.source,
      originalHtml: state.originalHtml,
    });
  } catch (error) {
    console.error('Fix failed:', error);
    res.status(500).json({ error: 'Fix failed', message: error.message });
  } finally {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    fixing = false;
  }
});

app.get('/runs/:runId/events', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: `Run not found: ${req.params.runId}` });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  res.write(': connected\n\n');

  const unsubscribe = subscribeToRun(run.runId, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', () => unsubscribe());
});

app.get('/runs/:runId', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: `Run not found: ${req.params.runId}` });
  }
  res.json({
    runId: run.runId,
    status: run.status,
    mode: run.mode,
    source: run.source,
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

// ---- Report helpers ----

function pageTitleOf(run) {
  const html = run.originalHtml || "";
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1]) return m[1].trim();
  return path.basename(run.targetFile || "");
}

function fmtDate(iso) {
  if (!iso) return "unknown";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function summaryOf(run) {
  const found = run.counts?.before?.instances ?? 0;
  const open = (run.questions || []).filter((q) => q.status === "open").length;
  const afterInstances = run.counts?.after?.instances ?? 0;
  const remaining = afterInstances + open;
  const resolved = Math.max(0, found - remaining);
  return { found, resolved, remaining, open };
}

// Simple 3-column table with wrapped text and horizontal separators.
function drawRuleTable(doc, rows) {
  const left = doc.page.margins.left;
  const cols = [
    { label: "axe rule", x: left, w: 120 },
    { label: "WCAG success criterion", x: left + 120, w: 240 },
    { label: "Status", x: left + 360, w: 95 },
  ];
  const total = cols.reduce((a, c) => a + c.w, 0);
  const pad = 5;

  const drawRow = (cells, bold) => {
    const startY = doc.y;
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 10 : 9);
    let maxH = 0;
    for (let i = 0; i < cols.length; i++) {
      const h = doc.heightOfString(cells[i] ?? "", { width: cols[i].w - pad * 2 });
      maxH = Math.max(maxH, h);
    }
    maxH += pad * 2;
    cols.forEach((col, i) => {
      doc.text(cells[i] ?? "", col.x + pad, startY + pad, { width: col.w - pad * 2 });
    });
    doc.y = startY + maxH;
    return startY + maxH;
  };

  drawRow(cols.map((c) => c.label), true);
  let y = doc.y + 2;
  doc.moveTo(left, y).lineTo(left + total, y).stroke();
  doc.y = y + 5;

  for (const r of rows) {
    const end = drawRow([r.rule, r.wcag, r.status], false);
    const sepY = end + 2;
    doc.moveTo(left, sepY).lineTo(left + total, sepY).stroke();
    doc.y = sepY + 4;
  }
  doc.y += 4;
}


app.get('/runs/:runId/report', async (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: `Run not found: ${req.params.runId}` });
  }

  const { found, resolved, remaining } = summaryOf(run);
  const afterRuleIds = new Set((run.violationsAfter || []).map((v) => v.id));
  const ruleRows = (run.violationsBefore || []).map((v) => ({
    rule: v.id,
    wcag: wcagFor(v.id),
    status: afterRuleIds.has(v.id) ? "Remaining" : "Resolved",
  }));

  let experience = null;
  try {
    const [bt, at, bk, ak] = await Promise.all([
      screenReaderTranscript(run.targetFile),
      screenReaderTranscript(run.sandboxTarget),
      keyboardWalk(run.targetFile),
      keyboardWalk(run.sandboxTarget),
    ]);
    experience = {
      before: { transcript: bt, keyboard: bk },
      after: { transcript: at, keyboard: ak },
    };
  } catch (err) {
    console.error("Experience failed for report:", err);
  }

  const doc = new PDFDocument({ size: "A4", margin: 60 });
  registerReportFonts(doc);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", 'attachment; filename="autoa11y-evidence-pack.pdf"');
  doc.pipe(res);

  doc.font(FONT_BOLD).fontSize(20).text("Accessibility Remediation Report", { align: "center" });
  doc.moveDown(0.3);
  doc.font(FONT).fontSize(10).fillColor("#555555");
  doc.text(`Page: ${pageTitleOf(run)}`, { align: "center" });
  doc.text(`Date: ${fmtDate(run.createdAt)}`, { align: "center" });
  doc.text(`Model: ${run.model || "unknown"}`, { align: "center" });
  doc.text(`Run ID: ${run.runId}`, { align: "center" });
  doc.fillColor("#000000");
  doc.moveDown(1.5);

  doc.font(FONT_BOLD).fontSize(13).text("Summary");
  doc.moveDown(0.3);
  doc.font(FONT).fontSize(11);
  doc.text(
    `Automated WCAG 2.2 A/AA checks: ${found} issues found, ${resolved} resolved, ${remaining} remaining.`
  );
  doc.moveDown(1.5);

  doc.font(FONT_BOLD).fontSize(13).text("axe rules → WCAG success criteria");
  doc.moveDown(0.3);
  if (ruleRows.length > 0) {
    drawRuleTable(doc, ruleRows);
  } else {
    doc.font(FONT).fontSize(10).text("No automated rules were recorded for this run.");
  }
  doc.moveDown(0.5);

  doc.font(FONT_BOLD).fontSize(13).text("Evidence log");
  doc.moveDown(0.3);
  doc.font(FONT).fontSize(9);
  const fixes = run.findings || [];
  const answers = (run.questions || []).filter((q) => q.status === "answered" && q.answeredAt);
  for (const f of fixes) {
    doc.text(`• ${f.selector} — ${f.change} — evidence: ${f.evidence} (${f.confidence})`);
  }
  for (const q of answers) {
    doc.text(`• Owner answer — ${q.question} → ${q.answer} (${fmtDate(q.answeredAt)})`);
  }
  if (fixes.length === 0 && answers.length === 0) {
    doc.text("No fixes or owner answers recorded.");
  }
  doc.moveDown(1);

  doc.font(FONT_BOLD).fontSize(13).text("Keyboard & screen reader experience");
  doc.moveDown(0.3);
  doc.font(FONT).fontSize(10);
  if (experience) {
    doc.text(
      `Keyboard: Before ${experience.before.keyboard.named} of ${experience.before.keyboard.total} controls reachable with a name. After ${experience.after.keyboard.named} of ${experience.after.keyboard.total}.`
    );
    doc.moveDown(0.5);
    doc.font(FONT_BOLD).fontSize(10).text("Screen reader transcript — before:");
    doc.font(FONT).fontSize(9);
    for (const line of experience.before.transcript) doc.text(`• ${line}`);
    doc.moveDown(0.4);
    doc.font(FONT_BOLD).fontSize(10).text("Screen reader transcript — after:");
    doc.font(FONT).fontSize(9);
    for (const line of experience.after.transcript) doc.text(`• ${line}`);
  } else {
    doc.text("Experience summary unavailable.");
  }
  doc.moveDown(1);

  doc.font(FONT_BOLD).fontSize(13).text("Manual checks still required");
  doc.moveDown(0.3);
  doc.font(FONT).fontSize(10);
  const manual = [
    "Focus order and keyboard navigation logic",
    "Captions and transcripts for audio/video content",
    "Reading order and DOM order consistency",
    "Documents and downloadable PDFs",
    "Time limits and session timeouts",
    "Error identification and suggestions on form submit",
    "Testing with real assistive technology users",
  ];
  for (const m of manual) doc.text(`• ${m}`);
  doc.moveDown(1);

  doc.font(FONT_BOLD).fontSize(11).text("Disclaimer");
  doc.moveDown(0.3);
  doc.font(FONT).fontSize(9).fillColor("#333333");
  doc.text(
    "Automated tools only catch a subset of accessibility issues. This report documents the automated remediation work performed on this page; it is not a certification of conformance with the Guidelines for Indian Government Websites (GIGW) 3.0 or the Rights of Persons with Disabilities (RPwD) Act, 2016. Manual and user testing are still required."
  );

  doc.end();
});

function buildStatementHtml(run) {
  const title = pageTitleOf(run);
  const date = fmtDate(run.createdAt ?? new Date().toISOString());
  const open = (run.questions || []).filter((q) => q.status === "open");
  const remaining = run.violationsAfter || [];

  const limitations = [];
  for (const q of open) limitations.push({ hi: q.question, en: q.questionEnglish });
  for (const v of remaining) limitations.push({ hi: v.help || v.description, en: v.help || v.description });

  const limEnHtml = limitations.length
    ? `<ul>${limitations.map((l) => `<li>${escapeHtml(l.en || l.hi)}</li>`).join("")}</ul>`
    : "<p>No known limitations at this time.</p>";
  const limHiHtml = limitations.length
    ? `<ul>${limitations.map((l) => `<li>${escapeHtml(l.hi || l.en)}</li>`).join("")}</ul>`
    : "<p>कोई ज्ञात सीमाएँ नहीं।</p>";

  return `<!doctype html>
<html lang="hi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility Statement / अभिगम्यता विवरण</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #fff; color: #0f172a; line-height: 1.6; }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 1.5rem; }
  h2 { font-size: 1.15rem; margin-top: 1.5em; }
  h3 { font-size: 1rem; margin-top: 1.2em; }
  section { border: 1px solid #e2e8f0; border-radius: 10px; padding: 18px; margin-top: 16px; }
  .muted { color: #64748b; font-size: .9rem; }
</style>
</head>
<body>
<div class="wrap">
<h1>Accessibility Statement / अभिगम्यता विवरण</h1>
<p class="muted">Draft — generated for ${escapeHtml(title)}</p>

<section lang="en">
  <h2>English</h2>
  <p>This website is committed to making its content accessible. Our target is conformance with <strong>WCAG 2.2 Level AA</strong>.</p>
  <h3>Known limitations</h3>
  ${limEnHtml}
  <h3>Feedback</h3>
  <p>We welcome your feedback on the accessibility of this website. Please contact us at: <strong>[Your name, phone number, and email address]</strong>.</p>
  <p>Last reviewed: ${escapeHtml(date)}.</p>
</section>

<section lang="hi">
  <h2>हिन्दी</h2>
  <p>यह वेबसाइट अपनी सामग्री को सुलभ बनाने के लिए प्रतिबद्ध है। हमारा लक्ष्य <strong>WCAG 2.2 स्तर AA</strong> का अनुपालन है।</p>
  <h3>ज्ञात सीमाएँ</h3>
  ${limHiHtml}
  <h3>प्रतिक्रिया</h3>
  <p>इस वेबसाइट की सुलभता के बारे में आपकी प्रतिक्रिया का स्वागत है। कृपया हमसे संपर्क करें: <strong>[अपना नाम, फ़ोन नंबर और ईमेल पता]</strong>।</p>
  <p>अंतिम समीक्षा: ${escapeHtml(date)}।</p>
</section>
</div>
</body>
</html>`;
}

app.get('/runs/:runId/statement', (req, res) => {
  const run = getRun(req.params.runId);
  if (!run) {
    return res.status(404).json({ error: `Run not found: ${req.params.runId}` });
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="accessibility-statement.html"');
  res.send(buildStatementHtml(run));
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
  console.log(`Events (SSE):    http://localhost:${PORT}/runs/:runId/events`);
  console.log(`Report (PDF):    http://localhost:${PORT}/runs/:runId/report`);
  console.log(`Statement (HTML): http://localhost:${PORT}/runs/:runId/statement`);
  console.log(`CORS origin:     ${FRONTEND_ORIGIN}`);
});
