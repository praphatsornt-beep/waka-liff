# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Agent Instructions

You're working inside the **WAT framework** (Workflows, Agents, Tools). Probabilistic AI (you) handles reasoning and orchestration; deterministic Python scripts handle execution. That separation is what keeps multi-step accuracy high.

## The WAT Architecture

**Layer 1 — Workflows (`workflows/`):** Markdown SOPs that define the objective, required inputs, which tools to run, expected outputs, and edge-case handling.

**Layer 2 — Agent (you):** Read the relevant workflow, run tools in the correct sequence, handle failures, and ask clarifying questions when needed. Don't try to execute tasks directly when a tool exists for them. Example: to scrape a site, read `workflows/scrape_website.md` then run `tools/scrape_single_site.py`.

**Layer 3 — Tools (`tools/`):** Python scripts that do the actual work — API calls, data transforms, file ops. Credentials live in `.env`.

## Ask First — Hard Rules

- **Creating or overwriting a workflow** — don't draft, replace, or delete without being asked.
- **Running a tool that makes paid API calls or consumes credits** — confirm before each run if the outcome is uncertain.
- **Pushing data to cloud services** (Google Sheets, Slides, etc.) when the destination or content wasn't specified.

Everything else — reading files, running tools with free/local APIs, fixing scripts, updating `.tmp/` — proceed without asking.

## How to Operate

1. **Check `tools/` before building anything.** Only create new scripts when nothing exists for the task.
2. **When a tool fails:** read the full trace, fix the script, retest, then update the workflow with what you learned (rate limits, timing quirks, endpoint changes). If the fix requires paid API calls, confirm first.
3. **Keep workflows current.** When you find a better method or hit a recurring issue, update the workflow — subject to the hard rules above.

## Running Tools

```bash
uv run tools/<script_name>.py       # preferred — handles virtualenv automatically
python tools/<script_name>.py       # fallback if uv is unavailable
```

Install dependencies:

```bash
pip install -r requirements.txt
pip install <package>               # per-tool, if needed
```

## Tool Script Conventions

```python
#!/usr/bin/env python3
from dotenv import load_dotenv
import os, sys

load_dotenv()

def main():
    # single clear responsibility
    # print progress to stdout
    # write outputs to .tmp/ or push to cloud
    # exit(1) with a descriptive message on unrecoverable error
    pass

if __name__ == "__main__":
    main()
```

- One script, one job. No shared state between tools.
- Accept inputs via CLI args or environment variables — never hardcode paths or keys.
- Write intermediate outputs to `.tmp/<descriptive_name>.<ext>`.

## Workflow Execution Pattern

Before any multi-step task:
1. Check `workflows/` for a relevant SOP.
2. Identify the required inputs and tools listed in that workflow.
3. Run each tool in sequence, passing outputs as inputs to the next step.
4. If no workflow exists, ask before creating one.

## File Structure

```
.tmp/                         # Temporary outputs — regenerated as needed, disposable
tools/                        # Python scripts for deterministic execution
workflows/                    # Markdown SOPs
.env                          # API keys and env vars
credentials.json, token.json  # Google OAuth (gitignored)
```

Outputs the user needs to act on go to cloud services (Google Sheets, Slides, etc.), not local files.

---

# Codebase Architecture

This repo runs **WAKA SPACE**, a LINE-based card-game shop order system:
customers order via LIFF, staff fulfill via LIFF, admins/finance manage via
Streamlit. It also has its own in-app tournament registration flow (below)
— separate from an older Google Forms + Sheets + Claude pipeline for
matching payment slips to tournament sign-ups that was retired 2026-08-06 as
unused (its own config/admin UI had already gone stale; superseded by the
in-app tournament flow). A separate in-app "WAKA GYM" player-registration/
token-reward flow (Streamlit `screens/wakagym.py`, GAS `wakagym*` actions,
LIFF `wakagym.html`) was removed 2026-08-14 at the owner's request pending a
rules rework — the Supabase tables (`wakagym_registrations`, `wakagym_events`,
`player_stats`) were left in place for a future rebuild, but no code in this
repo reads or writes them anymore.

## The four runtime pieces

- **`gas/Code.gs`** (single ~3,600-line file) — the backend. Deployed as a
  Google Apps Script Web App (`doGet`/`doPost`, dispatched by an `action`
  query param: `confirm`, `staff`, `api`, or catalog/config for the default
  LIFF payload). Handles LINE webhook events, order writes, stock/shipment
  logic, and PIN-based branch/admin authorization (`BRANCH_CODES`,
  `ADMIN_CODE` — read from Script Properties, not hardcoded, since
  2026-08-09's security audit found the old hardcoded values exposed via
  this being a public repo). The actual PIN values live only in Script
  Properties and must match what's entered in `liff/app.html`'s
  `PIN_ADMIN`/`BRANCH_CODES` and `tools/screens/*.py`'s `WAKA_S`/
  `ADMIN_CODE` constants — none of these should ever be the real, live
  values again once rotated; treat any value currently in git history
  (pre-rotation) as permanently burned.
