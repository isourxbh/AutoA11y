import { useEffect, useRef, useState } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

// GitHub-style light palette for the diff viewer.
const diffStyles = {
  variables: {
    light: {
      diffViewerBackground: "#ffffff",
      diffViewerColor: "#1f2328",
      diffViewerTitleBackground: "#f6f8fa",
      diffViewerTitleColor: "#1f2328",
      diffViewerTitleBorderColor: "#d0d7de",
      addedBackground: "#e6ffec",
      addedColor: "#1f2328",
      removedBackground: "#ffebe9",
      removedColor: "#1f2328",
      wordAddedBackground: "#abf2bc",
      wordRemovedBackground: "#ffb3ae",
      addedGutterBackground: "#ccffd8",
      removedGutterBackground: "#ffd7d5",
      gutterBackground: "#f6f8fa",
      gutterBackgroundDark: "#eff1f3",
      highlightBackground: "#fff8c5",
      highlightGutterBackground: "#fff0b3",
      codeFoldGutterBackground: "#dbedff",
      codeFoldBackground: "#f1f8ff",
      emptyLineBackground: "#fafbfc",
      gutterColor: "#57606a",
      addedGutterColor: "#57606a",
      removedGutterColor: "#57606a",
      codeFoldContentColor: "#57606a",
    },
  },
  contentText: {
    fontFamily:
      "'SFMono-Regular', ui-monospace, 'JetBrains Mono', Menlo, Consolas, monospace",
  },
  line: {
    fontSize: "13px",
  },
};

