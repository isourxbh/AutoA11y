import { useState } from "react";
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

function StatCard({ label, count, tone }) {
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
            {count === 1 ? "violation" : "violations"}
          </span>
        )}
      </div>
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
          <span className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-medium text-indigo-700">
            Demo
          </span>
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
              result.clean ? (
                <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                  &#10003; All fixed
                </span>
              ) : (
                <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-700">
                  {result.violations} remaining
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
              count={result?.initialViolations ?? null}
              tone="red"
            />
            <Arrow />
            <StatCard
              label="After"
              count={result?.violations ?? null}
              tone="green"
            />
          </div>
          {result && (
            <div className="mt-4 flex justify-end">
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
              leftTitle={`Before (${result.initialViolations ?? 0} violations)`}
              rightTitle={`After (${result.violations ?? 0} violations)`}
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
      </main>
    </div>
  );
}


