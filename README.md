# Open Source PR Dashboard

A small, dependency-free dashboard of my pull requests to open source projects.
It shows how many PRs are **merged**, **open** and **closed** per project, with charts,
links to every PR, and a plain-English summary of what each PR fixed.

**Live site:** https://lubabakhalid.github.io/oss-pr-dashboard/

## What it shows

- **Overview page** – totals, a stacked bar chart per project, PRs opened per month,
  a "choose a project" button grid, and a table with separate link lists for merged,
  open and closed PRs.
- **Project page** – click any project to see its PRs grouped into Merged / Open / Closed.
  Each PR card has two short notes: *What was the issue* and *What was done*.
- **Refresh button** – pulls the latest state straight from the GitHub API, so a PR
  that was merged or closed a minute ago shows up as soon as you click it.
- Light and dark mode, keyboard-reachable tooltips, no build step.

## How the data flows

1. On load (and on **Refresh**) the page calls the public GitHub search API
   (`author:<user> type:pr`) and classifies every PR as merged, open or closed.
2. If the API is rate limited (60 unauthenticated requests per hour per visitor),
   the page falls back to the last successful copy saved in the browser, then to
   `data/snapshot.json`.
3. A scheduled GitHub Action (`.github/workflows/refresh-snapshot.yml`) refreshes
   `data/snapshot.json` every six hours so the fallback never gets stale.

## Files

| Path | Purpose |
|---|---|
| `index.html`, `css/style.css`, `js/app.js` | The whole app. Plain HTML/CSS/JS. |
| `data/config.json` | GitHub username, page title, and repos to leave out. |
| `data/summaries.json` | Hand-written summaries, keyed by `owner/repo#number`. |
| `data/snapshot.json` | Last fetched PR list, used as an offline fallback. |
| `scripts/fetch-prs.sh` | Regenerates the snapshot with the GitHub CLI. |

## Adding a summary for a new PR

PRs without a summary still appear (title, link, state and dates); the summary boxes
say "Summary not written yet". To add one, append an entry to `data/summaries.json`:

```json
"owner/repo#123": {
  "issue": "What was wrong or missing, in one or two plain sentences.",
  "done": "What the PR changed to fix it."
}
```

## Running locally

Any static file server works, for example:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000/.

## Reusing this for your own PRs

Edit `data/config.json`: set `username` to your GitHub login, adjust `exclude`
(patterns like `"me/*"` skip your own repos), and optionally change `title`.
Enable GitHub Pages from the `main` branch root and you are done.