function StatCard({ label, count, sub, tone }) {
  const tones = {
    red: {
      ring: "border-red-200",
      dot: "bg-red-500",
    },
    green: {
      ring: "border-emerald-200",
      dot: "bg-emerald-500",
    },
  }[tone];

  const display = count == null ? "—" : count;

  return (
    <div className={`rounded-lg border ${tones.ring} bg-white p-5`}>
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 rounded-full ${tones.dot}`} />
        <span className="text-sm font-medium text-slate-500">{label}</span>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-4xl font-bold tabular-nums text-slate-900">
          {display}
        </span>
        {count != null && (
          <span className="text-sm text-slate-500">
            {count === 1 ? "instance" : "instances"}
          </span>
        )}
      </div>
      {sub != null && (
        <div className="mt-1 text-xs text-slate-400">{sub}</div>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <div className="flex items-center justify-center px-2 text-slate-400">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-7 w-7"
      >
        <path d="M5 12h14" />
        <path d="m13 6 6 6-6 6" />
      </svg>
    </div>
  );
}

const DEVANAGARI = /[\u0900-\u097F]/;

// Align before/after transcript lines so changed lines can be marked.
function diffTranscript(before, after) {
  const rows = [];
  const n = before.length;
  const m = after.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        before[i] === after[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      rows.push({ before: before[i], after: after[j], changed: false });
      i++;
      j++;
    } else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) {
      rows.push({ before: null, after: after[j], changed: true });
      j++;
    } else {
      rows.push({ before: before[i], after: null, changed: true });
      i++;
    }
  }
  return rows;
}

export default function App() {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const handleRun = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/fix`, { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Server responded ${res.status}`);
      }
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setRunning(false);
    }
  };

  const handleDownloadReport = async () => {
    try {
      const res = await fetch(`${API_URL}/report`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Report endpoint returned ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "autoa11y-compliance-report.pdf";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleApply = async () => {
    if (!result?.runId) return;
    try {
      const res = await fetch(`${API_URL}/runs/${result.runId}/apply`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Apply returned ${res.status}`);
      }
      setResult((prev) => ({ ...prev, applied: true }));
    } catch (err) {
      setError(err.message);
    }
  };

  const [freeText, setFreeText] = useState({});
  const [answering, setAnswering] = useState(false);

  const handleAnswer = async (questionId, answer) => {
    const text = (answer || "").trim();
    if (!result?.runId || !text) return;
    setAnswering(true);
    setError(null);
    try {
      const res = await fetch(`${API_URL}/runs/${result.runId}/answers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: [{ questionId, answer: text }] }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Answers returned ${res.status}`);
      }
      const data = await res.json();
      setResult((prev) => ({
        ...prev,
        status: data.status,
        counts: data.counts,
        findings: data.findings,
        questions: data.questions,
        fixedHtml: data.fixedHtml,
      }));
      setFreeText((prev) => ({ ...prev, [questionId]: "" }));
    } catch (err) {
      setError(err.message);
    } finally {
      setAnswering(false);
    }
  };

  const handleCopyLink = async () => {
    if (!result?.runId) return;
    const shareUrl = `${API_URL}/runs/${result.runId}/share`;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch (err) {
      setError("Couldn't copy the link: " + err.message);
    }
  };

  // "Hear the difference" — screen-reader + keyboard experience.
  const [experience, setExperience] = useState(null);
  const [expLoading, setExpLoading] = useState(false);
  const [speakingSide, setSpeakingSide] = useState(null);
  const speakingRef = useRef(false);

  useEffect(() => {
    if (!result?.runId) {
      setExperience(null);
      return;
    }
    let cancelled = false;
    setExperience(null);
    setExpLoading(true);
    fetch(`${API_URL}/runs/${result.runId}/experience`)
      .then((res) => {
        if (!res.ok) throw new Error(`Experience returned ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setExperience(data);
      })
      .catch((err) => {
        if (!cancelled) console.error("Experience failed:", err);
      })
      .finally(() => {
        if (!cancelled) setExpLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [result]);

  // Warm up the voice list so pickVoice() has voices to choose from.
  useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.getVoices();
    const onVoices = () => window.speechSynthesis.getVoices();
    window.speechSynthesis.addEventListener("voiceschanged", onVoices);
    return () => {
      window.speechSynthesis.removeEventListener("voiceschanged", onVoices);
      window.speechSynthesis.cancel();
    };
  }, []);

  const pickVoice = (line) => {
    if (!("speechSynthesis" in window)) return null;
    const wantLang = DEVANAGARI.test(line) ? "hi-IN" : "en-IN";
    const voices = window.speechSynthesis.getVoices();
    return (
      voices.find(
        (v) => (v.lang || "").toLowerCase().replace("_", "-") === wantLang.toLowerCase()
      ) ||
      voices.find((v) => (v.lang || "").toLowerCase().startsWith(wantLang.slice(0, 2))) ||
      null
    );
  };

  const playTranscript = (side) => {
    if (!("speechSynthesis" in window)) {
      setError("Speech synthesis is not supported in this browser.");
      return;
    }
    const lines = experience?.[side]?.transcript || [];
    if (lines.length === 0) return;
    window.speechSynthesis.cancel();
    speakingRef.current = true;
    setSpeakingSide(side);

    let idx = 0;
    const speakNext = () => {
      if (!speakingRef.current || idx >= lines.length) {
        setSpeakingSide(null);
        return;
      }
      const line = lines[idx++];
      const utterance = new SpeechSynthesisUtterance(line);
      const voice = pickVoice(line);
      if (voice) utterance.voice = voice;
      utterance.lang = DEVANAGARI.test(line) ? "hi-IN" : "en-IN";
      utterance.onend = speakNext;
      utterance.onerror = speakNext;
      window.speechSynthesis.speak(utterance);
    };
    speakNext();
  };

  const stopSpeaking = () => {
    speakingRef.current = false;
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    setSpeakingSide(null);
  };

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-5 w-5"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="m8 12 2 2 5-5" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold leading-tight">AutoA11y</h1>
              <p className="text-xs text-slate-500">
                Accessibility fixer dashboard
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700">
              Demo
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        {/* Action bar */}
        <section className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="font-medium">Audit &amp; Fix</h2>
            <p className="text-sm text-slate-500">
              Run axe-core against{" "}
              <span className="font-mono">demo-site/index.html</span> and
              auto-fix violations.
            </p>
          </div>
          <button
            type="button"
            onClick={handleRun}
            disabled={running}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-70"
          >
            {running ? (
              <>
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  className="h-4 w-4 animate-spin"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    className="opacity-25"
                  />
                  <path
                    d="M22 12a10 10 0 0 1-10 10"
                    stroke="currentColor"
                    strokeWidth="4"
                    strokeLinecap="round"
                  />
                </svg>
                Running&hellip;
              </>
            ) : (
              "Run AutoA11y Fixer"
            )}
          </button>
        </section>

        {/* Violation score comparison */}
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-medium">Violation count</h2>
            {result ? (
              result.status === "completed" ? (
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                  &#10003; All fixed
                </span>
              ) : (
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                  {result.counts?.after?.instances ?? 0} remaining
                </span>
              )
            ) : (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
                Not run yet
              </span>
            )}
          </div>
          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-6">
            <StatCard
              label="Before"
              count={result?.counts?.before?.instances ?? null}
              sub={
                result?.counts?.before?.rules != null
                  ? `${result.counts.before.rules} rules`
                  : null
              }
              tone="red"
            />
            <Arrow />
            <StatCard
              label="After"
              count={result?.counts?.after?.instances ?? null}
              sub={
                result?.counts?.after?.rules != null
                  ? `${result.counts.after.rules} rules`
                  : null
              }
              tone="green"
            />
          </div>
          {result && (
            <div className="mt-4 flex justify-end gap-2">
              {result.status === "completed" && (
                <button
                  type="button"
                  onClick={handleApply}
                  className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
                >
                  Apply Fix to File
                </button>
              )}
              <button
                type="button"
                onClick={handleDownloadReport}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              >
                <svg
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="h-4 w-4"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                Download Compliance Report (PDF)
              </button>
            </div>
          )}
        </section>

        {/* Diff viewer */}
        <section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
            <div className="flex items-center gap-2 text-sm">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="h-4 w-4 text-slate-400"
              >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <path d="M14 2v6h6" />
              </svg>
              <span className="font-mono text-slate-700">
                demo-site/index.html
              </span>
            </div>
            <span className="text-xs text-slate-500">side-by-side diff</span>
          </div>
          {result ? (
            <ReactDiffViewer
              oldValue={result.originalHtml}
              newValue={result.fixedHtml}
              splitView
              showDiffOnly={false}
              hideLineNumbers={false}
              leftTitle={`Before (${result.counts?.before?.instances ?? 0} instances)`}
              rightTitle={`After (${result.counts?.after?.instances ?? 0} instances)`}
              highlightLanguage="html"
              hideSummary
              styles={diffStyles}
            />
          ) : (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-slate-400">
              {error ? (
                <>
                  <p className="font-medium text-red-500">
                    Something went wrong
                  </p>
                  <p className="max-w-md text-center text-sm">{error}</p>
                </>
              ) : (
                <>
                  <p className="font-medium">No diff yet</p>
                  <p className="text-sm">
                    Run the fixer to see the before/after comparison.
                  </p>
                </>
              )}
            </div>
          )}
        </section>
        {/* Hear the difference */}
        {result?.runId && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <h2 className="font-medium">Hear the difference</h2>
              <span className="text-xs text-slate-500">
                What a screen reader and keyboard user actually get
              </span>
            </div>

            {expLoading && !experience && (
              <p className="mt-4 text-sm text-slate-500" role="status">
                Preparing transcripts…
              </p>
            )}

            {experience &&
              (() => {
                const rows = diffTranscript(
                  experience.before.transcript,
                  experience.after.transcript
                );
                const kbBefore = experience.before.keyboard;
                const kbAfter = experience.after.keyboard;
                return (
                  <>
                    <div className="mt-4 grid gap-4 lg:grid-cols-2">
                      {["before", "after"].map((side) => {
                        const isPlaying = speakingSide === side;
                        return (
                          <div
                            key={side}
                            className={`rounded-lg border p-4 ${
                              side === "before"
                                ? "border-red-100 bg-red-50/40"
                                : "border-emerald-100 bg-emerald-50/40"
                            }`}
                          >
                            <div className="mb-2 flex items-center justify-between gap-2">
                              <h3 className="text-sm font-semibold capitalize">
                                {side === "before" ? "Before" : "After"} · screen
                                reader
                              </h3>
                              <button
                                type="button"
                                onClick={() =>
                                  isPlaying ? stopSpeaking() : playTranscript(side)
                                }
                                className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                              >
                                {isPlaying ? "Stop" : "Play"}
                              </button>
                            </div>
                            <ul className="space-y-0.5">
                              {rows.map((row, i) => {
                                const line =
                                  side === "before" ? row.before : row.after;
                                if (line == null) {
                                  return (
                                    <li
                                      key={i}
                                      className="h-6"
                                      aria-hidden="true"
                                    />
                                  );
                                }
                                return (
                                  <li
                                    key={i}
                                    className={`flex items-start gap-2 rounded px-2 py-0.5 text-sm leading-snug ${
                                      row.changed
                                        ? "bg-amber-50"
                                        : "text-slate-700"
                                    }`}
                                  >
                                    <span className="min-w-0 break-words">
                                      {line}
                                    </span>
                                    {row.changed && (
                                      <span className="ml-auto shrink-0 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-amber-900">
                                        Changed
                                      </span>
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </div>

                    <p className="mt-4 text-sm text-slate-700">
                      Keyboard: Before: {kbBefore.named ?? 0} of{" "}
                      {kbBefore.total ?? 0} controls reachable with a name. After:{" "}
                      {kbAfter.named ?? 0} of {kbAfter.total ?? 0}.
                    </p>
                    {(kbBefore.focusTrap || kbAfter.focusTrap) && (
                      <p className="mt-1 text-sm text-amber-700">
                        Focus trap detected.
                      </p>
                    )}
                    {((kbBefore.noVisibleFocus ?? 0) > 0 ||
                      (kbAfter.noVisibleFocus ?? 0) > 0) && (
                      <p className="mt-1 text-sm text-amber-700">
                        Some controls have no visible focus indicator.
                      </p>
                    )}
                  </>
                );
              })()}
          </section>
        )}

        {/* Fixed with evidence */}
        {result?.findings?.length > 0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="font-medium">Fixed with evidence</h2>
            <ul className="mt-3 space-y-2">
              {result.findings.map((f, i) => (
                <li
                  key={i}
                  className="flex flex-wrap items-start gap-2 rounded-lg border border-slate-100 p-3"
                >
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-bold ${
                      f.confidence === "proven"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700"
                    }`}
                  >
                    {f.confidence === "proven" ? "PROVEN" : "INFERRED"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{f.change}</p>
                    <p className="text-xs text-slate-500">
                      Evidence: {f.evidence}
                    </p>
                    <p className="font-mono text-xs text-slate-400">
                      {f.selector}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Needs the owner's answer */}
        {(result?.questions || []).filter((q) => q.status === "open").length >
          0 && (
          <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-2">
              <h2 className="font-medium">Needs the owner's answer</h2>
              <button
                type="button"
                onClick={handleCopyLink}
                className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-400 focus:ring-offset-2"
              >
                Copy link for site owner
              </button>
            </div>
            <div className="mt-3 space-y-4">
              {(result.questions || [])
                .filter((q) => q.status === "open")
                .map((q) => (
                  <div
                    key={q.id}
                    className="rounded-lg border border-slate-100 p-3"
                  >
                    <p className="font-medium">{q.question}</p>
                    <p className="text-xs text-slate-500">
                      {q.questionEnglish}
                    </p>
                    {q.screenshot && (
                      <img
                        src={q.screenshot}
                        alt={`Screenshot of the element: ${q.questionEnglish}`}
                        className="my-2 max-w-xs rounded border"
                      />
                    )}
                    <div className="flex flex-wrap gap-2">
                      {(q.suggestedAnswers || []).map((ans) => (
                        <button
                          key={ans}
                          type="button"
                          onClick={() => handleAnswer(q.id, ans)}
                          className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50"
                        >
                          {ans}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={freeText[q.id] || ""}
                        onChange={(e) =>
                          setFreeText((prev) => ({
                            ...prev,
                            [q.id]: e.target.value,
                          }))
                        }
                        placeholder="Or type an answer"
                        aria-label={`Your own answer for: ${q.questionEnglish}`}
                        className="flex-1 rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => handleAnswer(q.id, freeText[q.id])}
                        className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-indigo-700"
                      >
                        Send
                      </button>
                    </div>
                  </div>
                ))}
            </div>
            {answering && (
              <p className="mt-3 text-sm text-slate-500" role="status">
                Applying answers and re-auditing…
              </p>
            )}
          </section>
        )}
      </main>
    </div>
  );
}


