# Setup: Supabase (prep phase)

**Objective:** Stand up a Supabase project with tables mirroring the
Google Sheets tabs (`orders`, `tournament_registrations`,
`wakagym_registrations`), so it's ready as a future database — without
changing how `gas/Code.gs` writes data today. Sheets stays the live system;
this is groundwork only. Deciding how data actually gets into Supabase
(dual-write from GAS, or a periodic sync) is a separate, later step.

## 1. Create the project

Uses the same Supabase account already in use for the other app at
`C:\Users\pps\OneDrive\Desktop\claude` (project `vpvpcdtpysfbatkugfzs`) —
no new signup needed, just a new project under that account so the two
apps' data stay in separate databases.

1. Go to [supabase.com](https://supabase.com) → log in with that existing
   account → **New project**.
2. Same org as before, name it `waka-tournament`, set a DB password (save
   it somewhere safe — needed for direct Postgres access, not for the
   steps below), pick the nearest region.
3. Wait for provisioning to finish (~2 min).

## 2. Run the schema

1. In the project dashboard, open **SQL Editor** → **New query**.
2. Paste the entire contents of [`supabase/schema.sql`](../supabase/schema.sql)
   and click **Run**.
3. Confirm in **Table Editor** that `orders`, `tournament_registrations`,
   and `wakagym_registrations` now exist.

## 3. Get credentials

1. **Project Settings → API**.
2. Copy the **Project URL** → `SUPABASE_URL`.
3. Copy the **service_role** key (not the `anon` key — service_role is
   needed for server-side writes and bypasses the row-level-security
   deny-all default set in `schema.sql`) → `SUPABASE_SERVICE_KEY`.
4. Add both to your local `.env` (see `.env.example`).

**Never expose `SUPABASE_SERVICE_KEY` in LIFF/frontend code** — it has
full read/write access. It only belongs server-side (Python tools, and
later, GAS if a service call is added there).

## 4. Verify

```bash
uv run tools/supabase_check.py
```

Confirms all 3 tables are reachable and does an insert/delete round-trip
on `orders`. If it fails, re-check `.env` values and that step 2 actually
ran without error.

## Later (not done yet)

- Deciding how `orders` / registrations actually reach Supabase (GAS
  `UrlFetchApp` call on write, vs. a periodic Python sync job reading
  Sheets and upserting into Supabase).
- If Streamlit or the LIFF apps ever need to read from Supabase directly,
  add `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` to Streamlit Cloud's Secrets
  and Vercel's env vars respectively — not needed for this prep phase.
