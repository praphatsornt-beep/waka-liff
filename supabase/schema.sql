-- WAKA Supabase schema — mirrors the Google Sheets tabs written by gas/Code.gs.
-- Prep-only: nothing writes here yet. Paste this whole file into the
-- Supabase dashboard's SQL Editor and run it once, on a fresh project.

create table if not exists orders (
  order_id             text primary key,
  timestamp            timestamptz,
  line_user_id         text,
  display_name         text,
  items_json           jsonb,
  total                numeric,
  branch               text,
  real_name            text,
  phone                text,
  address              text,
  email                text,
  slip_status          text,
  slip_url             text,
  slip_amount          numeric,
  slip_txn_id          text,
  notes                text,
  fulfillment          text,
  fulfilled_at         timestamptz,
  staff_confirmed_at   timestamptz,
  customer_confirmed_at timestamptz
);

create table if not exists tournament_registrations (
  reg_id               text primary key,
  timestamp            timestamptz,
  event_id             text,
  sequence_no          text,
  line_user_id         text,
  display_name         text,
  real_name            text,
  player_name          text,
  phone                text,
  facebook             text,
  slip_url             text,
  slip_status          text,
  payment_method       text,
  bank                 text,
  amount_paid          numeric,
  status               text,
  checked_in_at        timestamptz,
  note                 text,
  selected_categories  jsonb
);

create table if not exists wakagym_registrations (
  reg_id               text primary key,
  timestamp            timestamptz,
  event_date           text,
  group_id             text,
  event_id             text,
  line_user_id         text,
  display_name         text,
  real_name            text,
  player_name          text,
  phone                text,
  slip_url             text,
  slip_status          text,
  payment_method       text,
  bank                 text,
  placement            text,
  wins_3match          numeric,
  tokens_earned        numeric,
  promo_packs          numeric,
  rewards_given        text,
  note                 text
);

create table if not exists config (
  key                  text primary key,
  value                text
);

-- `id` (added via the migration at the bottom of this file, 2026-08) is a
-- stable opaque product code (P0001, P0002, ...) — distinct from `slug`
-- (URL-slug, unused, always "") and `barcode` (physical scanning). `name`
-- stays the Postgres primary key (nothing else in this schema has a real FK
-- constraint pointing at it), but `id` lets a product be safely renamed via
-- the rename_product() function below without losing branch stock history.
create table if not exists catalog (
  name                 text primary key,
  category             text,
  slug                 text,
  cost_box             numeric,
  cost_p               numeric,
  price_box            numeric,
  price_pack           numeric,
  qty_box              numeric,
  qty_pack             numeric,
  limit_box            numeric,
  limit_pack           numeric,
  active               text,
  image_url            text,
  barcode              text,
  notice               text
);

create table if not exists stock_branch (
  name                 text,
  category             text,
  branch               text,
  qty_box              numeric,
  qty_pack             numeric,
  primary key (name, branch)
);

-- shipment_id is NOT reliably unique in the live sheet (found duplicate IDs
-- with different statuses — pre-existing data inconsistency, not something
-- this backfill should silently dedupe), so use a surrogate key like the
-- other log-style tables instead of assuming shipment_id is a primary key.
create table if not exists shipments (
  id                   bigserial primary key,
  shipment_id          text,
  timestamp            timestamptz,
  to_branch            text,
  status               text,
  items_json           jsonb,
  received_at          timestamptz
);

create table if not exists stock_returns (
  id                   bigserial primary key,
  timestamp            timestamptz,
  branch               text,
  name                 text,
  qty_box              numeric,
  qty_pack             numeric
);

create table if not exists player_stats (
  player_name          text primary key,
  display_name         text,
  real_name            text,
  line_user_id         text,
  total_plays          numeric,
  total_tokens         numeric,
  boxes_earned         numeric,
  boxes_given          numeric,
  last_play_date       text
);

create table if not exists wakagym_events (
  event_id             text primary key,
  date                 text,
  branch               text,
  tier                 text,
  entry_fee            numeric,
  status               text,
  created_by           text
);

