# AutoA11y

An accessibility auto-fixer built for the hackathon. It audits a web page with
[axe-core](https://github.com/dequelabs/axe-core), automatically fixes the
violations using an AI agent powered by the
**[Cline SDK](https://github.com/cline/cline)** (`@cline/sdk`), and visualizes
the before/after in a GitHub-style side-by-side diff.

## How it works

1. **Audit** — `GET /audit` loads `demo-site/index.html` in headless Chromium
   (Playwright) and runs axe-core, returning a JSON array of violations that
   includes the CSS selectors of the offending elements.
2. **Fix** — `POST /fix` launches a Cline agent with a custom `run_audit` tool
   and built-in file-editing tools. It audits → fixes → re-audits in a loop
   (hard-capped at 5 iterations) until the page is clean, then returns the
   original HTML, the fixed HTML, and the before/after violation counts.
3. **Visualize** — the React dashboard calls `/fix` and renders the
   before/after counts plus a side-by-side diff of the HTML.

## Project structure

```
autoa11y/
├── backend/          # Express + Playwright + axe-core + Cline SDK
│   ├── server.js     # GET /audit and POST /fix endpoints
│   └── fixer.js      # Cline agent + fix loop
├── frontend/         # Vite + React + Tailwind dashboard
│   └── src/App.jsx   # button, score comparison, diff viewer
└── demo-site/        # the page being fixed (ships with 4 a11y bugs)
    └── index.html
```

`demo-site/index.html` intentionally contains four accessibility errors (a
missing image `alt`, low-contrast text, an unlabeled input, and an empty
button) so you can watch the fixer resolve them.

## Prerequisites

- [Node.js](https://nodejs.org/) 22+ (the Cline SDK requires Node ≥ 22)
- npm
- A Cline account — the fixer uses your Cline credentials. The CLI
  (`npm i -g cline`, then `cline login`) or the VS Code extension will write
  them to `~/.cline/data/settings/providers.json`, which the backend reads
  automatically. Alternatively you can supply an Anthropic key via env vars
  (see below).

## Running it

### 1. Backend

```bash
cd backend
npm install
npx playwright install chromium   # one-time: downloads the browser for /audit
npm start
```

The API starts at `http://localhost:3000`.

### 2. Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, click **"Run AutoA11y Fixer"**, and watch the
violation count go `4 → 0` with the diff below.

## Endpoints

| Method | Path     | Description |
| ------ | -------- | ----------- |
| GET    | `/audit` | Run axe-core against the demo page; returns an array of violations. |
| POST   | `/fix`   | Run the Cline fixer loop; returns `originalHtml`, `fixedHtml`, `violations` (final), `initialViolations`, `clean`, and `iterations`. |

You can also run the fixer standalone (without the server) via `npm run fix`
from the `backend/` directory.

## Configuration

Environment variables (all optional):

| Variable            | Default                                    | Purpose |
| ------------------- | ------------------------------------------ | ------- |
| `PORT`              | `3000`                                     | Backend port. |
| `AUDIT_URL`         | `http://localhost:3000/audit`              | Audit endpoint used by the fixer. |
| `MAX_ITERATIONS`    | `5`                                        | Fix-loop hard cap. |
| `VITE_API_URL`      | `http://localhost:3000`                    | Backend base URL for the frontend. |
| `CLINE_PROVIDER` / `CLINE_MODEL` | `anthropic` / `claude-sonnet-4-20250514` | Override model when using an API key. |
| `CLINE_API_KEY` / `ANTHROPIC_API_KEY` | —                                   | Explicit API key (falls back to Cline account credentials if unset). |

## Built with

- [Express](https://expressjs.com/) + [cors](https://www.npmjs.com/package/cors)
- [Playwright](https://playwright.dev/) + [@axe-core/playwright](https://www.npmjs.com/package/@axe-core/playwright)
- **[Cline SDK](https://github.com/cline/cline)** (`@cline/sdk`) for the auto-fixing agent
- [Vite](https://vite.dev/) + [React](https://react.dev/) + [Tailwind CSS](https://tailwindcss.com/)
- [react-diff-viewer-continued](https://www.npmjs.com/package/react-diff-viewer-continued) for the diff viewer