- **`liff/*.html`** — static frontend pages (customer ordering, staff
  fulfillment, warehouse, reports), each calling the GAS Web App URL
  directly via `fetch`. Deployed to Vercel. These files are tracked
  normally by **this repo's own git** — edit and commit them exactly like
  any other file here, from the repo root. Deploying to Vercel is a
  *second push*, to this repo's other remote, `vercel` →
  `github.com/praphatsornt-beep/waka-liff.git` (a full-monorepo mirror;
  Vercel's project is configured with Root Directory = `liff`). Vercel's
  actual production branch on that remote is **`master`**, not `main` —
  push both so they don't drift apart:
  ```bash
  git push origin master         # this repo's own remote
  git push vercel master:master  # triggers the real Vercel deploy
  git push vercel master:main    # keep main in sync too
  ```
  A previous session mistakenly left a stale, disconnected `.git` folder
  *inside* the `liff/` directory (an old standalone repo from before this
  monorepo-mirror setup existed) — ignore it entirely; don't `cd liff && git
  ...`. It was 328 commits behind `vercel/master` before being discovered
  and abandoned on 2026-08-06.
- **`tools/verify_app.py` + `tools/screens/*.py`** — the Streamlit admin
  dashboard (orders, stock, tournament, report, settings tabs).
  `verify_app.py` is the Streamlit Cloud entry point/router — its path is
  fixed because Streamlit Cloud can't change a deployed app's main file
  without losing Secrets + URL. `tools/theme.py` holds the shared dark
  navy/gold visual theme; every page calls `apply_theme()` after
  `st.set_page_config()`. Some writes (e.g. `settings.py`) go back through
  the GAS `action=api` endpoint (with a shared secret) rather than straight
  to Supabase, so GAS's config cache stays correct.
- **Supabase** (Postgres, schema in `supabase/schema.sql`) — the database
  both GAS and Streamlit read/write via the REST API (`service_role` key
  only; RLS denies the `anon` key everything). All tables are now
  Supabase-primary (migrated off Google Sheets 2026-08): `orders`, `config`,
  `catalog`, `stock_branch`, `tournament_registrations`, `tournament_events`,
  `tournament_categories`, `shipments`, `stock_returns`,
  `withdrawals`, `walkin_sales`. (`wakagym_registrations`, `wakagym_events`,
  `player_stats` still exist too, but are unused since the 2026-08-14 WAKA
  GYM removal noted above.) `workflows/setup_supabase.md` describes the
  original "prep only, Sheets stays authoritative" plan — that plan is long
  out of date; trust the code comments over that doc.

## No Google Sheets dependency anywhere

As of 2026-08-09, `gas/Code.gs` has zero Google Sheets read/write path —
the `mirrorToReportSheet_()` best-effort export to the "WAKA export" sheet
(`REPORT_SHEET_ID`) and `getConfig_()`'s Sheet fallback (`SHEET_ID`) were
both removed at the owner's request once mirroring turned out to silently
drop rows (best-effort writes that failed were only logged, never surfaced
or retried) and Supabase proved reliable enough on its own. `REPORT_SHEET_ID`/
`SHEET_ID` Script Properties can stay set or be deleted — nothing reads them
anymore. The one-time/dev-only functions that used to live at the bottom of
`gas/Code.gs` (`backfillPartialReadyNotifiedAt`, `testPartialFlow`,
`testWakagymFlow`, `_testWgCleanup`) were removed 2026-08-09 for a related
reason — the latter two had gone stale (they asserted against the legacy
Sheet tabs directly, not Supabase) and the backfill had already done its
one-time job. Streamlit has no Google Sheets dependency either — every
screen reads Supabase directly via `service_role`; the
`credentials.json`/`token.json` OAuth flow (`tools/refresh_token.py`) is
unused by anything in the current codebase.

## No automated test suite

There are no test files in this repo. Validate changes by running the
relevant tool directly, or (for LIFF/Streamlit UI changes) exercising the
page manually — see the `run` skill.

## Key docs to read before touching a given area

- `workflows/order_operations.md` — full WAKA SPACE operational flow: PIN
  codes, per-role steps (customer/warehouse/branch staff/finance), the slip
  verification statuses, and deploy steps for GAS/LIFF/Streamlit.
- `workflows/tournament_operations.md` — day-of-event flow for the in-app
  tournament card distribution. Also covers WAKA GYM procedures, which are
  currently stale/inapplicable since the 2026-08-14 removal noted above —
  not updated here per the "don't edit workflows unasked" rule.
- `workflows/setup_google_auth.md` — one-time Google OAuth setup for
  `credentials.json`/`token.json`. Currently unused by any code in this
  repo (all Streamlit screens read Supabase directly now) — kept in case
  a future Sheets-dependent script needs it again, not because anything
  live depends on it today.
- `TODO.md` — live backlog of known bugs and planned features; check here
  before assuming something is unimplemented.