create table if not exists tournament_events (
  event_id             text primary key,
  name                 text,
  date                 text,
  entry_fee            numeric,
  max_players          numeric,
  rules_text           text,
  registration_close   text,
  status               text,
  created_at           text
);

create table if not exists tournament_categories (
  category_id          text primary key,
  event_id             text,
  name                 text,
  entry_fee            numeric,
  max_players          numeric,
  sort_order           numeric,
  status               text
);

-- Tab doesn't exist in the live sheet yet — GAS creates it lazily on the
-- first withdrawal (gas/Code.gs:3390). Table created here anyway so it's
-- ready; backfill will just find 0 rows until then.
create table if not exists withdrawals (
  id                   bigserial primary key,
  timestamp            timestamptz,
  branch               text,
  name                 text,
  type                 text,
  qty                  numeric,
  reason               text
);

-- Walk-in (in-store) sales, recorded by branch staff via liff/app.html's
-- "ขายหน้าร้าน" cart flow. Deliberately kept separate from `orders` — no
-- LINE user, no slip verification, and by design not rolled into the
-- online-order revenue report/dashboard.
create table if not exists walkin_sales (
  sale_id              text primary key,
  timestamp            timestamptz,
  branch               text,
  items_json           jsonb,
  total                numeric,
  payment_method       text,
  bank                 text
);

-- RLS on, no policies: only the service_role key (server-side only) can
-- read/write. The anon/public key gets nothing unless a policy is added later.
alter table orders enable row level security;
alter table tournament_registrations enable row level security;
alter table wakagym_registrations enable row level security;
alter table config enable row level security;
alter table catalog enable row level security;
alter table stock_branch enable row level security;
alter table shipments enable row level security;
alter table stock_returns enable row level security;
alter table player_stats enable row level security;
alter table wakagym_events enable row level security;
alter table tournament_events enable row level security;
alter table tournament_categories enable row level security;
alter table withdrawals enable row level security;
alter table walkin_sales enable row level security;

-- service_role bypasses RLS but still needs the underlying table grants —
-- "Automatically expose new tables" was left off when creating the project,
-- so grant explicitly instead of relying on that default.
grant select, insert, update, delete on public.orders to service_role;
grant select, insert, update, delete on public.tournament_registrations to service_role;
grant select, insert, update, delete on public.wakagym_registrations to service_role;
grant select, insert, update, delete on public.config to service_role;
grant select, insert, update, delete on public.catalog to service_role;
grant select, insert, update, delete on public.stock_branch to service_role;
grant select, insert, update, delete on public.shipments to service_role;
grant select, insert, update, delete on public.stock_returns to service_role;
grant select, insert, update, delete on public.player_stats to service_role;
grant select, insert, update, delete on public.wakagym_events to service_role;
grant select, insert, update, delete on public.tournament_events to service_role;
grant select, insert, update, delete on public.tournament_categories to service_role;
grant select, insert, update, delete on public.withdrawals to service_role;
grant select, insert, update, delete on public.walkin_sales to service_role;
grant usage, select on all sequences in schema public to service_role;

-- ── Migration (2026-08): stable product id, safe rename ────────────────────
-- Run in the Supabase SQL editor, in this exact order:
--
-- Step 1 — additive, non-blocking, nothing reads this column yet.
-- alter table catalog add column if not exists id text unique;
--
-- Step 2 — atomic two-table rename (catalog + stock_branch in one
-- transaction) — avoids any partial-failure window between updating the two
-- tables separately.
-- create or replace function rename_product(old_name text, new_name text)
-- returns void
-- language plpgsql
-- security definer
-- as $$
-- begin
--   update catalog set name = new_name where name = old_name;
--   if not found then
--     raise exception 'product not found: %', old_name;
--   end if;
--   update stock_branch set name = new_name where name = old_name;
-- end;
-- $$;
--
-- grant execute on function rename_product(text, text) to service_role;
--
-- Step 3 — run ONLY after tools/backfill_product_ids.py reports every row
-- backfilled, i.e. after: select count(*) from catalog where id is null;
-- returns 0.
-- alter table catalog alter column id set not null;
