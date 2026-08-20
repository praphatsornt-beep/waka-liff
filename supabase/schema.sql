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
  bank                 text,
  staff_name           text
);

-- Central audit log for every staff-attributed action across the LIFF app
-- (gas/Code.gs's _logStaffAction_) — one row per action, so "who did what,
-- when, at which branch" can be checked from a single place instead of
-- hunting through per-table notes fields or ephemeral LINE group messages.
-- Best-effort write (never blocks the real action it's describing) and
-- skipped entirely when no staff name was given, so it only ever contains
-- attributable rows.
create table if not exists staff_actions (
  id           bigint generated always as identity primary key,
  created_at   timestamptz not null default now(),
  staff_name   text not null,
  branch       text,
  action       text not null,
  target_id    text,
  detail       text
);
create index if not exists staff_actions_created_at_idx on staff_actions (created_at desc);
create index if not exists staff_actions_staff_name_idx on staff_actions (staff_name);

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
alter table staff_actions enable row level security;

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
grant select, insert, update, delete on public.staff_actions to service_role;
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

-- ── Migration (2026-08): walk-in sale staff name ────────────────────────────
-- Run in the Supabase SQL editor. Additive, nullable — no backfill needed,
-- historical sales made before this column existed just show blank staff.
-- alter table walkin_sales add column if not exists staff_name text;

-- ── Migration (2026-08-09): staff_actions audit log ─────────────────────────
-- Run in the Supabase SQL editor, in this exact order. New table — nothing
-- reads/writes it until gas/Code.gs's next deploy, so this is safe to run
-- ahead of that deploy.
--
-- create table if not exists staff_actions (
--   id           bigint generated always as identity primary key,
--   created_at   timestamptz not null default now(),
--   staff_name   text not null,
--   branch       text,
--   action       text not null,
--   target_id    text,
--   detail       text
-- );
-- create index if not exists staff_actions_created_at_idx on staff_actions (created_at desc);
-- create index if not exists staff_actions_staff_name_idx on staff_actions (staff_name);
-- alter table staff_actions enable row level security;
-- grant select, insert, update, delete on public.staff_actions to service_role;

-- ── Migration (2026-08-15): FK guardrail for stock_branch renames ──────────
-- Run in the Supabase SQL editor. Adds a real foreign key so Postgres itself
-- keeps stock_branch.name in sync on rename/delete, as a second, DB-level
-- guarantee on top of (not a replacement for) rename_product()'s manual
-- transaction and handleDeleteProduct's manual stock_branch cleanup — both
-- stay exactly as they are. Verified 2026-08-15: 0 orphan stock_branch rows
-- exist (every name already matches a catalog row), so this applies cleanly
-- against live data.
--
-- Deliberately NOT applied to withdrawals/stock_returns: those two tables
-- intentionally keep their rows after a product is deleted (they're the
-- historical audit trail — handleDeleteProduct never touches them), so a
-- hard FK there would either block deleting any product that ever had a
-- withdrawal/return, or force the name to null and lose that history. Not
-- worth it for those two; the existing patchSupabase_ rename calls in
-- handleUpdateProduct already keep them correct on rename, which is the
-- part that actually mattered.
--
-- alter table stock_branch
--   add constraint stock_branch_name_fkey
--   foreign key (name) references catalog (name)
--   on update cascade
--   on delete cascade;

-- ── Migration (2026-08-16): box→pack conversion ratio ──────────────────────
-- Run in the Supabase SQL editor. Additive, nullable — existing products
-- default to NULL (not set) until an admin fills it in via "✏️ แก้ไขสินค้า"
-- (จำนวนซองต่อกล่อง). gas/Code.gs's handleConvertBoxToPack refuses to
-- convert stock for a product until this is set, so no backfill needed.
-- alter table catalog add column if not exists packs_per_box numeric;

-- ── Migration (2026-08-18): purchases (ซื้อสินค้าเข้า) ──────────────────────
-- Run in the Supabase SQL editor. New table — separate from the "เพิ่ม/ลด
-- สต็อกคลังกลาง" quick-adjust dialog's plain-text staff_actions log (still
-- kept as-is for non-purchase corrections like recounts). This table backs
-- the dedicated "ซื้อสินค้าเข้า" menu: structured supplier/invoice/cost per
-- line item, queryable for daily/monthly purchase-cost reports, and able to
-- track partial payment (มัดจำ) since not every order is paid in full up
-- front — amount_paid can be less than total_cost, topped up later via a
-- follow-up payment record; ยอดค้างชำระ = total_cost - amount_paid, derived
-- at read time rather than stored, so it can never drift out of sync.
--
-- status/received_at split recording the purchase (an expense/commitment,
-- e.g. paid a deposit on a new order) from actually receiving the stock —
-- placing/paying for an order and the goods physically arriving are two
-- separate events in time, same two-step shape as shipments' created→
-- received flow. handleRecordPurchase only inserts the row (status =
-- "รอสินค้า") and does NOT touch catalog.qty_box/qty_pack; a separate
-- handleReceivePurchase call (staff confirms goods arrived) is what actually
-- adds to central stock and flips status to "รับแล้ว".
--
-- id is a surrogate key (bigserial), same reasoning as shipments — nothing
-- about a purchase is naturally unique enough to be a primary key.
--
-- create table if not exists purchases (
--   id           bigserial primary key,
--   purchase_id  text,
--   timestamp    timestamptz,
--   supplier     text,
--   doc_no       text,
--   items_json   jsonb,
--   total_cost   numeric,
--   amount_paid  numeric,
--   status       text,
--   received_at  timestamptz,
--   staff_name   text,
--   notes        text
-- );
-- create index if not exists purchases_timestamp_idx on purchases ("timestamp" desc);
-- alter table purchases enable row level security;
-- grant select, insert, update, delete on public.purchases to service_role;
-- The original `grant usage, select on all sequences in schema public` above
-- (line ~261) only covered sequences that existed at the time it ran — a
-- brand-new bigserial table's sequence is never auto-covered by it, unlike
-- staff_actions' `generated always as identity` id (identity columns don't
-- need a separate sequence grant the way serial/bigserial does). Confirmed
-- live 2026-08-18: recordPurchase failed with "permission denied for
-- sequence purchases_id_seq" until this ran.
-- grant usage, select on sequence purchases_id_seq to service_role;

