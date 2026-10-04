# AutoA11y

An evidence-backed accessibility auto-fixer. It audits web pages with
[axe-core](https://github.com/dequelabs/axe-core), fixes the violations with an
AI agent built on the **[Cline SDK](https://github.com/cline/cline)**
(`@cline/sdk`), and shows honest before/after evidence — it never claims GIGW
3.0 or RPwD Act certification, because automated tools only catch a subset of
issues.

## What it does

- **Audit** — runs axe-core in headless Chromium (Playwright) and returns the
  violations, including contrast data (`fgColor`, `bgColor`, `fontSize`,
  `fontWeight`, `contrastRatio`).
- **Fix** — an agent fixes violations, records every fix with quoted evidence
  (`proven` vs `inferred`), and **asks the site owner** (via a mobile share
  page) when a meaning is genuinely unknowable (icon-only buttons, unseen
  images).
- **Contrast is math, not guesswork** — `color-contrast` fixes go through a
  `suggest_contrast_fix` tool that keeps hue/saturation and steps lightness to
  the exact WCAG 2.1 threshold (3.0 for large text, 4.5 otherwise).
- **Fix anything you own** — the bundled demo, any live URL (a snapshot), or a
  zip of a static site (multi-page).
- **Watch it work live** — a server-sent-events stream and a live activity log.
- **Honest reporting** — an evidence-pack PDF and a bilingual (Hindi/English)
  accessibility statement, neither of which claims certification.

## Quick start

```bash
# 1. Backend
cd backend
npm install
npx playwright install chromium   # one-time browser download
npm start                         # http://localhost:3000

# 2. Frontend (in a second terminal)
cd frontend
npm install
npm run dev                       # http://localhost:5173
```

Open <http://localhost:5173>.

### Credentials

The fixer uses your Cline account. Log in once with the Cline CLI
(`npm i -g cline` then `cline login`) or the VS Code extension — the backend
reads `~/.cline/data/settings/providers.json` automatically. You can also pass
an explicit key via `CLINE_API_KEY` / `ANTHROPIC_API_KEY` (see Configuration).

## Using it

The dashboard accepts three inputs:

| Input | What it does |
| --- | --- |
| **Use demo panchayat site** | Fixes the bundled `demo-site/index.html` (a Hindi panchayat page with 7 rules / 18 instances). |
| **Fix URL** | Loads the URL in Playwright and fixes a snapshot of `page.content()`. |
| **Fix zip** | Uploads a `.zip` of a static site, audits every `.html` (4 at a time), then fixes files one by one, most violations first. |

After a run you get:

- **Live activity** (`role="log"`) — the agent's audit → fix → re-audit loop in
  real time, with lines like *"Recorded fix: link-name — Added aria-label=…"*
  and *"Asked owner: What does the banner image show?"*.
- **Violation count** — before/after rules and instances.
- **Side-by-side diff** — the exact HTML changes.
- **Fixed with evidence** — every fix with its evidence and confidence.
- **Needs the owner's answer** — open questions, with a **Copy link for site
  owner** button that opens a mobile share page to collect answers.
- **Hear the difference** — screen-reader transcript and keyboard walk,
  before/after, with text-to-speech playback.
- **Download evidence pack (PDF)** and **Download accessibility statement**.

## API endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/audit` | Audit the demo page; returns the axe violations array. |
| `POST` | `/fix` | Start a run (demo / `{ url }` / multipart `zip`); returns `runId` immediately. |
| `GET` | `/runs/:runId` | Run state (status, counts, findings, questions, diff). |
| `GET` | `/runs/:runId/events` | Server-sent events: `audit-start`, `audit-result`, `fix-recorded`, `question-asked`, `guard-rejected`, `run-complete`, plus forwarded agent tool events. |
| `POST` | `/runs/:runId/answers` | Submit the site owner's answers and re-run. |
| `GET` | `/runs/:runId/share` | Mobile share page for the owner to answer questions. |
| `POST` | `/runs/:runId/apply` | Copy the fixed sandbox back over the original file (demo only). |
| `GET` | `/runs/:runId/experience` | Screen-reader transcript + keyboard walk, before/after. |
| `GET` | `/runs/:runId/report` | Evidence-pack PDF (honest; not a certification). |
| `GET` | `/runs/:runId/statement` | Draft accessibility statement (Hindi + English, HTML). |

## Project structure

```
autoa11y/
├── backend/
│   ├── server.js        # Express endpoints + SSE + PDF/statement
│   ├── fixer.js         # Cline agent, fix loop, tools, event stream
│   ├── audit.js         # axe-core audit + element screenshots
│   ├── contrast.js      # WCAG color math (nearestPassingColor)
│   ├── experience.js    # screen-reader transcript + keyboard walk
│   ├── wcag-map.js      # axe rule → WCAG success criterion
│   ├── guard.js         # rejects cheating fixes (hiding, deletion, …)
│   ├── audit-ci.js      # CI audit entry point
│   └── bin/autoa11y.js  # CLI
├── frontend/            # Vite + React + Tailwind dashboard
│   └── src/App.jsx
├── demo-site/           # the intentionally broken demo page
└── .github/workflows/   # a11y-audit CI on pull requests
```

## Configuration

Environment variables (all optional):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Backend port. |
| `FRONTEND_ORIGIN` | `http://localhost:5173` | CORS origin for the dashboard. |
| `MAX_ITERATIONS` | `5` | Fix-loop hard cap per file. |
| `VITE_API_URL` | `http://localhost:3000` | Backend base URL for the frontend. |
| `CLINE_PROVIDER` / `CLINE_MODEL` | `anthropic` / `claude-sonnet-4-20250514` | Model override when using an API key. |
| `CLINE_API_KEY` / `ANTHROPIC_API_KEY` | — | Explicit API key (falls back to Cline account credentials). |

## Tests

```bash
cd backend
npm test    # node --test: contrast math + guard validation
```

## Built with

- [Express](https://expressjs.com/) + [cors](https://www.npmjs.com/package/cors) + [multer](https://www.npmjs.com/package/multer) + [adm-zip](https://www.npmjs.com/package/adm-zip) + [p-limit](https://www.npmjs.com/package/p-limit) + [pdfkit](https://www.npmjs.com/package/pdfkit)
- [Playwright](https://playwright.dev/) + [@axe-core/playwright](https://www.npmjs.com/package/@axe-core/playwright)
- **[Cline SDK](https://github.com/cline/cline)** (`@cline/sdk`) for the fixing agent
- [Vite](https://vite.dev/) + [React](https://react.dev/) + [Tailwind CSS](https://tailwindcss.com/)
- [react-diff-viewer-continued](https://www.npmjs.com/package/react-diff-viewer-continued)

## Important

Automated tools only catch a subset of accessibility issues. AutoA11y documents
automated remediation work; it is **not** a certification of conformance with
GIGW 3.0 or the RPwD Act, 2016. Manual and real-user testing is still required.
