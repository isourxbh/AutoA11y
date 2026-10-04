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
      speak("Fix applied to the file.");
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
      speak("Answer applied and the audit re-ran.");
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
      speak("Link copied.");
    } catch (err) {
      setError("Couldn't copy the link: " + err.message);
    }
  };

  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  const speak = (text) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-US";
    utterance.rate = 1;
    utterance.pitch = 1;
    window.speechSynthesis.speak(utterance);
  };

  // Narrate results once a fix run finishes and the UI updates.
  useEffect(() => {
    if (!result) return;
    const before = result.counts?.before?.instances ?? 0;
    const after = result.counts?.after?.instances ?? 0;
    const resolved = Math.max(0, before - after);
    speak(
      result.status === "completed"
        ? `Audit complete. ${resolved} instances resolved, ${after} remaining. Portal is now compliant.`
        : `Audit complete. ${resolved} instances resolved, ${after} remaining.`
    );
  }, [result]);

  // Release speech resources on unmount.
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop?.();
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    };
  }, []);

  const handleVoiceCommand = (transcript) => {
    const text = transcript.toLowerCase();
    console.log("Voice command:", text);
    const isFix =
      /\brun\b.*\bfix(er)?\b/.test(text) || /\bfix(er)?\b/.test(text);
    const isAudit = /\baudit\b/.test(text);

    if (isFix || isAudit) {
      if (running) {
        speak("A fix is already in progress.");
        return;
      }
      speak("Running accessibility fixer.");
      handleRun();
    } else {
      speak("Sorry, I didn't catch that. Try saying run fixer or audit page.");
    }
  };

  const startListening = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      setError("Speech recognition is not supported in this browser.");
      return;
    }
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.continuous = false;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((r) => r[0].transcript)
        .join(" ");
      handleVoiceCommand(transcript);
    };
    recognition.onend = () => setListening(false);
    recognition.onerror = (event) => {
      console.error("Speech recognition error:", event.error);
      setListening(false);
    };
    recognitionRef.current = recognition;
    recognition.start();
    setListening(true);
  };

  const stopListening = () => {
    recognitionRef.current?.stop?.();
    setListening(false);
  };

  const handleMicClick = () => {
    if (listening) stopListening();
    else startListening();
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
            {listening && (
              <span className="text-xs font-medium text-red-600">Listening…</span>
            )}
            <button
              type="button"
              onClick={handleMicClick}
              aria-label={listening ? "Stop listening" : "Start voice control"}
              title={listening ? "Listening… (click to stop)" : "Voice control"}
              className={`relative flex h-10 w-10 items-center justify-center rounded-full border shadow-sm transition focus:outline-none focus:ring-2 focus:ring-offset-2 ${
                listening
                  ? "border-red-300 bg-red-50 text-red-600 ring-2 ring-red-400"
                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50 focus:ring-indigo-500"
              }`}
            >
              {listening && (
                <span className="absolute inset-0 animate-ping rounded-full bg-red-300 opacity-40" />
              )}
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="relative h-5 w-5"
              >
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </button>
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