-- ── Migration (2026-08-20): explicit product status ─────────────────────────
-- Run in the Supabase SQL editor, in this exact order. Replaces the old
-- implicit "has a limit + qty is 0 = preorder" guess in gas/Code.gs with a
-- real field staff set themselves at "สินค้า" — พรีออเดอร์/พร้อมส่ง/ไม่ขายแล้ว.
-- `active` stays (too many places already read it) but gas/Code.gs's
-- handleAddProduct/handleUpdateProduct always derive it from `status` now,
-- so the two can't drift apart.
--
-- Step 1 — additive, nullable, nothing reads it yet.
-- alter table catalog add column if not exists status text;
--
-- Step 2 — backfill every existing row from today's implicit rule, so
-- behavior doesn't change the moment gas/Code.gs starts reading `status`:
-- update catalog set status = 'inactive'
--   where status is null and active = 'FALSE';
-- update catalog set status = 'preorder'
--   where status is null
--   and ((limit_box is not null and coalesce(qty_box,0) = 0)
--     or (limit_pack is not null and coalesce(qty_pack,0) = 0));
-- update catalog set status = 'ready'
--   where status is null;
--
-- Step 3 — run only after confirming every row got a value:
--   select count(*) from catalog where status is null;  -- must return 0
-- alter table catalog alter column status set not null;
-- alter table catalog alter column status set default 'ready';
--
-- Deploy order matters: run this migration BEFORE deploying the matching
-- gas/Code.gs change — a status IS NULL row would otherwise fall through to
-- the "ready" branch there and get a real stock check applied to what's
-- still meant to be a preorder.
