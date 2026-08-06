// ──────────────────────────────────────────────────────────────────────────────
// Card Game Order System — Google Apps Script Backend
// Deploy as Web App: Execute as "Me", Who has access: "Anyone"
// ──────────────────────────────────────────────────────────────────────────────

function warmup() {
  // keepalive ping only — avoid heavy operations that risk timeout
  Logger.log("ping " + new Date().toISOString());
}

const PROPS         = PropertiesService.getScriptProperties();
const LINE_TOKEN    = PROPS.getProperty("LINE_TOKEN");
const SHEET_ID      = PROPS.getProperty("SHEET_ID");
const SCRIPT_SECRET = PROPS.getProperty("SCRIPT_SECRET") || "";

// Branch login codes (mirrors BRANCH_CODES/PIN_ADMIN in liff/app.html) — kept
// here too so branch-scoped read/write actions can verify the caller actually
// knows the code for the branch they're requesting, not just the branch name
// (the `branch` query/body param alone is not proof of identity — anyone who
// can reach the API can set it to any value).
const BRANCH_CODES = { "ts01": "ต้นสักคอร์เนอร์", "mt01": "เมืองทองธานี", "sn01": "ศรีนครินทร์" };
const ADMIN_CODE   = "waka99";

// Thai strings that visually match can still fail === if one side picked up
// stray formatting during copy/paste (e.g. through the Apps Script editor).
// normalize() + trim() on both sides makes the compare resilient to that.
function _norm(s) { return String(s || "").trim().normalize("NFC"); }

// branch === "" means "no specific branch requested" (e.g. warehouse.html's
// all-branches overview) — left unrestricted, matching existing behavior.
function _branchAuthorized(code, branch) {
  if (!branch) return true;
  code = String(code || "").trim();
  if (code === ADMIN_CODE) return true;
  return _norm(BRANCH_CODES[code]) === _norm(branch);
}

const SUPABASE_URL         = PROPS.getProperty("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = PROPS.getProperty("SUPABASE_SERVICE_KEY") || "";

// Separate spreadsheet (not SHEET_ID) that mirrors Supabase-primary tables
// for human reading (partners etc.) — set once the sheet exists. Empty =
// mirroring is skipped everywhere, no error.
const REPORT_SHEET_ID = PROPS.getProperty("REPORT_SHEET_ID") || "";

// ── Supabase dual-write (best-effort mirror, Sheets stays authoritative) ────
// Sheets remains the source of truth for every write in this file. These
// helpers only keep Supabase's mirror of orders/tournament_reg/wakagym_reg
// current for Streamlit + LIFF reads. A Supabase outage must NEVER break a
// real order — never throws, never retried, just logged and ignored.
function pushToSupabase_(table, row) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, code: 0, text: "SUPABASE_URL/SUPABASE_SERVICE_KEY not set" };
  try {
    var res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/" + table, {
      method: "post",
      contentType: "application/json",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      payload: JSON.stringify(row),
      muteHttpExceptions: true,
    });
    // muteHttpExceptions means a 4xx/5xx from Supabase (bad payload, RLS
    // denial, etc.) does NOT throw — without this check it fails completely
    // silently and nothing ever gets logged.
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      var text = res.getContentText();
      Logger.log("pushToSupabase_(" + table + ") HTTP " + code + ": " + text);
      return { ok: false, code: code, text: text };
    }
    return { ok: true, code: code, text: "" };
  } catch (e) {
    Logger.log("pushToSupabase_(" + table + ") failed: " + e.message);
    return { ok: false, code: -1, text: e.message };
  }
}

// Every order write already builds sheetRowToObject_(SUPABASE_ORDERS_HEADER,
// rowArr, ["items_json"]) before pushing to Supabase — this wraps that same
// call plus a mirror into the "WAKA export" report sheet's `orders` tab, so
// every write path gets both for free with one call instead of two.
function pushOrderToSupabase_(rowArr) {
  var obj = sheetRowToObject_(SUPABASE_ORDERS_HEADER, rowArr, ["items_json"]);
  pushToSupabase_("orders", obj);
  mirrorToReportSheet_("orders", SUPABASE_ORDERS_HEADER, "order_id", obj);
  return obj;
}

// ── orders: Supabase-primary (Phase 2) ──────────────────────────────────
// The "WAKA ORDER" Sheet is no longer written to for orders — Supabase is
// the store of record, and mirrorToReportSheet_ keeps the "WAKA export"
// sheet's `orders` tab as the human-readable backup/display copy instead.

// Reads the current full order row from Supabase. items_json comes back
// already parsed (a real array, not a JSON string) since it's a native
// jsonb column — callers should NOT JSON.parse() it again.
function getSupabaseOrder_(orderId) {
  var rows = supabaseSelect_("orders", "select=*&order_id=eq." + encodeURIComponent(orderId) + "&limit=1");
  return rows[0] || null;
}

// Upserts the full order object as the authoritative record. Throws on
// failure — unlike the old best-effort pushToSupabase_/pushOrderToSupabase_,
// a failed write here must fail the caller's action too, since there's no
// Sheet write left to fall back on.
//
// Optional `lock`: mirrorToReportSheet_ does a full getDataRange().getValues()
// scan of the report sheet tab on every call — real latency that grows with
// row count. Every caller here holds a script-wide LockService lock (shared
// by EVERY concurrent GAS execution, not just this one), so if the lock is
// still held during that scan, one slow mirror stalls every other in-flight
// request system-wide, not just this one (confirmed live: bulk Streamlit
// actions hitting 30s timeouts under this contention). The mirror is a
// best-effort backup with no bearing on Supabase correctness, so once the
// authoritative write succeeds, release the lock — passed in by the caller
// as the last thing it does under lock — before doing the slow part.
function writeSupabaseOrder_(obj, lock) {
  var res = pushToSupabase_("orders", obj);
  if (!res.ok) throw new Error("Supabase orders write failed: " + res.text);
  if (lock) { try { lock.releaseLock(); } catch (_) {} }
  mirrorToReportSheet_("orders", SUPABASE_ORDERS_HEADER, "order_id", obj);
  return obj;
}

// Generic versions of the two helpers above, for migrating the remaining
// Sheet-primary tables (wakagym_events, tournament_events,
// tournament_categories, etc.) to Supabase-primary one at a time, same
// pattern: read/write Supabase directly, mirror to the "WAKA export" sheet,
// throw on write failure since there's no Sheet fallback once migrated.
function getSupabaseRow_(table, keyCol, keyValue) {
  var rows = supabaseSelect_(table, "select=*&" + keyCol + "=eq." + encodeURIComponent(keyValue) + "&limit=1");
  return rows[0] || null;
}
// Optional `lock` — see writeSupabaseOrder_'s comment above, same reasoning.
function writeSupabaseRow_(table, obj, header, keyCol, lock) {
  var res = pushToSupabase_(table, obj);
  if (!res.ok) throw new Error("Supabase " + table + " write failed: " + res.text);
  if (lock) { try { lock.releaseLock(); } catch (_) {} }
  mirrorToReportSheet_(table, header, keyCol, obj);
  return obj;
}

// PATCH-by-filter, for tables whose real primary key is a DB-generated
// surrogate (shipments.id) rather than a business key — pushToSupabase_'s
// upsert-by-PK (POST + resolution=merge-duplicates) can't target those rows
// without the id, so updating an existing row needs a real UPDATE instead.
// `filterQuery` is a PostgREST filter, e.g. "id=eq.123".
function patchSupabase_(table, filterQuery, patch) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, code: 0, text: "SUPABASE_URL/SUPABASE_SERVICE_KEY not set" };
  try {
    var res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filterQuery, {
      method: "patch",
      contentType: "application/json",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      payload: JSON.stringify(patch),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      var text = res.getContentText();
      Logger.log("patchSupabase_(" + table + ") HTTP " + code + ": " + text);
      return { ok: false, code: code, text: text };
    }
    return { ok: true, code: code, text: "" };
  } catch (e) {
    Logger.log("patchSupabase_(" + table + ") failed: " + e.message);
    return { ok: false, code: -1, text: e.message };
  }
}

// ── Supabase-primary tables (config, stock_branch, shipments, tournament_*,
// wakagym_events, player_stats — migrated one at a time). These tables read
// and write Supabase directly instead of the Sheet; mirrorToReportSheet_
// keeps a human-readable copy in the separate REPORT_SHEET_ID spreadsheet.
function supabaseSelect_(table, query) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return [];
  var url = SUPABASE_URL + "/rest/v1/" + table + (query ? "?" + query : "");
  var res = UrlFetchApp.fetch(url, {
    method: "get",
    headers: {
      apikey: SUPABASE_SERVICE_KEY,
      Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
    },
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error("supabaseSelect_(" + table + ") HTTP " + code + ": " + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

// Upserts one row into REPORT_SHEET_ID's tab (creating the tab + header if
// missing). Best-effort only — a report-sheet outage must never break a
// Supabase-primary write, so this never throws.
// `keyCol` is either a single column name (existing behavior) or an array of
// column names for tables with a composite key (e.g. stock_branch's
// name+branch) — every column in the array must match for a row to be
// treated as the same record.
function mirrorToReportSheet_(tabName, header, keyCol, obj) {
  if (!REPORT_SHEET_ID) return;
  try {
    var rss = SpreadsheetApp.openById(REPORT_SHEET_ID);
    var ws = rss.getSheetByName(tabName);
    if (!ws) {
      ws = rss.insertSheet(tabName);
      ws.appendRow(header);
    }
    var keyCols = Array.isArray(keyCol) ? keyCol : [keyCol];
    var keyIdxs = keyCols.map(function(k) { return header.indexOf(k); });
    var rowArr = header.map(function(h) {
      var v = obj[h];
      if (v === null || v === undefined) return "";
      return (typeof v === "object") ? JSON.stringify(v) : v;
    });
    var data = ws.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      var isMatch = keyIdxs.every(function(idx, ki) { return String(data[i][idx]) === String(obj[keyCols[ki]]); });
      if (isMatch) {
        ws.getRange(i + 1, 1, 1, rowArr.length).setValues([rowArr]);
        return;
      }
    }
    ws.appendRow(rowArr);
  } catch (e) {
    Logger.log("mirrorToReportSheet_(" + tabName + ") failed: " + e.message);
  }
}

// ── _config: Supabase-primary (Phase 1 of the Sheet→Supabase migration) ──
function getConfig_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("config_map");
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through and refetch */ }
  }
  var map = {};
  try {
    var rows = supabaseSelect_("config", "select=key,value");
    rows.forEach(function(r) { if (r.key) map[r.key] = r.value; });
  } catch (e) {
    Logger.log("getConfig_ Supabase read failed: " + e.message);
  }
  // Safety net: if Supabase gave back nothing (misconfigured
  // SUPABASE_URL/SUPABASE_SERVICE_KEY, outage, etc.) fall back to the _config
  // Sheet tab directly rather than serving customers an empty config (bank
  // account, delivery fee) — this must never go blank.
  if (Object.keys(map).length === 0) {
    try {
      var cfgWsFallback = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_CONFIG);
      var cfgRowsFallback = cfgWsFallback ? cfgWsFallback.getDataRange().getValues() : [];
      for (var j = 1; j < cfgRowsFallback.length; j++) {
        if (cfgRowsFallback[j][0]) map[String(cfgRowsFallback[j][0])] = String(cfgRowsFallback[j][1] || "");
      }
      if (Object.keys(map).length > 0) Logger.log("getConfig_ fell back to the _config Sheet tab");
    } catch (e2) {
      Logger.log("getConfig_ Sheet fallback failed: " + e2.message);
    }
  }
  if (Object.keys(map).length > 0) cache.put("config_map", JSON.stringify(map), 120);
  return map;
}

function setConfig_(key, value) {
  var pushResult = pushToSupabase_("config", { key: key, value: value });
  mirrorToReportSheet_("_config", SUPABASE_CONFIG_HEADER, "key", { key: key, value: value });
  CacheService.getScriptCache().remove("config_map");
  return pushResult;
}

// data: { config: {key1: value1, key2: value2, ...} } — batch update, used by
// the Streamlit settings page. Protected: not in PUBLIC_ACTIONS_POST, so
// callers must pass the shared secret via ?_s=.
function handleSetConfig(data) {
  try {
    var cfg = data.config || {};
    var keys = Object.keys(cfg);
    if (!keys.length) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing config" })));
    }
    var results = {};
    keys.forEach(function(k) { results[k] = setConfig_(k, String(cfg[k])); });
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, updated: keys.length, results: results })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// Builds a plain object {column: value} from a sheet header row + one data
// row, converting "" -> null and JSON.parse-ing the given jsonFields so
// they land as real jsonb in Supabase instead of an escaped string.
function sheetRowToObject_(header, rowArr, jsonFields) {
  var obj = {};
  for (var i = 0; i < header.length; i++) {
    var v = rowArr[i];
    obj[header[i]] = (v === "" || v === undefined) ? null : v;
  }
  (jsonFields || []).forEach(function(f) {
    if (obj[f]) {
      try { obj[f] = JSON.parse(obj[f]); } catch (e) { /* leave as-is */ }
    }
  });
  return obj;
}

// Re-reads the current row for the given id from `tabName` (by its first
// column) and pushes the full row to Supabase — always accurate regardless
// of which fields the caller just changed, and safe to call unconditionally
// after any write to that row.
//
// `header` is passed in explicitly rather than read from the sheet's own
// row 1: tournament_reg's live header has a blank trailing cell (the tab
// predates the selected_categories column being added — same drift found
// while writing tools/supabase_backfill.py), so trusting row 1 text would
// intermittently push a "" key and fail with PGRST204.
function syncRowToSupabase_(ss, tabName, idValue, supabaseTable, header, jsonFields) {
  try {
    var ws = ss.getSheetByName(tabName);
    if (!ws) return;
    var rows = ws.getDataRange().getValues();
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][0]) === String(idValue)) {
        pushToSupabase_(supabaseTable, sheetRowToObject_(header, rows[i], jsonFields));
        return;
      }
    }
  } catch (e) {
    Logger.log("syncRowToSupabase_(" + tabName + ") failed: " + e.message);
  }
}

var SUPABASE_ORDERS_HEADER = [
  "order_id", "timestamp", "line_user_id", "display_name",
  "items_json", "total", "branch", "real_name", "phone", "address", "email",
  "slip_status", "slip_url", "slip_amount", "slip_txn_id", "notes",
  "fulfillment", "fulfilled_at", "staff_confirmed_at", "customer_confirmed_at",
  "notified_at",
];
var SUPABASE_TOURNAMENT_REG_HEADER = [
  "reg_id", "timestamp", "event_id", "sequence_no", "line_user_id", "display_name",
  "real_name", "player_name", "phone", "facebook", "slip_url", "slip_status",
  "payment_method", "bank", "amount_paid", "status", "checked_in_at", "note",
  "selected_categories",
];
var SUPABASE_WAKAGYM_REG_HEADER = [
  "reg_id", "timestamp", "event_date", "group_id", "event_id", "line_user_id", "display_name",
  "real_name", "player_name", "phone", "slip_url", "slip_status", "payment_method",
  "bank", "placement", "wins_3match", "tokens_earned", "promo_packs", "rewards_given", "note",
];
var SUPABASE_CATALOG_HEADER = [
  "name", "category", "slug", "cost_box", "cost_p", "price_box", "price_pack",
  "qty_box", "qty_pack", "limit_box", "limit_pack", "active", "image_url", "barcode", "notice",
];
var SUPABASE_CONFIG_HEADER = ["key", "value"];
var SUPABASE_STOCK_BRANCH_HEADER = ["name", "category", "branch", "qty_box", "qty_pack"];
var SUPABASE_TOURNAMENT_EVENTS_HEADER = [
  "event_id", "name", "date", "entry_fee", "max_players",
  "rules_text", "registration_close", "status", "created_at",
];
var SUPABASE_TOURNAMENT_CATEGORIES_HEADER = [
  "category_id", "event_id", "name", "entry_fee", "max_players", "sort_order", "status",
];
var SUPABASE_WAKAGYM_EVENTS_HEADER = ["event_id", "date", "branch", "tier", "entry_fee", "status", "created_by"];
var SUPABASE_PLAYER_STATS_HEADER = [
  "player_name", "display_name", "real_name", "line_user_id", "total_plays",
  "total_tokens", "boxes_earned", "boxes_given", "last_play_date",
];
// No "id" here — it's a DB-generated surrogate (shipment_id isn't reliably
// unique historically, see supabase/schema.sql), not meaningful for the
// human-readable report-sheet mirror keyed by the business id instead.
var SUPABASE_SHIPMENTS_HEADER = ["shipment_id", "timestamp", "to_branch", "status", "items_json", "received_at"];
var SUPABASE_WITHDRAWALS_HEADER = ["timestamp", "branch", "name", "type", "qty", "reason"];
var SUPABASE_STOCK_RETURNS_HEADER = ["timestamp", "branch", "name", "qty_box", "qty_pack"];
var SUPABASE_WALKIN_SALES_HEADER = ["sale_id", "timestamp", "branch", "items_json", "total", "payment_method", "bank"];

const TAB_ORDERS  = "orders";
const TAB_CONFIG  = "_config";
const TAB_WAKAGYM_REG = "wakagym_reg";
const TAB_PLAYER_STATS   = "player_stats";
const TAB_WAKAGYM_EVENTS = "wakagym_events";

const BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์"];

const TIER_CONFIG = {
  S:  { min: 2, max: 4,  fee: 100 },
  M:  { min: 5, max: 8,  fee: 150 },
  L:  { min: 9, max: 15, fee: 200 },
  XL: { min: 16, max: 999, fee: 200 },
};

const TOKEN_TABLE = {
  S:  { "1st": 4,  "2nd": 2,  "3rd-4th": 2, "5th+": 0 },
  M:  { "1st": 8,  "2nd": 4,  "3rd-4th": 2, "5th+": 2 },
  L:  { "1st": 15, "2nd": 7,  "3rd-4th": 4, "5th+": 2 },
  XL: { "1st": 30, "2nd": 10, "3rd-4th": 5, "5th+": 2 },
};

const TOKEN_BOX_THRESHOLD = 30;

// จำนวน promo pack ตามจำนวน wins ใน 3-match (0-3)
// 0 wins = 1 ซอง (ทุกคนได้อย่างน้อย 1), 3 wins = 3 ซอง — แก้ได้ตรงนี้
const PROMO_TABLE = { 0: 1, 1: 1, 2: 2, 3: 3 };

function _cors(output) {
  return output.setMimeType(ContentService.MimeType.JSON);
}

// GET: โหลด catalog หรือ ลูกค้ากดยืนยันรับของ
// Public (ไม่ต้อง _s): catalog, confirm, order_status, customer_confirm, wakagym_status
// Staff only (ต้อง _s): ทุกอย่างอื่น
var PUBLIC_API_DOS = ["order_status", "customer_confirm", "wakagym_status",
                     "tournament_status", "tournament_reg_status"];

function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || "";
    var doParam = e.parameter.do || "";

    var isPublic = (action === "confirm") ||
                   (action === "") ||
                   (action === "api" && PUBLIC_API_DOS.indexOf(doParam) >= 0);

    if (!isPublic && SCRIPT_SECRET && (e.parameter._s || "") !== SCRIPT_SECRET) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }

    if (action === "confirm") {
      return handleCustomerConfirm(e.parameter.order || "", e);
    }
    if (action === "staff") {
      return handleStaffPage(e.parameter.order || "", e.parameter.do || "");
    }
    if (action === "api") {
      return handleApi(e.parameter);
    }

    var cache = CacheService.getScriptCache();
    var cached = cache.get("catalog_config");
    if (cached) return _cors(ContentService.createTextOutput(cached));

    var catSbRows = supabaseSelect_("catalog", "select=*");
    var catalog = [];
    for (var i = 0; i < catSbRows.length; i++) {
      var cr = catSbRows[i];
      if (!cr.name) continue;
      var active = cr.active;
      if (active === false || active === "FALSE" || active === 0) continue;
      catalog.push({
        name:       String(cr.name),
        category:   String(cr.category || ""),
        price_box:  Number(cr.price_box)  || 0,
        price_pack: Number(cr.price_pack) || 0,
        imageUrl:   _driveUrl(String(cr.image_url || "")),
        slug:       String(cr.slug || ""),
        limit_box:  (cr.limit_box === "" || cr.limit_box === undefined || cr.limit_box === null) ? -1 : Number(cr.limit_box),
        limit_pack: (cr.limit_pack === "" || cr.limit_pack === undefined || cr.limit_pack === null) ? -1 : Number(cr.limit_pack),
        barcode:    String(cr.barcode || ""),
        notice:     String(cr.notice || ""),
        qty_box:    Number(cr.qty_box)  || 0,
        qty_pack:   Number(cr.qty_pack) || 0,
      });
    }

    var config = getConfig_();

    var jsonOut = JSON.stringify({ catalog: catalog, config: config });
    cache.put("catalog_config", jsonOut, 300);
    return _cors(ContentService.createTextOutput(jsonOut));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function handleCustomerConfirm(orderId, e) {
  var url = "https://waka-liff.vercel.app/confirm.html?order=" + encodeURIComponent(orderId || "");
  return HtmlService.createHtmlOutput('<script>window.top.location.href="' + url + '";</script>');
}

// POST: รับ order จาก LIFF หรือ internal actions
// Public POST (ไม่ต้อง _s): LINE webhook, สั่งซื้อ (data.items), wakagymRegister
var PUBLIC_ACTIONS_POST = ["wakagymRegister", "tournamentRegister"];

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var isPublicPost = Array.isArray(data.events) ||
                       (data.items && !data._action) ||
                       (data._action && PUBLIC_ACTIONS_POST.indexOf(data._action) >= 0);

    if (!isPublicPost && SCRIPT_SECRET && (e.parameter._s || "") !== SCRIPT_SECRET) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }

    if (data._action === "createShipment") {
      return handleCreateShipment(data);
    }

    if (data._action === "receiveShipment") {
      return handleReceiveShipment(data);
    }

    if (data._action === "cancelShipment") {
      return handleCancelShipment(data);
    }

    if (data._action === "handoverOrder") {
      return handleHandoverOrder(data);
    }

    if (data._action === "partialReady") {
      return handlePartialReady(data);
    }

    if (data._action === "partialCancelItems") {
      return handlePartialCancelItems(data);
    }

    if (data._action === "addStock") {
      return handleAddStock(data);
    }

    if (data._action === "addProduct") {
      return handleAddProduct(data);
    }

    if (data._action === "updateProduct") {
      return handleUpdateProduct(data);
    }

    if (data._action === "withdrawStock") {
      return handleWithdrawStock(data);
    }

    if (data._action === "returnStock") {
      return handleReturnStock(data);
    }

    if (data._action === "walkinSale") {
      return handleWalkinSale(data);
    }

    if (data._action === "setConfig") {
      return handleSetConfig(data);
    }

    if (data._action === "uploadProductImage") {
      return handleUploadProductImage(data);
    }

    if (data._action === "confirmSlip") {
      return handleConfirmSlip(data);
    }

    if (data._action === "rejectSlip") {
      return handleRejectSlip(data);
    }

    if (data._action === "notifyCustomer") {
      return handleNotifyCustomer(data);
    }

    if (data._action === "wakagymRegister") {
      return handleWakagymRegister(data);
    }

    if (data._action === "tournamentRegister") {
      return handleTournamentRegister(data);
    }

    if (data._action === "notifyTournamentPlayers") {
      return handleNotifyTournamentPlayers(data);
    }

    if (data.action === "api") {
      return handleApi(data);
    }

    if (Array.isArray(data.events)) {
      for (var ev = 0; ev < data.events.length; ev++) {
        var evt = data.events[ev];
        var src = evt.source || {};
        var msgText = (evt.message && evt.message.text) || "";
        if (src.type === "group" && src.groupId && msgText.trim() === "!waka-setup") {
          setConfig_("group_staff", src.groupId);
          _linePush(src.groupId, "ตั้งค่ากลุ่ม staff สำเร็จ!\nGroup ID: " + src.groupId);
        }
        if (src.userId && msgText.trim() === "!waka-finance") {
          setConfig_("finance_line_id", src.userId);
          _linePush(src.userId, "ตั้งค่าบัญชีสำเร็จ ✅\nระบบจะแจ้งเตือนเมื่อมีสลิปมีปัญหา\n\nUser ID: " + src.userId);
        }
      }
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
    }

    // Anything reaching this point falls through to order creation below —
    // guard against any unrecognized/malformed POST (e.g. a typo'd _action,
    // a future action added to the dispatch list above but not yet deployed,
    // or a stray request hitting the endpoint) silently creating an empty
    // order. A real checkout always has at least one item.
    if (!Array.isArray(data.items) || data.items.length === 0) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: "unknown action or empty order" })));
    }

    var ss = SpreadsheetApp.openById(SHEET_ID);

    var slipStatus = "ไม่มีสลิป";
    var slipNote   = "ลูกค้าไม่ได้แนบสลิป";
    var slipUrl    = "";
    var slipAmount = "";
    var slipTxnId  = "";
    var slipDate   = "";

    if (data.slipBase64) {
      var verify = verifySlipWithSlipOK(data.slipBase64, data.total);
      var slipokError = verify.error || "";
      if (verify.error) verify = verifySlipWithClaude(data.slipBase64);
      slipAmount = verify.amount || "";
      slipTxnId  = verify.ref || "";
      slipDate   = verify.date || "";

      var isSlipOK = verify.source === "slipok";

      var fallbackInfo = slipokError ? " [SlipOK: " + slipokError + "]" : "";

      if (!verify.amount) {
        slipStatus = "รอตรวจ";
        slipNote   = (verify.error || "อ่านสลิปไม่ได้") + fallbackInfo;
      } else if (!isSlipOK && verify.suspicious) {
        slipStatus = "สงสัยปลอม";
        slipNote   = "Claude: " + (verify.suspicious_reason || "สลิปมีลักษณะผิดปกติ");
      } else if (slipTxnId && isDuplicateSlip(ss, slipTxnId)) {
        slipStatus = "สลิปซ้ำ";
        slipNote   = "เลขอ้างอิง " + slipTxnId + " เคยใช้แล้ว";
      } else if (Number(verify.amount) < Number(data.total)) {
        slipStatus = "ยอดไม่ตรง";
        var src = isSlipOK ? "SlipOK" : "Claude";
        slipNote   = src + ": สลิป " + verify.amount + " บาท แต่ออเดอร์ " + data.total + " บาท" + fallbackInfo;
      } else if (isSlipOK) {
        slipStatus = "ยืนยัน";
        slipNote   = "SlipOK (QR verified): ยอดตรง " + verify.amount + " บาท, " + (verify.bank || "") + " " + (verify.date || "") + " " + (verify.to_name || "");
      } else {
        var cfgWs2 = ss.getSheetByName(TAB_CONFIG);
        var shopAcct = _getConfigValue(cfgWs2, "bank_account") || "";
        var shopNameTh = _getConfigValue(cfgWs2, "bank_account_name") || "";
        var shopNameEn = _getConfigValue(cfgWs2, "bank_account_name_en") || "";
        var shopNames = [];
        shopNameTh.split("|").forEach(function(n) { n = n.trim(); if (n) shopNames.push(n.toLowerCase()); });
        shopNameEn.split("|").forEach(function(n) { n = n.trim(); if (n) shopNames.push(n.toLowerCase()); });

        var amtOk = Number(verify.amount) >= Number(data.total);
        var acctOk = !shopAcct || !verify.to_account || isPartialMatch(verify.to_account, shopAcct);
        var slipNameStr = String(verify.to_name || "").toLowerCase();
        var nameOk = !verify.to_name;
        var nameClose = false;
        if (!nameOk) {
          for (var ni = 0; ni < shopNames.length; ni++) {
            if (nameMatch(slipNameStr, shopNames[ni])) { nameOk = true; break; }
          }
        }
        if (!nameOk && verify.to_name) {
          var bestSim = 0;
          for (var si = 0; si < shopNames.length; si++) {
            bestSim = Math.max(bestSim, nameSimilarity(slipNameStr, shopNames[si]));
          }
          if (bestSim >= 0.7) nameClose = true;
        }

        var details = [];
        details.push("ยอด: " + (amtOk ? "✅ ตรง" : "❌ สลิป " + verify.amount + " ≠ ออเดอร์ " + data.total));
        details.push("บัญชี: " + (acctOk ? "✅ ตรง" : "❌ อ่านได้ " + (verify.to_account || "-") + " ≠ " + shopAcct));
        details.push("ชื่อ: " + (nameOk ? "✅ ตรง" : nameClose ? "⚠️ ใกล้เคียง " + (verify.to_name || "-") : "❌ อ่านได้ " + (verify.to_name || "-")));

        if (amtOk && acctOk && (nameOk || nameClose)) {
          slipStatus = "ยืนยัน";
          if (nameClose && !nameOk) {
            slipNote = "✅ ยอดตรง ✅ บัญชีตรง\n⚠️ ชื่อใกล้เคียง (" + (verify.to_name || "") + ")\nระบบยืนยันอัตโนมัติ กรุณาตรวจชื่อบัญชีอีกครั้ง" + fallbackInfo;
          } else {
            slipNote = "✅ ยอดตรง ✅ บัญชีตรง ✅ ชื่อตรง" + fallbackInfo;
          }
        } else if (amtOk && acctOk && !nameOk) {
          slipStatus = "รอตรวจเพิ่ม";
          slipNote = "✅ ยอดตรง ✅ บัญชีตรง\n⚠️ ชื่อไม่ตรง (" + (verify.to_name || "-") + ")\nadmin กรุณาตรวจชื่อบัญชีอีกครั้ง" + fallbackInfo;
        } else {
          slipStatus = "รอตรวจเพิ่ม";
          slipNote   = (amtOk ? "✅ ยอดตรง" : "❌ ยอดไม่ตรง (สลิป " + verify.amount + " ≠ ออเดอร์ " + data.total + ")")
            + "\n" + (acctOk ? "✅ บัญชีตรง" : "❌ บัญชีไม่ตรง (" + (verify.to_account || "-") + ")")
            + "\n" + (nameOk ? "✅ ชื่อตรง" : "❌ ชื่อไม่ตรง (" + (verify.to_name || "-") + ")")
            + "\nadmin กรุณาเช็คแอปธนาคาร" + fallbackInfo;
        }
      }
    }

    // ── Lock เฉพาะช่วงวิกฤต: ตรวจ + หักสต็อก + บันทึกออเดอร์ ──
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: "ระบบยุ่งอยู่ กรุณาลองใหม่สักครู่" })));
    }
    var orderId = _genOrderId();

    // ── ตรวจ limit + หักสต็อก — อ่าน catalog จาก Supabase ครั้งเดียว ส่งต่อทั้ง 3 ฟังก์ชัน ──
    var catRowsForOrder = null;
    if (data.items && data.items.length > 0) {
      catRowsForOrder = _fetchCatalogRows_();
      var limitCheck = checkCatalogLimits(data.items, catRowsForOrder);
      if (limitCheck.error) {
        try { lock.releaseLock(); } catch(_) {}
        return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: limitCheck.error })));
      }
      // ทำเครื่องหมาย preorder items — limit มีค่าแต่ stock = 0
      // ใช้ตอน cancel เพื่อข้ามการคืน qty_box/pack (ไม่เคยหักจริง)
      for (var pi = 0; pi < data.items.length; pi++) {
        var pIt = data.items[pi];
        var pRow = _findCatalogRow_(catRowsForOrder, pIt.name);
        if (!pRow) continue;
        var pLimitField = pIt.type === "box" ? "limit_box" : "limit_pack";
        var pStockField = pIt.type === "box" ? "qty_box" : "qty_pack";
        var pLimit = pRow[pLimitField];
        var pHasLimit = !(pLimit === "" || pLimit === undefined || pLimit === null);
        if (pHasLimit && (Number(pRow[pStockField]) || 0) === 0) {
          pIt._preorder = true;
        }
      }
    }

    // Supabase is the store of record for orders (Phase 2) — writing here is
    // what makes the order succeed or fail; a throw propagates to doPost's
    // top-level catch, which releases the lock and reports the error.
    var newOrder = {
      order_id: orderId,
      timestamp: Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'"),
      line_user_id: data.lineUserId || null,
      display_name: _sanitize(data.displayName) || null,
      items_json: data.items || [],
      total: data.total || 0,
      branch: data.branch || null,
      real_name: _sanitize(data.realName) || null,
      phone: _sanitize(data.phone) || null,
      address: _sanitize(data.address) || null,
      email: _sanitize(data.email) || null,
      slip_status: slipStatus,
      slip_url: slipUrl || null,
      slip_amount: slipAmount || null,
      slip_txn_id: slipTxnId || null,
      notes: slipNote || null,
      fulfillment: null,
      fulfilled_at: null,
      staff_confirmed_at: null,
      customer_confirmed_at: null,
      notified_at: null,
    };
    writeSupabaseOrder_(newOrder);
    _clearDashCache();

    if (data.items && data.items.length > 0) {
      // ส่ง rows เดิมให้แชร์กัน — deductCatalogLimits อัปเดต rows ใน memory แล้ว return คืน
      var updatedRows = deductCatalogLimits(data.items, catRowsForOrder);
      deductStock(data.items, updatedRows || catRowsForOrder);
    }

    // อัปโหลดสลิปหลัง write order — นอก lock เพราะ Drive upload ช้า
    if (data.slipBase64 && !slipUrl) {
      try {
        slipUrl = saveSlipToDrive(data.slipBase64, orderId);
        if (slipUrl) {
          newOrder.slip_url = slipUrl;
          writeSupabaseOrder_(newOrder);
        }
      } catch(_) {}
    }

    lock.releaseLock();

    // LINE push หลัง release lock — ไม่ block order ถัดไป
    try {
      var cfgWs   = ss.getSheetByName(TAB_CONFIG);
      var financeId = _getConfigValue(cfgWs, "finance_line_id");
      var streamlitUrl = "https://waka-tournament-e6wsqmhuhhexratyiub65f.streamlit.app/orders";
      if (financeId) {
        var itemsSummary = (data.items || []).map(function(i) {
          var u = i.type === "box" ? "กล่อง" : "ซอง";
          return "  - " + i.name + " (" + u + ") x" + (i.qty || 1);
        }).join("\n");

        var transferAgo = "";
        if (slipDate) {
          try {
            var now = new Date();
            var slip = new Date(slipDate);
            if (!isNaN(slip.getTime())) {
              var diffMs = now.getTime() - slip.getTime();
              var diffMin = Math.floor(diffMs / 60000);
              if (diffMin < 1) transferAgo = "โอนเมื่อสักครู่";
              else if (diffMin < 60) transferAgo = "โอนเมื่อ " + diffMin + " นาทีที่แล้ว";
              else if (diffMin < 1440) transferAgo = "โอนเมื่อ " + Math.floor(diffMin / 60) + " ชั่วโมงที่แล้ว";
              else transferAgo = "⚠️ โอนเมื่อ " + Math.floor(diffMin / 1440) + " วันที่แล้ว!";
            }
          } catch(_) {}
        }

        if (slipStatus === "ยืนยัน") {
          var finMsg = "✅ ออเดอร์ยืนยันแล้ว #" + orderId
            + "\nลูกค้า: " + (data.displayName || "") + (data.realName ? " (" + data.realName + ")" : "")
            + "\nยอด: " + data.total + " บาท"
            + "\n\n" + itemsSummary;
          if (slipDate) finMsg += "\n\n📅 วันที่โอน: " + slipDate;
          if (transferAgo) finMsg += "\n⏱️ " + transferAgo;
          _linePush(financeId, finMsg);
        } else {
          var problemLabel = {
            "ยอดไม่ตรง": "💰 ยอดเงินไม่ตรง",
            "บัญชีไม่ตรง": "🏦 บัญชีไม่ตรง",
            "สลิปซ้ำ": "🔁 สลิปซ้ำ (เลขอ้างอิงเคยใช้แล้ว)",
            "สงสัยปลอม": "🚨 สงสัยสลิปปลอม",
            "รอตรวจ": "🔍 อ่านสลิปไม่ได้",
            "รอตรวจเพิ่ม": "🔍 ต้องตรวจเพิ่ม",
            "ไม่มีสลิป": "📩 ไม่ได้แนบสลิป"
          };
          var icon = slipStatus === "ไม่มีสลิป" ? "📩" : "⚠️";
          var finMsg2 = icon + " ออเดอร์มีปัญหา #" + orderId
            + "\nลูกค้า: " + (data.displayName || "") + (data.realName ? " (" + data.realName + ")" : "")
            + "\nสาขา: " + (data.branch || "")
            + "\nยอด: " + data.total + " บาท"
            + "\n\n" + itemsSummary
            + "\n\n❌ ปัญหา: " + (problemLabel[slipStatus] || slipStatus);
          if (slipNote) finMsg2 += "\n📋 " + slipNote;
          if (slipDate) finMsg2 += "\n\n📅 วันที่โอน: " + slipDate;
          if (transferAgo) finMsg2 += "\n⏱️ " + transferAgo;
          finMsg2 += "\n\nตรวจสอบ:\n" + streamlitUrl;
          _linePush(financeId, finMsg2);
        }
      }
      if (data.lineUserId) notifyCustomer(data.lineUserId, { orderId: orderId, items: data.items, displayName: data.displayName, branch: data.branch, address: data.address, total: data.total, slipStatus: slipStatus });
    } catch(_) {}

    return _cors(ContentService.createTextOutput(JSON.stringify({ success: true, orderId: orderId, slipStatus: slipStatus })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: err.message })));
  }
}

// ── Catalog: ตรวจ limit + หักสต็อก (Supabase-primary) ───────────────────────
// `_rows` เป็น array ของ catalog object จาก Supabase — ส่งต่อกันได้เพื่อลด
// จำนวนครั้งที่ยิง supabaseSelect_ ในหนึ่ง request (เดิมคือ Sheet row array,
// ตอนนี้เป็น object ที่มี field name ตรง ๆ แทนการ index คอลัมน์)
function _fetchCatalogRows_() {
  return supabaseSelect_("catalog", "select=*");
}
function _findCatalogRow_(rows, name) {
  var n = String(name).trim();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].name).trim() === n) return rows[i];
  }
  return null;
}
// เขียน row ที่เปลี่ยนกลับ Supabase + mirror — เรียกหลังแก้ rows ใน memory
function _pushCatalogRows_(rows, changedNames) {
  var names = {};
  changedNames.forEach(function(n) { names[String(n).trim()] = true; });
  rows.forEach(function(r) {
    if (!names[String(r.name).trim()]) return;
    var res = pushToSupabase_("catalog", r);
    if (!res.ok) throw new Error("Supabase catalog write failed (" + r.name + "): " + res.text);
    mirrorToReportSheet_("catalog", SUPABASE_CATALOG_HEADER, "name", r);
  });
}

// checkCatalogLimits: ตรวจ limit_box/limit_pack และ actual stock (qty_box/qty_pack)
function checkCatalogLimits(items, _rows) {
  var rows = _rows || _fetchCatalogRows_();
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    var row = _findCatalogRow_(rows, item.name);
    if (!row) continue;
    var limitField = item.type === "box" ? "limit_box" : "limit_pack";
    var stockField = item.type === "box" ? "qty_box" : "qty_pack";
    var limit = row[limitField];
    if (!(limit === "" || limit === undefined || limit === null)) {
      limit = Number(limit);
      if (item.qty > limit) {
        var unitLabel = item.type === "box" ? "กล่อง" : "ซอง";
        if (limit <= 0) return { error: item.name + " (" + unitLabel + ") สินค้าหมดแล้ว" };
        return { error: item.name + " (" + unitLabel + ") เหลือเพียง " + limit + " " + unitLabel };
      }
    }
    // ตรวจ actual stock — แจ้งเตือนถ้าสต็อกกลางไม่พอ
    var stock = Number(row[stockField]) || 0;
    if (stock > 0 && item.qty > stock) {
      var ul = item.type === "box" ? "กล่อง" : "ซอง";
      return { error: item.name + " (" + ul + ") สต็อกกลางไม่พอ (เหลือ " + stock + ")" };
    }
  }
  return { ok: true };
}

// deductCatalogLimits: หัก limit_box/pack — รับ rows เพื่อแชร์การอ่าน
function deductCatalogLimits(items, _rows) {
  var rows = _rows || _fetchCatalogRows_();
  var changedNames = [];
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    var row = _findCatalogRow_(rows, item.name);
    if (!row) continue;
    var limitField = item.type === "box" ? "limit_box" : "limit_pack";
    var limit = row[limitField];
    if (limit === "" || limit === undefined || limit === null) continue;
    row[limitField] = Math.max(0, Number(limit) - (item.qty || 1));
    changedNames.push(item.name);
  }
  if (changedNames.length) {
    CacheService.getScriptCache().remove("catalog_config");
    _pushCatalogRows_(rows, changedNames);
  }
  return rows;
}

// deductStock: หัก qty_box/pack — รับ rows เพื่อแชร์การอ่าน
function deductStock(items, _rows) {
  var rows = _rows || _fetchCatalogRows_();
  var changedNames = [];
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    var row = _findCatalogRow_(rows, item.name);
    if (!row) continue;
    var qtyField = item.type === "box" ? "qty_box" : "qty_pack";
    row[qtyField] = Math.max(0, (Number(row[qtyField]) || 0) - (item.qty || 1));
    changedNames.push(item.name);
  }
  if (changedNames.length) _pushCatalogRows_(rows, changedNames);
  return rows;
}

function restoreStock(items) {
  var rows = _fetchCatalogRows_();
  var changedNames = [];
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    // _preorder = true หมายความว่าตอนสั่งซื้อ qty_box/pack เป็น 0 → deductStock ไม่ได้หักจริง
    // จึงไม่คืน qty กลับ (ป้องกัน ghost stock)
    if (item._preorder) continue;
    var row = _findCatalogRow_(rows, item.name);
    if (!row) continue;
    var qtyField = item.type === "box" ? "qty_box" : "qty_pack";
    row[qtyField] = (Number(row[qtyField]) || 0) + (item.qty || 1);
    changedNames.push(item.name);
  }
  if (changedNames.length) _pushCatalogRows_(rows, changedNames);
}

function restoreCatalogLimits(items) {
  var rows = _fetchCatalogRows_();
  var changedNames = [];
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    var row = _findCatalogRow_(rows, item.name);
    if (!row) continue;
    var limitField = item.type === "box" ? "limit_box" : "limit_pack";
    var limit = row[limitField];
    if (limit === "" || limit === undefined || limit === null) continue;
    row[limitField] = (Number(limit) || 0) + (item.qty || 1);
    changedNames.push(item.name);
  }
  if (changedNames.length) {
    CacheService.getScriptCache().remove("catalog_config");
    _pushCatalogRows_(rows, changedNames);
  }
}

// ── stock_branch (Supabase-primary, composite key name+branch) ─────────────
function _fetchStockBranchRows_(branchFilter) {
  var q = "select=*" + (branchFilter ? "&branch=eq." + encodeURIComponent(branchFilter) : "");
  return supabaseSelect_("stock_branch", q);
}
function _findStockBranchRow_(rows, name, branch) {
  var n = String(name).trim(), b = String(branch).trim();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].name).trim() === n && String(rows[i].branch).trim() === b) return rows[i];
  }
  return null;
}
// Optional `lock` — see writeSupabaseOrder_'s comment (release-before-mirror,
// same lock-contention reasoning).
function _writeStockBranchRow_(row, lock) {
  var res = pushToSupabase_("stock_branch", row);
  if (!res.ok) throw new Error("Supabase stock_branch write failed (" + row.name + "/" + row.branch + "): " + res.text);
  if (lock) { try { lock.releaseLock(); } catch (_) {} }
  mirrorToReportSheet_("stock_branch", SUPABASE_STOCK_BRANCH_HEADER, ["name", "branch"], row);
  return row;
}

function _clearDashCache() {
  try { CacheService.getScriptCache().remove("dashboard_v1"); } catch(_) {}
}

function notifyBranch(groupId, order) {
  var items = (order.items || []).map(function(i) {
    var unitLabel = i.type === "box" ? "กล่อง" : "ซอง";
    return "  - " + i.name + " (" + unitLabel + ") x" + i.qty + " = " + (i.price * i.qty) + " บาท";
  }).join("\n");
  var isDelivery = order.branch === "จัดส่ง";
  var staffUrl = "https://waka-liff.vercel.app/staff.html?order=" + order.orderId;
  var lines = [
    "ออเดอร์ใหม่ #" + order.orderId,
    "ลูกค้า: " + order.displayName + (order.realName ? " (" + order.realName + ")" : ""),
    "โทร: " + order.phone,
    isDelivery ? "จัดส่งพัสดุ" : "รับที่: " + order.branch,
  ];
  if (isDelivery && order.address) lines.push("ที่อยู่: " + order.address);
  lines.push("", items, "", "ยอดรวม: " + order.total + " บาท", "สลิป: " + order.slipStatus, "", "จัดการออเดอร์:", staffUrl);
  _linePush(groupId, lines.join("\n"));
}

function notifyCustomer(userId, order) {
  var items = (order.items || []).map(function(i) {
    var unitLabel = i.type === "box" ? "กล่อง" : "ซอง";
    return "  - " + i.name + " (" + unitLabel + ") x" + i.qty;
  }).join("\n");
  var isDelivery = order.branch === "จัดส่ง";
  var lines = [
    "รับออเดอร์แล้ว #" + order.orderId,
    "",
    items,
    "",
    "ยอดรวม: " + order.total + " บาท",
    isDelivery ? "จัดส่งพัสดุ" : "รับที่สาขา: " + order.branch,
  ];
  if (isDelivery && order.address) {
    lines.push("ที่อยู่จัดส่ง: " + order.address);
    lines.push("");
    lines.push("หากที่อยู่ไม่ถูกต้อง กรุณาแจ้งพนักงานหรือแอดมินเพื่อดำเนินการแก้ไขด่วนครับ");
  }
  lines.push("");
  if (order.slipStatus === "สลิปซ้ำ") {
    lines.push("⚠️ ตรวจพบสลิปนี้เคยถูกใช้แล้ว");
    lines.push("หากคุณสั่งซื้อซ้ำ ทีมงานจะยึดออเดอร์แรกและยกเลิกออเดอร์นี้ให้อัตโนมัติ");
    lines.push("หากมีข้อสงสัยกรุณาติดต่อทีมงาน 🙏");
  } else {
    lines.push("ทีมงานจะตรวจสอบและแจ้งกลับทาง LINE ครับ");
  }
  _linePush(userId, lines.join("\n"));
}

function _linePush(to, text) {
  UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
    method: "post",
    muteHttpExceptions: true,
    headers: {
      Authorization:  "Bearer " + LINE_TOKEN,
      "Content-Type": "application/json",
    },
    payload: JSON.stringify({ to, messages: [{ type: "text", text: text }] }),
  });
}

// `cfgWs` param kept (but unused) so every existing call site — which still
// passes `ss.getSheetByName(TAB_CONFIG)` — keeps working unchanged now that
// _config reads go through Supabase (getConfig_) instead of the Sheet.
function _getConfigValue(cfgWs, key) {
  var v = getConfig_()[key];
  return (v === undefined || v === null || v === "") ? null : String(v);
}


function _genOrderId() {
  var now = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var yy = String(now.getFullYear()).slice(-2);
  var prefix = yy + pad(now.getMonth()+1) + pad(now.getDate());

  var propKey = "order_seq_" + prefix;
  var seq = parseInt(PROPS.getProperty(propKey) || "0", 10) + 1;
  PROPS.setProperty(propKey, String(seq));
  return prefix + String(seq).padStart(3, "0");
}

function saveSlipToDrive(base64, orderId) {
  try {
    const folderId = PROPS.getProperty("SLIP_FOLDER_ID");
    const folder   = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    const bytes    = Utilities.base64Decode(base64);
    const blob     = Utilities.newBlob(bytes, "image/jpeg", "slip_" + orderId + ".jpg");
    const file     = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w800";
  } catch (err) {
    return "";
  }
}

// ── WAKA GYM ────────────────────────────────────────────────────────────────

function _genWakagymRegId() {
  var now = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var yy = String(now.getFullYear()).slice(-2);
  var prefix = "TR" + yy + pad(now.getMonth() + 1) + pad(now.getDate());
  var propKey = "treg_seq_" + prefix;
  var seq = parseInt(PROPS.getProperty(propKey) || "0", 10) + 1;
  PROPS.setProperty(propKey, String(seq));
  return prefix + String(seq).padStart(3, "0");
}

function _ensureTab(ss, tabName, headers) {
  var ws = ss.getSheetByName(tabName);
  if (!ws) {
    ws = ss.insertSheet(tabName);
    ws.appendRow(headers);
  } else if (ws.getLastRow() === 0 || String(ws.getRange(1, 1).getValue()).trim() === "") {
    ws.insertRowBefore(1);
    ws.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return ws;
}

function _getActiveEvent(ss, branch) {
  var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
  var query = "select=event_id,date,branch,tier,entry_fee,status&date=eq." + today + "&status=eq.open";
  if (branch) query += "&branch=eq." + encodeURIComponent(branch);
  var rows = supabaseSelect_("wakagym_events", query);
  if (!rows.length) return null;
  // "most recently created" — event_id is EV{date}-{n}, a lexical sort would
  // put "-10" before "-2", so sort by the numeric suffix instead.
  rows.sort(function(a, b) {
    var na = Number(String(a.event_id).split("-").pop()) || 0;
    var nb = Number(String(b.event_id).split("-").pop()) || 0;
    return na - nb;
  });
  var r = rows[rows.length - 1];
  return {
    event_id: String(r.event_id),
    date: today,
    branch: String(r.branch || ""),
    tier: String(r.tier || "L"),
    entry_fee: Number(r.entry_fee) || 200,
    status: "open",
  };
}

function handleWakagymRegister(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var groupId = _genWakagymRegId();
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var payMethod = data.paymentMethod || "transfer";

    var event = _getActiveEvent(ss, null);
    var entryFee = event ? event.entry_fee : 200;
    var eventId = event ? event.event_id : "";
    var tier = event ? event.tier : "L";

    var slipUrl = "";
    if (data.slipBase64) {
      slipUrl = saveSlipToDrive(data.slipBase64, groupId);
    }
    var slipStatus = payMethod === "cash" ? "cash" : "pending";

    var statsRows = supabaseSelect_("player_stats", "select=*");
    var findStatsRow_ = function(name) {
      for (var i = 0; i < statsRows.length; i++) {
        if (String(statsRows[i].player_name || "").trim() === name) return statsRows[i];
      }
      return null;
    };

    var players = data.players || [];
    if (players.length === 0) {
      players = [{ realName: data.realName || "", playerName: data.playerName || data.realName || "" }];
    }

    // Registers every player's Supabase rows first (fast REST writes, kept
    // under the lock since they read+update the same in-memory statsRows/
    // statsRow to avoid two players in one request racing each other), but
    // defers each row's mirrorToReportSheet_ call (slow full-tab scan) into
    // pendingMirrors — flushed after the lock is released below, so this
    // request's mirror-sheet latency no longer blocks every other
    // concurrent GAS execution through the shared script-wide lock.
    var results = [];
    var pendingMirrors = [];
    for (var p = 0; p < players.length; p++) {
      var pl = players[p];
      var regId = p === 0 ? groupId : _genWakagymRegId();
      var pName = String(pl.playerName || pl.realName || "").trim();
      var rName = String(pl.realName || "").trim();

      var newWakagymObj = {
        reg_id: regId, timestamp: now, event_date: today, group_id: groupId, event_id: eventId || null,
        line_user_id: data.lineUserId || null, display_name: data.displayName || null,
        real_name: rName || null, player_name: pName || null, phone: data.phone || null,
        slip_url: slipUrl || null, slip_status: slipStatus, payment_method: payMethod, bank: data.bank || null,
        placement: null, wins_3match: null, tokens_earned: null, promo_packs: null, rewards_given: null, note: null,
      };
      var regRes = pushToSupabase_("wakagym_registrations", newWakagymObj);
      if (!regRes.ok) throw new Error("Supabase wakagym_registrations write failed: " + regRes.text);
      pendingMirrors.push({ table: "wakagym_registrations", header: SUPABASE_WAKAGYM_REG_HEADER, keyCol: "reg_id", obj: newWakagymObj });

      var statsRow = findStatsRow_(pName);
      var totalTokens = 0;
      if (statsRow) {
        totalTokens = Number(statsRow.total_tokens) || 0;
        statsRow.real_name = rName;
        statsRow.line_user_id = data.lineUserId || "";
        statsRow.total_plays = (Number(statsRow.total_plays) || 0) + 1;
        statsRow.last_play_date = today;
      } else {
        statsRow = {
          player_name: pName, display_name: data.displayName || "", real_name: rName,
          line_user_id: data.lineUserId || "", total_plays: 1, total_tokens: 0,
          boxes_earned: 0, boxes_given: 0, last_play_date: today,
        };
        statsRows.push(statsRow);
      }
      var statsRes = pushToSupabase_("player_stats", statsRow);
      if (!statsRes.ok) throw new Error("Supabase player_stats write failed: " + statsRes.text);
      pendingMirrors.push({ table: "player_stats", header: SUPABASE_PLAYER_STATS_HEADER, keyCol: "player_name", obj: statsRow });

      results.push({ regId: regId, playerName: pName, totalTokens: totalTokens });
    }

    lock.releaseLock();
    pendingMirrors.forEach(function(m) { mirrorToReportSheet_(m.table, m.header, m.keyCol, m.obj); });

    var cfgWs = ss.getSheetByName(TAB_CONFIG);
    var groupStaff = _getConfigValue(cfgWs, "group_staff");
    if (groupStaff) {
      var bankName = data.bank || "";
      var payText = payMethod === "cash" ? "💵 เงินสด" : "📱 " + (bankName || "โอนเงิน");
      var totalAmount = players.length * entryFee;
      var msg = "🏆 ลงทะเบียนแข่ง (" + players.length + " คน)\n" + payText + " " + totalAmount + "฿\n";
      for (var r = 0; r < results.length; r++) {
        msg += "\n" + (r + 1) + ". " + results[r].playerName + " (W:" + results[r].totalTokens + ")";
      }
      msg += "\n\nรหัส: #" + groupId;
      if (tier) msg += " | Tier " + tier;
      _linePush(groupStaff, msg);
    }

    if (payMethod !== "cash") {
      var finId = _getConfigValue(cfgWs, "finance_line_id");
      if (finId) {
        var finBankName = data.bank || "โอนเงิน";
        var finMsg = "🏆 แข่ง WAKA GYM\n📱 โอนเข้า " + finBankName + " " + totalAmount + "฿";
        for (var fi = 0; fi < results.length; fi++) {
          finMsg += "\n  - " + results[fi].playerName;
        }
        finMsg += "\nรหัส: #" + groupId;
        _linePush(finId, finMsg);
      }
    }

    if (data.lineUserId && data.lineUserId !== "dev_user") {
      var custTotalAmount = players.length * entryFee;
      var payLabel = payMethod === "cash" ? "💵 เงินสด" : "📱 โอนเงิน";
      var custMsg = "🏆 ลงทะเบียนแข่งสำเร็จ!"
        + "\nรหัส: #" + groupId
        + "\nจำนวน: " + players.length + " คน"
        + "\nยอดเงิน: " + custTotalAmount + " บาท (" + payLabel + ")\n";
      for (var c = 0; c < results.length; c++) {
        var cr = results[c];
        custMsg += "\n🎮 " + cr.playerName + " (Token สะสม: " + cr.totalTokens + "/" + TOKEN_BOX_THRESHOLD + ")";
      }
      if (payMethod === "transfer") custMsg += "\n\n📋 สถานะสลิป: รอตรวจ";
      _linePush(data.lineUserId, custMsg);
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({
      success: true, groupId: groupId, entryFee: entryFee, tier: tier, results: results
    })));
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── Tournament Registration ─────────────────────────────────────────────────
function handleTournamentRegister(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");

    var eventId = String(data.eventId || "").trim();
    var eventRow = getSupabaseRow_("tournament_events", "event_id", eventId);
    if (!eventRow) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "event not found" }))); }
    if (String(eventRow.status) !== "open") { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "registration closed" }))); }

    var eventName = String(eventRow.name || "");
    var eventDate = String(eventRow.date || "");
    var entryFee = Number(eventRow.entry_fee) || 0;
    var maxPlayers = Number(eventRow.max_players) || 0;

    var regsForEvent = supabaseSelect_("tournament_registrations", "select=reg_id,line_user_id,status&event_id=eq." + encodeURIComponent(eventId));
    var currentCount = 0;
    for (var ri = 0; ri < regsForEvent.length; ri++) {
      if (String(regsForEvent[ri].status) === "cancelled") continue;
      currentCount++;
      if (data.lineUserId && String(regsForEvent[ri].line_user_id) === data.lineUserId) {
        var existId = String(regsForEvent[ri].reg_id || "");
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: "already_registered", reg_id: existId })));
      }
    }
    if (maxPlayers > 0 && currentCount >= maxPlayers) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "event_full" })));
    }

    var dateStr = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd");
    var todayPrefix = "TR-" + dateStr + "-";
    var todayRegs = supabaseSelect_("tournament_registrations", "select=reg_id&reg_id=like." + todayPrefix + "*");
    var todayCount = todayRegs.length;
    var seqNo = currentCount + 1;
    var regId = todayPrefix + (todayCount + 1 < 10 ? "00" : todayCount + 1 < 100 ? "0" : "") + (todayCount + 1);

    var payMethod = data.paymentMethod || "transfer";
    var slipUrl = "";
    if (data.slipBase64) { slipUrl = saveSlipToDrive(data.slipBase64, regId); }
    var slipStatus = payMethod === "cash" ? "cash" : "pending";

    // คำนวณยอดจาก selected_categories ถ้ามี ไม่งั้นใช้ entry_fee ของ event
    var selectedCats = Array.isArray(data.selectedCategories) ? data.selectedCategories : [];
    var amountPaid = entryFee;
    if (selectedCats.length > 0) {
      amountPaid = 0;
      for (var sci = 0; sci < selectedCats.length; sci++) {
        amountPaid += Number(selectedCats[sci].fee) || 0;
      }
    }
    var newRegObj = {
      reg_id: regId, timestamp: now, event_id: eventId, sequence_no: seqNo,
      line_user_id: data.lineUserId || null, display_name: data.displayName || null,
      real_name: String(data.realName || "").trim() || null, player_name: String(data.playerName || "").trim() || null,
      phone: String(data.phone || "").trim() || null, facebook: String(data.facebook || "").trim() || null,
      slip_url: slipUrl || null, slip_status: slipStatus, payment_method: payMethod,
      bank: String(data.bank || "").trim() || null, amount_paid: amountPaid, status: "active",
      checked_in_at: null, note: null,
      selected_categories: selectedCats.length > 0 ? selectedCats : null,
    };
    writeSupabaseRow_("tournament_registrations", newRegObj, SUPABASE_TOURNAMENT_REG_HEADER, "reg_id", lock);

    var statusUrl = "https://waka-liff.vercel.app/treg_status.html?id=" + encodeURIComponent(regId);
    var cfgWs = ss.getSheetByName(TAB_CONFIG);

    if (data.lineUserId && data.lineUserId !== "dev_user") {
      var custMsg = "🏆 ลงทะเบียนสำเร็จ!\n"
        + "ทัวร์นาเมนต์: " + eventName + "\n"
        + "ลำดับที่: " + seqNo + "\n"
        + "ชื่อแข่ง: " + String(data.playerName || "");
      if (payMethod !== "cash") custMsg += "\n📋 สถานะสลิป: รอตรวจ";
      custMsg += "\n\n🔗 ดูสถานะ + QR:\n" + statusUrl;
      _linePush(data.lineUserId, custMsg);
    }

    var groupStaff = _getConfigValue(cfgWs, "group_staff");
    if (groupStaff) {
      var payText = payMethod === "cash" ? "💵 เงินสด" : "📱 " + (data.bank || "โอนเงิน");
      var staffMsg = "🏆 สมัครแข่ง #" + seqNo + " — " + eventName + "\n"
        + "ชื่อแข่ง: " + String(data.playerName || "") + " | จริง: " + String(data.realName || "") + "\n"
        + "โทร: " + String(data.phone || "");
      if (data.facebook) staffMsg += " | FB: " + data.facebook;
      staffMsg += "\n" + payText + "\nรหัส: " + regId;
      _linePush(groupStaff, staffMsg);
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({
      success: true, reg_id: regId, sequence_no: seqNo,
      event_name: eventName, event_date: eventDate,
      player_name: String(data.playerName || ""), status_url: statusUrl,
    })));
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function handleStaffPage(orderId, action) {
  if (!orderId) return HtmlService.createHtmlOutput("<h2>ไม่พบออเดอร์</h2>");
  var order = getSupabaseOrder_(orderId);
  if (!order) return HtmlService.createHtmlOutput("<h2>ไม่พบออเดอร์ #" + orderId + "</h2>");

  var gasUrl = ScriptApp.getService().getUrl();
  var ff = order.fulfillment || "รอเตรียม";
  var branch = order.branch || "";
  var isDelivery = branch === "จัดส่ง";
  var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");

  if (action === "shipping") {
    order.fulfillment = "กำลังจัดส่งไปสาขา";
    order.fulfilled_at = now;
    ff = order.fulfillment;
    writeSupabaseOrder_(order);
    _clearDashCache();
  } else if (action === "ready") {
    order.fulfillment = "พร้อมรับ";
    order.fulfilled_at = now;
    ff = order.fulfillment;
    writeSupabaseOrder_(order);
    _clearDashCache();
    if (order.line_user_id) {
      var trackUrl2 = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;
      _linePush(order.line_user_id, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + orderId + "\n\nดูสถานะ:\n" + trackUrl2);
    }
  } else if (action === "handover") {
    var ffValue = isDelivery ? "จัดส่งแล้ว" : "สาขายืนยัน";
    order.fulfillment = ffValue;
    order.staff_confirmed_at = now;
    ff = ffValue;
    writeSupabaseOrder_(order);
    _clearDashCache();
    if (order.line_user_id) {
      var trackUrl3 = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;
      _linePush(order.line_user_id, "สาขาส่งมอบสินค้าแล้ว กรุณากดยืนยันรับของ\n\nออเดอร์: #" + orderId + "\n\nกดยืนยัน:\n" + trackUrl3);
    }
  }

  var items = Array.isArray(order.items_json) ? order.items_json : [];
  var itemsHtml = "";
  for (var idx = 0; idx < items.length; idx++) {
    var it = items[idx];
    var unit = it.type === "box" ? "กล่อง" : "ซอง";
    var badge = "";
    if (it.cancelled_at) badge = ' <span style="color:#d64545;font-size:11px">[ยกเลิก]</span>';
    else if (it.handed_at) badge = ' <span style="color:#2d8f4e;font-size:11px">✅ ส่งมอบแล้ว</span>';
    else if (it.ready_at) badge = ' <span style="color:#d97706;font-size:11px">⏳ พร้อมรับ</span>';
    itemsHtml += "<div style='margin:4px 0'>" + it.name + " (" + unit + ") x" + it.qty + badge + "</div>";
  }

  var baseUrl = gasUrl + "?action=staff&order=" + orderId + "&do=";
  var btnStyle = "display:block;width:100%;padding:14px;border:none;border-radius:10px;font-size:16px;font-weight:bold;color:#fff;cursor:pointer;margin:8px 0;text-decoration:none;text-align:center";

  var buttonsHtml = "";
  if (ff === "รอเตรียม" && !isDelivery) {
    buttonsHtml = '<a href="' + baseUrl + 'shipping" style="' + btnStyle + ';background:#2196F3">📤 จัดส่งไปสาขาแล้ว</a>';
  } else if (ff === "กำลังจัดส่งไปสาขา") {
    buttonsHtml = '<a href="' + baseUrl + 'ready" style="' + btnStyle + ';background:#FF9800">📍 ถึงสาขาแล้ว / พร้อมรับ</a>';
  } else if (ff === "พร้อมรับ" || ff === "บางส่วน") {
    buttonsHtml = '<a href="' + baseUrl + 'handover" style="' + btnStyle + ';background:#06c755">🤝 ส่งมอบสินค้าแล้ว</a>';
  } else if (ff === "รับบางส่วนแล้ว") {
    buttonsHtml = '<div style="text-align:center;padding:12px;background:#fff8e1;border-radius:10px;color:#d97706;font-weight:bold;margin-bottom:8px">📦 ส่งมอบบางส่วนแล้ว รอสินค้าที่เหลือ</div>';
  } else if (ff === "รอเตรียม" && isDelivery) {
    buttonsHtml = '<a href="' + baseUrl + 'handover" style="' + btnStyle + ';background:#06c755">🚚 จัดส่งพัสดุแล้ว</a>';
  } else if (ff === "สาขายืนยัน" || ff === "รับแล้ว") {
    buttonsHtml = '<div style="text-align:center;padding:16px;background:#f0fbf4;border-radius:10px;color:#06c755;font-weight:bold">✅ ดำเนินการแล้ว</div>';
  }

  if (action) {
    buttonsHtml = '<div style="text-align:center;padding:16px;background:#f0fbf4;border-radius:10px;margin-bottom:12px"><b style="color:#06c755">✅ อัปเดตแล้ว!</b><br><span style="color:#888">' + now + '</span></div>' + buttonsHtml;
  }

  var html = '<div style="max-width:420px;margin:0 auto;padding:20px;font-family:sans-serif">'
    + '<h2 style="text-align:center;color:#333">📋 ออเดอร์ #' + orderId + '</h2>'
    + '<div style="background:#f9f9f9;border-radius:10px;padding:14px;margin:12px 0">'
    + '<div><b>ลูกค้า:</b> ' + (order.display_name || "") + ' (' + (order.real_name || "") + ')</div>'
    + '<div><b>โทร:</b> ' + (order.phone || "") + '</div>'
    + '<div><b>' + (isDelivery ? '🚚 จัดส่งพัสดุ' : '📦 รับที่สาขา: ' + branch) + '</b></div>'
    + (isDelivery && order.address ? '<div><b>ที่อยู่:</b> ' + order.address + '</div>' : '')
    + '</div>'
    + '<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:14px;margin:12px 0">'
    + '<div style="font-weight:bold;margin-bottom:8px">🎴 รายการ</div>' + itemsHtml
    + '<div style="margin-top:8px;font-weight:bold;color:#06c755">ยอดรวม: ' + order.total + ' บาท</div>'
    + '</div>'
    + '<div style="text-align:center;margin:12px 0;color:#888">สถานะ: <b>' + ff + '</b></div>'
    + buttonsHtml
    + '</div>';

  return HtmlService.createHtmlOutput(html);
}

function handleApi(params) {
  var action = params.do || "";
  var ss = SpreadsheetApp.openById(SHEET_ID);

  if (action === "search") {
    var q = String(params.q || "").toLowerCase().trim();
    if (!q) return _cors(ContentService.createTextOutput(JSON.stringify({ orders: [] })));
    // Deliberately NOT translating this into a PostgREST or=(...ilike...)
    // filter — with arbitrary staff-typed input that risks corrupting the
    // filter's own comma/paren/wildcard syntax, and Thai ilike collation
    // behavior is unverified against .indexOf(). Order volume here is
    // small (~100s), so fetch once and reuse the exact existing JS match
    // logic instead — same semantics as the old Sheet version.
    var seSb = supabaseSelect_("orders", "select=*&order=timestamp.desc");
    var seResults = [];
    for (var si = 0; si < seSb.length; si++) {
      var sr = seSb[si];
      var srow = {};
      SUPABASE_ORDERS_HEADER.forEach(function(h) {
        var v = sr[h];
        if (v === null || v === undefined) { srow[h] = ""; return; }
        srow[h] = (h === "items_json") ? JSON.stringify(v) : String(v);
      });
      var seMatch = srow.order_id.toLowerCase().indexOf(q) >= 0
        || srow.real_name.toLowerCase().indexOf(q) >= 0
        || srow.display_name.toLowerCase().indexOf(q) >= 0
        || srow.phone.indexOf(q) >= 0;
      if (seMatch) seResults.push(srow);
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ orders: seResults.slice(0, 20) })));
  }

  if (action === "update") {
    var orderId = params.order || "";
    var newStatus = params.status || "";
    if (!orderId || !newStatus) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing params" })));

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var order = getSupabaseOrder_(orderId);
    if (!order) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));

    var branch = order.branch || "";
    var isDelivery = branch === "จัดส่ง";
    var uid = order.line_user_id || "";
    var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;

    if (newStatus === "shipping") {
      order.fulfillment = "กำลังจัดส่งไปสาขา";
      order.fulfilled_at = now;
    } else if (newStatus === "ready") {
      order.fulfillment = "พร้อมรับ";
      order.fulfilled_at = now;
      if (uid) _linePush(uid, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + orderId + "\n\nดูสถานะ:\n" + trackUrl);
    } else if (newStatus === "handover") {
      order.fulfillment = isDelivery ? "จัดส่งแล้ว" : "สาขายืนยัน";
      order.staff_confirmed_at = now;
      if (uid) _linePush(uid, "สาขาส่งมอบสินค้าแล้ว กรุณากดยืนยันรับของ\n\nออเดอร์: #" + orderId + "\n\nกดยืนยัน:\n" + trackUrl);
    }
    _clearDashCache();
    writeSupabaseOrder_(order);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, status: newStatus, time: now })));
  }

  if (action === "order_status") {
    var orderId = params.order || "";
    if (!orderId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing order" })));
    var osSb = supabaseSelect_("orders", "select=order_id,branch,slip_status,fulfillment,staff_confirmed_at,customer_confirmed_at,timestamp,total&order_id=eq." + encodeURIComponent(orderId) + "&limit=1");
    if (!osSb.length) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
    var sr = osSb[0];
    return _cors(ContentService.createTextOutput(JSON.stringify({
      order_id: orderId,
      branch: sr.branch || "",
      slip_status: sr.slip_status || "",
      fulfillment: sr.fulfillment || "",
      staff_confirmed_at: sr.staff_confirmed_at || "",
      customer_confirmed_at: sr.customer_confirmed_at || "",
      timestamp: sr.timestamp || "",
      total: sr.total || 0,
    })));
  }

  if (action === "customer_confirm") {
    var orderId = params.order || "";
    if (!orderId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing order" })));
    var order = getSupabaseOrder_(orderId);
    if (!order) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));

    var staffAt = order.staff_confirmed_at || "";
    var custAt = order.customer_confirmed_at || "";
    var ff = String(order.fulfillment || "");
    if (custAt && ff === "รับแล้ว") return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
    if (!staffAt) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "staff ยังไม่ส่งมอบ" })));
    // ถ้าออเดอร์ยังมีสินค้าค้างอยู่ → บอกลูกค้าแต่ไม่ปิด order
    if (ff === "รับบางส่วนแล้ว") {
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, partial: true, msg: "รับของบางส่วนเรียบร้อยแล้ว สินค้าที่เหลือจะแจ้งให้ทราบเมื่อพร้อม" })));
    }
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    order.customer_confirmed_at = now;
    order.fulfillment = "รับแล้ว";
    writeSupabaseOrder_(order);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now })));
  }

  // ── ออเดอร์ของสาขา ──
  if (action === "branch_orders") {
    var branchFilter = params.branch || "";
    if (!branchFilter) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing branch" })));
    if (!_branchAuthorized(params.code, branchFilter)) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    var boSb = supabaseSelect_("orders", "select=order_id,real_name,display_name,phone,items_json,total,fulfillment,staff_confirmed_at,customer_confirmed_at,timestamp,notified_at&branch=eq." + encodeURIComponent(branchFilter) + "&slip_status=eq.ยืนยัน&order=timestamp.desc");
    var boOrders = boSb.map(function(r) {
      return {
        order_id: String(r.order_id || ""),
        real_name: String(r.real_name || ""),
        display_name: String(r.display_name || ""),
        phone: String(r.phone || ""),
        items_json: JSON.stringify(r.items_json || []),
        total: String(r.total || "0"),
        fulfillment: String(r.fulfillment || ""),
        staff_confirmed_at: String(r.staff_confirmed_at || ""),
        customer_confirmed_at: String(r.customer_confirmed_at || ""),
        timestamp: String(r.timestamp || ""),
        notified_at: String(r.notified_at || ""),
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ orders: boOrders })));
  }

  // ── สรุปออเดอร์แต่ละสาขา (รวมเป็นรายสินค้า) ──
  if (action === "branch_summary") {
    // Filter fulfillment in JS, not via a SQL not.in — a NULL fulfillment
    // (brand-new, unprocessed order) must still be INCLUDED here, and SQL's
    // "NOT IN" treats NULL as unknown/excluded, which would silently drop
    // exactly the orders this summary most needs to show.
    var bsSb = supabaseSelect_("orders", "select=branch,items_json,fulfillment&slip_status=eq.ยืนยัน");
    var bsExcluded = ["กำลังจัดส่งไปสาขา", "พร้อมรับ", "สาขายืนยัน", "รับแล้ว", "จัดส่งแล้ว"];
    var bsSummary = {};
    bsSb.forEach(function(r) {
      if (bsExcluded.indexOf(r.fulfillment || "") >= 0) return;
      var branch = r.branch || "";
      var items = r.items_json || [];
      if (!bsSummary[branch]) bsSummary[branch] = {};
      for (var x = 0; x < items.length; x++) {
        var key = items[x].name;
        if (!bsSummary[branch][key]) bsSummary[branch][key] = { name: key, qty_box: 0, qty_pack: 0, order_count: 0 };
        if (items[x].type === "box") bsSummary[branch][key].qty_box += (items[x].qty || 1);
        else bsSummary[branch][key].qty_pack += (items[x].qty || 1);
        bsSummary[branch][key].order_count++;
      }
    });
    var bsResult = {};
    for (var bb in bsSummary) {
      bsResult[bb] = [];
      for (var kk in bsSummary[bb]) bsResult[bb].push(bsSummary[bb][kk]);
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ branches: bsResult })));
  }

  // ── สต็อกกลาง ──
  if (action === "central_stock") {
    var csRows = supabaseSelect_("catalog", "select=name,category,qty_box,qty_pack");
    var stock = csRows.filter(function(r) { return r.name; }).map(function(r) {
      return { name: String(r.name), category: String(r.category || ""), qty_box: Number(r.qty_box) || 0, qty_pack: Number(r.qty_pack) || 0 };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ stock: stock })));
  }

  // ── สต็อกสาขา ──
  if (action === "branch_stock") {
    var branchFilter = params.branch || "";
    if (!_branchAuthorized(params.code, branchFilter)) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    var bsQuery = "select=name,category,branch,qty_box,qty_pack" + (branchFilter ? "&branch=eq." + encodeURIComponent(branchFilter) : "");
    var bsRows = supabaseSelect_("stock_branch", bsQuery);
    var bStock = bsRows.filter(function(r) { return r.name; }).map(function(r) {
      return { name: String(r.name), category: String(r.category || ""), branch: String(r.branch || ""), qty_box: Number(r.qty_box) || 0, qty_pack: Number(r.qty_pack) || 0 };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ stock: bStock })));
  }

  // ── รายการ shipments ──
  if (action === "shipments") {
    var shSb = supabaseSelect_("shipments", "select=shipment_id,timestamp,to_branch,status,items_json,received_at&order=timestamp.desc");
    var shList = shSb.map(function(r) {
      return {
        shipment_id: String(r.shipment_id || ""),
        timestamp: String(r.timestamp || ""),
        to_branch: String(r.to_branch || ""),
        status: String(r.status || ""),
        items_json: JSON.stringify(r.items_json || []),
        received_at: String(r.received_at || ""),
        notes: "", // notes was always written empty and isn't a column in Supabase's shipments table
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ shipments: shList })));
  }

  // ── รายงานยอดขาย ──
  if (action === "report") {
    // อ่าน cost จาก catalog
    var costCatRows = supabaseSelect_("catalog", "select=name,cost_box,cost_p,price_box,price_pack");
    var costMap = {};
    costCatRows.forEach(function(r) {
      if (!r.name) return;
      costMap[String(r.name)] = {
        cost_box: Number(r.cost_box) || 0,
        cost_pack: Number(r.cost_p) || 0,
        price_box: Number(r.price_box) || 0,
        price_pack: Number(r.price_pack) || 0,
      };
    });

    var byBranch = {};
    var byProduct = {};
    var byDate = {};
    var totalRevenue = 0, totalCost = 0;

    var repSb = supabaseSelect_("orders", "select=branch,timestamp,items_json&slip_status=eq.ยืนยัน");
    var reportRows = repSb.map(function(r) {
      // Supabase's timestamp is UTC — convert to Bangkok-local before using
      // as the by-date grouping key, same reasoning as the dashboard fix.
      var localDate = Utilities.formatDate(new Date(r.timestamp), "Asia/Bangkok", "yyyy-MM-dd");
      return { branch: r.branch || "ไม่ระบุ", dateKey: localDate, items: r.items_json || [] };
    });

    reportRows.forEach(function(rr) {
      var branch = rr.branch, dateKey = rr.dateKey, items = rr.items;
      var orderRev = 0, orderCost = 0;
      for (var x = 0; x < items.length; x++) {
        var it = items[x];
        var qty = it.qty || 1;
        var c = costMap[it.name] || {};
        var rev = (it.price || 0) * qty;
        var cost = (it.type === "box" ? (c.cost_box || 0) : (c.cost_pack || 0)) * qty;
        orderRev += rev;
        orderCost += cost;

        var pKey = it.name + "|" + it.type;
        if (!byProduct[pKey]) byProduct[pKey] = { name: it.name, type: it.type, qty: 0, revenue: 0, cost: 0 };
        byProduct[pKey].qty += qty;
        byProduct[pKey].revenue += rev;
        byProduct[pKey].cost += cost;
      }

      if (!byBranch[branch]) byBranch[branch] = { revenue: 0, cost: 0, orders: 0 };
      byBranch[branch].revenue += orderRev;
      byBranch[branch].cost += orderCost;
      byBranch[branch].orders++;

      if (dateKey) {
        if (!byDate[dateKey]) byDate[dateKey] = { revenue: 0, cost: 0, orders: 0 };
        byDate[dateKey].revenue += orderRev;
        byDate[dateKey].cost += orderCost;
        byDate[dateKey].orders++;
      }

      totalRevenue += orderRev;
      totalCost += orderCost;
    });

    return _cors(ContentService.createTextOutput(JSON.stringify({
      total: { revenue: totalRevenue, cost: totalCost, profit: totalRevenue - totalCost },
      by_branch: byBranch,
      by_product: Object.values(byProduct),
      by_date: byDate,
    })));
  }

  // ── ค้นหาสินค้าจาก barcode ──
  if (action === "lookup_barcode") {
    var barcode = String(params.barcode || "").trim();
    if (!barcode) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing barcode" })));
    var lbRows = supabaseSelect_("catalog", "select=*&barcode=eq." + encodeURIComponent(barcode) + "&limit=1");
    if (lbRows.length) {
      var lr = lbRows[0];
      return _cors(ContentService.createTextOutput(JSON.stringify({
        found: true,
        product: {
          name: String(lr.name), category: String(lr.category || ""),
          price_box: Number(lr.price_box) || 0, price_pack: Number(lr.price_pack) || 0,
          cost_box: Number(lr.cost_box) || 0, cost_pack: Number(lr.cost_p) || 0,
          barcode: barcode, stock_box: Number(lr.qty_box) || 0, stock_pack: Number(lr.qty_pack) || 0,
        }
      })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ found: false })));
  }

  // ── รายการสินค้าทั้งหมด (สำหรับหน้ารับสต็อก) ──
  if (action === "product_list") {
    var plRows = supabaseSelect_("catalog", "select=*");
    var products = plRows.filter(function(r) { return r.name; }).map(function(r) {
      return {
        name: String(r.name).trim(), category: String(r.category || ""),
        price_box: Number(r.price_box) || 0, price_pack: Number(r.price_pack) || 0,
        cost_box: Number(r.cost_box) || 0, cost_pack: Number(r.cost_p) || 0,
        barcode: String(r.barcode || ""),
        limit_box: (r.limit_box === "" || r.limit_box === undefined || r.limit_box === null) ? -1 : Number(r.limit_box),
        limit_pack: (r.limit_pack === "" || r.limit_pack === undefined || r.limit_pack === null) ? -1 : Number(r.limit_pack),
        stock_box: Number(r.qty_box) || 0, stock_pack: Number(r.qty_pack) || 0,
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ products: products })));
  }

  // ── Admin Catalog (ทุกสินค้า รวม inactive) ──
  if (action === "catalog_admin") {
    var caRows = supabaseSelect_("catalog", "select=*");
    var products = caRows.filter(function(r) { return r.name; }).map(function(r) {
      var isActive = !(r.active === false || String(r.active).toUpperCase() === "FALSE" || r.active === 0);
      return {
        name: String(r.name || "").trim(),
        category: String(r.category || ""),
        cost_box: Number(r.cost_box) || 0, cost_pack: Number(r.cost_p) || 0,
        price_box: Number(r.price_box) || 0, price_pack: Number(r.price_pack) || 0,
        qty_box: Number(r.qty_box) || 0, qty_pack: Number(r.qty_pack) || 0,
        limit_box: (r.limit_box === "" || r.limit_box === undefined || r.limit_box === null) ? -1 : Number(r.limit_box),
        limit_pack: (r.limit_pack === "" || r.limit_pack === undefined || r.limit_pack === null) ? -1 : Number(r.limit_pack),
        active: isActive,
        notice: String(r.notice || "")
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ products: products })));
  }

  // ── Dashboard KPI ──
  if (action === "dashboard") {
    var dashCache = CacheService.getScriptCache();
    var cached = dashCache.get("dashboard_v1");
    if (cached) return _cors(ContentService.createTextOutput(cached));

    var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");

    var dashSb = supabaseSelect_("orders", "select=order_id,real_name,display_name,phone,items_json,total,slip_status,fulfillment,branch,address,timestamp&order=timestamp.desc");
    var dOrdersToday = 0, dRevenueToday = 0, dPendingCount = 0;
    var dRecentOrders = [];
    var dPendingSlips = ["รอตรวจ", "รอตรวจเพิ่ม", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม"];
    dashSb.forEach(function(r) {
      var slip = String(r.slip_status || "");
      // Supabase's timestamp is UTC (e.g. "...+00:00"), unlike the Sheet's
      // already-Bangkok-local string — must convert before date-comparing,
      // a naive substring(0,10) here would be off by up to 7 hours.
      var localDate = Utilities.formatDate(new Date(r.timestamp), "Asia/Bangkok", "yyyy-MM-dd");
      if (localDate === today) {
        dOrdersToday++;
        if (slip === "ยืนยัน") dRevenueToday += Number(r.total) || 0;
      }
      if (dPendingSlips.indexOf(slip) >= 0) dPendingCount++;
      if (dRecentOrders.length < 200) {
        dRecentOrders.push({
          order_id: String(r.order_id || ""),
          real_name: String(r.real_name || ""),
          display_name: String(r.display_name || ""),
          phone: String(r.phone || ""),
          items_json: JSON.stringify(r.items_json || []),
          total: Number(r.total) || 0,
          slip_status: slip,
          fulfillment: String(r.fulfillment || ""),
          branch: String(r.branch || ""),
          address: String(r.address || ""),
          timestamp: String(r.timestamp || ""),
        });
      }
    });
    var dashJsonSb = JSON.stringify({
      orders_today: dOrdersToday, revenue_today: dRevenueToday,
      pending_count: dPendingCount, recent_orders: dRecentOrders,
    });
    dashCache.put("dashboard_v1", dashJsonSb, 30);
    return _cors(ContentService.createTextOutput(dashJsonSb));
  }

  // ── ยกเลิกออเดอร์ (admin) ──
  if (action === "cancel_order") {
    var orderId = params.order || "";
    if (!orderId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing order" })));
    var cancelReason = String(params.reason || "");
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var order = getSupabaseOrder_(orderId);
    if (!order) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));

    var ff = String(order.fulfillment || "");
    if (ff === "รับแล้ว" || ff === "ยกเลิก") {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่สามารถยกเลิกออเดอร์นี้ได้" })));
    }
    var items = Array.isArray(order.items_json) ? order.items_json : [];
    // คืนเฉพาะ item ที่ยังไม่ได้ส่งมอบลูกค้า (ป้องกัน double restore)
    var itemsToRestore = items.filter(function(it) { return !it.handed_at; });
    if (itemsToRestore.length > 0) {
      restoreStock(itemsToRestore);
      restoreCatalogLimits(itemsToRestore);
    }
    order.fulfillment = "ยกเลิก";
    var uid = String(order.line_user_id || "");
    if (uid) {
      var cancelMsg;
      if (cancelReason === "duplicate") {
        cancelMsg = "❌ ออเดอร์ #" + orderId + " ถูกยกเลิก\n\n" +
          "ทีมงาน WAKA ได้รับออเดอร์แรกของคุณเรียบร้อยแล้วค่ะ\n" +
          "ออเดอร์นี้จึงขอยกเลิกเพื่อให้สิทธิ์ลูกค้าท่านอื่น\n" +
          "(สินค้ามีจำกัด)\n\n" +
          "หากมีข้อสงสัยกรุณาติดต่อทีมงาน 🙏";
      } else {
        var reasonLine = cancelReason ? "\nเหตุผล: " + cancelReason + "\n" : "";
        cancelMsg = "❌ ออเดอร์ #" + orderId + " ถูกยกเลิก\n" + reasonLine + "\nหากมีข้อสงสัยหรือต้องการสั่งใหม่ กรุณาติดต่อทีมงาน 🙏";
      }
      _linePush(uid, cancelMsg);
    }
    _clearDashCache();
    writeSupabaseOrder_(order);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  }

  // ── รายการจัดส่งพัสดุ ──
  if (action === "delivery_orders") {
    var doSb = supabaseSelect_("orders", "select=order_id,real_name,display_name,phone,address,items_json,total,slip_status,fulfillment,timestamp&branch=eq.จัดส่ง&order=timestamp.desc");
    var doDeliveries = doSb
      .filter(function(r) { return r.fulfillment !== "จัดส่งแล้ว" && r.fulfillment !== "รับแล้ว"; })
      .map(function(r) {
        return {
          order_id:     String(r.order_id || ""),
          real_name:    String(r.real_name || ""),
          display_name: String(r.display_name || ""),
          phone:        String(r.phone || ""),
          address:      String(r.address || ""),
          items_json:   JSON.stringify(r.items_json || []),
          total:        Number(r.total) || 0,
          slip_status:  String(r.slip_status || ""),
          fulfillment:  String(r.fulfillment || ""),
          timestamp:    String(r.timestamp || ""),
        };
      });
    return _cors(ContentService.createTextOutput(JSON.stringify({ deliveries: doDeliveries })));
  }

  // ── รายการเบิกสินค้า ──
  if (action === "withdrawals") {
    var branchFilter = params.branch || "";
    if (!_branchAuthorized(params.code, branchFilter)) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    var wQuery = "select=timestamp,branch,name,type,qty,reason&order=timestamp.desc&limit=50";
    if (branchFilter) wQuery += "&branch=eq." + encodeURIComponent(branchFilter);
    var wSb = supabaseSelect_("withdrawals", wQuery);
    var wList = wSb.map(function(r) {
      return { timestamp: String(r.timestamp || ""), branch: String(r.branch || ""), name: String(r.name || ""), type: String(r.type || ""), qty: Number(r.qty) || 0, reason: String(r.reason || "") };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ withdrawals: wList })));
  }

  // ── ประวัติขายหน้าร้าน (walk-in, แยกจาก orders/รายงานออนไลน์) ──
  if (action === "walkin_sales_list") {
    var wsBranchFilter = params.branch || "";
    if (!_branchAuthorized(params.code, wsBranchFilter)) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    var wsQuery = "select=*&order=timestamp.desc&limit=50";
    if (wsBranchFilter) wsQuery += "&branch=eq." + encodeURIComponent(wsBranchFilter);
    var wsSb = supabaseSelect_("walkin_sales", wsQuery);
    var wsList = wsSb.map(function(r) {
      return {
        sale_id: String(r.sale_id || ""),
        timestamp: String(r.timestamp || ""),
        branch: String(r.branch || ""),
        items_json: JSON.stringify(r.items_json || []),
        total: Number(r.total) || 0,
        payment_method: String(r.payment_method || ""),
        bank: String(r.bank || ""),
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ sales: wsList })));
  }

  // ── WAKA GYM API ──
  if (action === "wakagym_status") {
    var uid = params.line_user_id || "";
    var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");

    var event = _getActiveEvent(ss, null);
    var eventInfo = event ? {
      event_id: event.event_id, tier: event.tier,
      entry_fee: event.entry_fee, branch: event.branch,
      token_table: TOKEN_TABLE[event.tier] || {},
    } : null;

    var todayRegs = [];
    if (uid) {
      var rRows = supabaseSelect_("wakagym_registrations", "select=reg_id,player_name,slip_status,event_date&line_user_id=eq." + encodeURIComponent(uid));
      rRows.forEach(function(r) {
        var evDate = String(r.event_date || "");
        if (evDate.length > 10) evDate = evDate.substring(0, 10);
        if (evDate === today) {
          todayRegs.push({
            reg_id: String(r.reg_id || ""),
            player_name: String(r.player_name || ""),
            slip_status: String(r.slip_status || ""),
          });
        }
      });
    }

    var linkedStats = [];
    if (uid) {
      var sRows2 = supabaseSelect_("player_stats", "select=player_name,total_plays,total_tokens,boxes_earned,boxes_given&line_user_id=eq." + encodeURIComponent(uid));
      sRows2.forEach(function(r) {
        linkedStats.push({
          player_name: String(r.player_name || ""),
          total_plays: Number(r.total_plays) || 0,
          total_tokens: Number(r.total_tokens) || 0,
          boxes_earned: Number(r.boxes_earned) || 0,
          boxes_given: Number(r.boxes_given) || 0,
        });
      });
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({
      event_date: today,
      event: eventInfo,
      already_registered: todayRegs.length > 0,
      today_regs: todayRegs,
      linked_stats: linkedStats,
      token_threshold: TOKEN_BOX_THRESHOLD,
    })));
  }

  if (action === "wakagym_players") {
    var date = params.date || Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var tRowsSb = supabaseSelect_("wakagym_registrations", "select=*&event_date=eq." + encodeURIComponent(date));
    var players = tRowsSb.map(function(r) {
      return {
        reg_id: String(r.reg_id || ""),
        group_id: String(r.group_id || ""),
        display_name: String(r.display_name || ""),
        real_name: String(r.real_name || ""),
        player_name: String(r.player_name || ""),
        slip_url: String(r.slip_url || ""),
        slip_status: String(r.slip_status || ""),
        payment_method: String(r.payment_method || ""),
        tokens_earned: String(r.tokens_earned || ""),
        promo_packs: String(r.promo_packs || ""),
        rewards_given: String(r.rewards_given || ""),
        phone: String(r.phone || ""),
        timestamp: String(r.timestamp || ""),
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ players: players })));
  }

  if (action === "wakagym_update_reg") {
    var regId = params.reg_id || "";
    var field = params.field || "";
    var value = params.value || "";
    if (!regId || !field) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing params" })));
    var allowed = ["slip_status", "rewards_given", "note"];
    if (allowed.indexOf(field) < 0) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "invalid field" })));
    var tuRow = getSupabaseRow_("wakagym_registrations", "reg_id", regId);
    if (!tuRow) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "reg not found" })));
    tuRow[field] = value;
    writeSupabaseRow_("wakagym_registrations", tuRow, SUPABASE_WAKAGYM_REG_HEADER, "reg_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  }

  if (action === "wakagym_give_box") {
    var boxPlayer = String(params.player_name || "").trim();
    if (!boxPlayer) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing player_name" })));
    var bRow = getSupabaseRow_("player_stats", "player_name", boxPlayer);
    if (!bRow) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "player not found" })));
    var given = (Number(bRow.boxes_given) || 0) + 1;
    bRow.boxes_given = given;
    var boxAt = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
    bRow.last_play_date = "box " + boxAt;
    writeSupabaseRow_("player_stats", bRow, SUPABASE_PLAYER_STATS_HEADER, "player_name");
    var boxUid = String(bRow.line_user_id || "");
    if (boxUid && boxUid !== "dev_user") {
      _linePush(boxUid, "🎁 รับ Box เรียบร้อย!\nชื่อแข่ง: " + boxPlayer + "\nBox ที่ได้: " + given);
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, boxes_given: given })));
  }

  if (action === "wakagym_summary") {
    var sumDate = params.date || Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var sumRowsSb = supabaseSelect_("wakagym_registrations", "select=*&event_date=eq." + encodeURIComponent(sumDate));

    var totalPlayers = 0, totalTokens = 0, totalPromo = 0, rewardsGiven = 0;
    var cashAmount = 0, transferAmount = 0;
    var bankBreakdown = {};

    sumRowsSb.forEach(function(r) {
      totalPlayers++;
      var pm = String(r.payment_method || "transfer");
      var bk = String(r.bank || "ไม่ระบุ");
      var entryFee = Number(r.note || 0) || 200;

      totalTokens += Number(r.tokens_earned || 0);
      totalPromo += Number(r.promo_packs || 0);
      if (String(r.rewards_given).toLowerCase() === "true") rewardsGiven++;

      if (pm === "cash") {
        cashAmount += entryFee;
      } else {
        transferAmount += entryFee;
        if (!bankBreakdown[bk]) bankBreakdown[bk] = 0;
        bankBreakdown[bk] += entryFee;
      }
    });

    return _cors(ContentService.createTextOutput(JSON.stringify({
      date: sumDate,
      total_players: totalPlayers,
      total_tokens: totalTokens,
      total_promo: totalPromo,
      rewards_given: rewardsGiven,
      cash_amount: cashAmount,
      transfer_amount: transferAmount,
      bank_breakdown: bankBreakdown,
      total_amount: cashAmount + transferAmount,
    })));
  }

  if (action === "wakagym_create_event") {
    var evBranch = params.branch || "";
    var evTier = params.tier || "L";
    if (!evBranch) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing branch" })));
    if (!TIER_CONFIG[evTier]) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "invalid tier" })));
    var evNow = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var evExisting = supabaseSelect_("wakagym_events", "select=event_id&date=eq." + evNow);
    var evId = "EV" + evNow.replace(/-/g, "") + "-" + (evExisting.length + 1);
    var evObj = {
      event_id: evId, date: evNow, branch: evBranch, tier: evTier,
      entry_fee: TIER_CONFIG[evTier].fee, status: "open", created_by: params.created_by || "staff",
    };
    writeSupabaseRow_("wakagym_events", evObj, SUPABASE_WAKAGYM_EVENTS_HEADER, "event_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({
      ok: true, event_id: evId, tier: evTier, entry_fee: TIER_CONFIG[evTier].fee,
      token_table: TOKEN_TABLE[evTier],
    })));
  }

  if (action === "wakagym_submit_results") {
    var srEventId = params.event_id || "";
    var srResults = [];
    try {
      srResults = Array.isArray(params.results) ? params.results : JSON.parse(params.results || "[]");
    } catch(_) {}
    if (srResults.length === 0) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no results" })));

    var srEvent = null;
    if (srEventId) {
      var evRow2 = getSupabaseRow_("wakagym_events", "event_id", srEventId);
      if (evRow2) srEvent = { tier: String(evRow2.tier || "L") };
    }
    var tier = srEvent ? srEvent.tier : "L";

    var stRows = supabaseSelect_("player_stats", "select=*");
    var findStatsRow2_ = function(name) {
      for (var i = 0; i < stRows.length; i++) {
        if (String(stRows[i].player_name || "").trim() === name) return stRows[i];
      }
      return null;
    };

    var processed = [];
    for (var ri = 0; ri < srResults.length; ri++) {
      var sr = srResults[ri];
      var regId = sr.reg_id || "";
      var placement = sr.placement || "";
      var wins = Math.min(Math.max(parseInt(sr.wins_3match) || 0, 0), 3);
      var tokens = (TOKEN_TABLE[tier] && TOKEN_TABLE[tier][placement]) || 0;
      var promos = PROMO_TABLE[wins] || 1;

      var srRegRow = getSupabaseRow_("wakagym_registrations", "reg_id", regId);
      if (!srRegRow) continue;
      srRegRow.placement = placement;
      srRegRow.wins_3match = wins;
      srRegRow.tokens_earned = tokens;
      srRegRow.promo_packs = promos;

      var pName = String(srRegRow.player_name || "").trim();
      var lineUid = String(srRegRow.line_user_id || "");
      var srStatsRow = findStatsRow2_(pName);
      if (srStatsRow) {
        var curTokens = (Number(srStatsRow.total_tokens) || 0) + tokens;
        var curBoxes = Number(srStatsRow.boxes_earned) || 0;
        while (curTokens >= TOKEN_BOX_THRESHOLD) {
          curTokens -= TOKEN_BOX_THRESHOLD;
          curBoxes++;
        }
        srStatsRow.total_tokens = curTokens;
        srStatsRow.boxes_earned = curBoxes;
        writeSupabaseRow_("player_stats", srStatsRow, SUPABASE_PLAYER_STATS_HEADER, "player_name");
      }

      processed.push({ reg_id: regId, player_name: pName, placement: placement, tokens: tokens, promo_packs: promos, line_user_id: lineUid });
      writeSupabaseRow_("wakagym_registrations", srRegRow, SUPABASE_WAKAGYM_REG_HEADER, "reg_id");
    }

    for (var pi = 0; pi < processed.length; pi++) {
      var pp = processed[pi];
      if (pp.line_user_id && pp.line_user_id !== "dev_user") {
        var pMsg = "🏆 ผลแข่งขัน!\n"
          + "ชื่อแข่ง: " + pp.player_name + "\n"
          + "อันดับ: " + pp.placement + "\n"
          + "🪙 Token +" + pp.tokens + "\n"
          + "📦 Promo Pack: " + pp.promo_packs + " ซอง";
        _linePush(pp.line_user_id, pMsg);
      }
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, processed: processed })));
  }

  if (action === "wakagym_give_rewards") {
    var grRegId = String(params.reg_id || "").trim();
    if (!grRegId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing reg_id" })));
    var grRow = getSupabaseRow_("wakagym_registrations", "reg_id", grRegId);
    if (!grRow) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
    if (String(grRow.rewards_given).toLowerCase() === "true") {
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
    }
    var givenAt = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
    grRow.rewards_given = "TRUE";
    grRow.note = "แจก " + givenAt;
    var grUid = String(grRow.line_user_id || "");
    var grName = String(grRow.player_name || "");
    var grTokens = Number(grRow.tokens_earned) || 0;
    var grPromos = Number(grRow.promo_packs) || 0;
    if (grUid && grUid !== "dev_user") {
      var grMsg = "✅ รับรางวัลแล้ว!\nชื่อแข่ง: " + grName;
      if (grTokens > 0) grMsg += "\n🪙 Token: " + grTokens;
      if (grPromos > 0) grMsg += "\n📦 Promo Pack: " + grPromos + " ซอง";
      _linePush(grUid, grMsg);
    }
    writeSupabaseRow_("wakagym_registrations", grRow, SUPABASE_WAKAGYM_REG_HEADER, "reg_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: false })));
  }

  if (action === "wakagym_lookup") {
    var lookupId = String(params.group_id || params.reg_id || "").trim();
    if (!lookupId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing id" })));
    var luSb = supabaseSelect_("wakagym_registrations", "select=*");
    var found = luSb
      .filter(function(r) { return String(r.group_id || "") === lookupId || String(r.reg_id || "") === lookupId; })
      .map(function(r) {
        return {
          reg_id: String(r.reg_id || ""),
          group_id: String(r.group_id || ""),
          player_name: String(r.player_name || ""),
          real_name: String(r.real_name || ""),
          placement: String(r.placement || ""),
          wins_3match: String(r.wins_3match || ""),
          tokens_earned: Number(r.tokens_earned) || 0,
          promo_packs: Number(r.promo_packs) || 0,
          rewards_given: String(r.rewards_given || ""),
          slip_status: String(r.slip_status || ""),
          slip_url: String(r.slip_url || ""),
          payment_method: String(r.payment_method || ""),
          bank: String(r.bank || ""),
          note: String(r.note || ""),
          event_date: String(r.event_date || ""),
        };
      });
    if (found.length === 0) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));

    var statsMap = {};
    supabaseSelect_("player_stats", "select=player_name,total_tokens,boxes_earned,boxes_given").forEach(function(r) {
      statsMap[String(r.player_name || "").trim()] = {
        total_tokens: Number(r.total_tokens) || 0,
        boxes_earned: Number(r.boxes_earned) || 0,
        boxes_given: Number(r.boxes_given) || 0,
      };
    });
    for (var fi = 0; fi < found.length; fi++) {
      var pStat = statsMap[found[fi].player_name] || {};
      found[fi].total_tokens = pStat.total_tokens || 0;
      found[fi].boxes_earned = pStat.boxes_earned || 0;
      found[fi].boxes_given_count = pStat.boxes_given || 0;
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ players: found })));
  }

  // ── TOURNAMENT API ─────────────────────────────────────────────────────────

  if (action === "tournament_status") {
    var tsId = String(params.event || "").trim();
    if (!tsId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing event" })));
    var tsEvent = getSupabaseRow_("tournament_events", "event_id", tsId);
    if (!tsEvent) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "event not found" })));

    var tsRegsSb = supabaseSelect_("tournament_registrations", "select=reg_id,line_user_id,status&event_id=eq." + encodeURIComponent(tsId));
    var tsCount = 0; var tsUserReg = null; var tsUid = params.line_user_id || "";
    tsRegsSb.forEach(function(r) {
      if (String(r.status) === "cancelled") return;
      tsCount++;
      if (tsUid && String(r.line_user_id) === tsUid) tsUserReg = String(r.reg_id || "");
    });

    var tsCatsSb = supabaseSelect_("tournament_categories", "select=*&event_id=eq." + encodeURIComponent(tsId) + "&order=sort_order.asc");
    var tsCats = tsCatsSb
      .filter(function(c) { return String(c.status || "") !== "deleted"; })
      .map(function(c) {
        return {
          category_id: String(c.category_id || ""),
          name: String(c.name || ""),
          entry_fee: Number(c.entry_fee) || 0,
          max_players: Number(c.max_players) || 0,
          sort_order: Number(c.sort_order) || 0,
          status: String(c.status || "open"),
        };
      });

    return _cors(ContentService.createTextOutput(JSON.stringify({
      event_id: tsId, name: String(tsEvent.name || ""),
      date: String(tsEvent.date || ""),
      entry_fee: Number(tsEvent.entry_fee) || 0,
      max_players: Number(tsEvent.max_players) || 0,
      rules_text: String(tsEvent.rules_text || ""),
      registration_close: String(tsEvent.registration_close || ""),
      status: String(tsEvent.status || ""),
      current_count: tsCount, already_registered: !!tsUserReg, existing_reg_id: tsUserReg || null,
      categories: tsCats,
    })));
  }

  if (action === "tournament_reg_status") {
    var trsId = String(params.id || "").trim();
    if (!trsId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing id" })));
    var trsReg = getSupabaseRow_("tournament_registrations", "reg_id", trsId);
    if (!trsReg) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
    var trsEvId = String(trsReg.event_id || "");
    var trsEvName = "", trsEvDate = "";
    var trsEvRow = getSupabaseRow_("tournament_events", "event_id", trsEvId);
    if (trsEvRow) {
      trsEvName = String(trsEvRow.name || "");
      trsEvDate = String(trsEvRow.date || "");
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({
      reg_id: trsId, event_id: trsEvId, event_name: trsEvName, event_date: trsEvDate,
      sequence_no: Number(trsReg.sequence_no) || 0,
      player_name: String(trsReg.player_name || ""),
      real_name: String(trsReg.real_name || ""),
      display_name: String(trsReg.display_name || ""),
      phone: String(trsReg.phone || ""),
      facebook: String(trsReg.facebook || ""),
      slip_status: String(trsReg.slip_status || ""),
      slip_url: String(trsReg.slip_url || ""),
      payment_method: String(trsReg.payment_method || ""),
      status: String(trsReg.status || ""),
      checked_in_at: String(trsReg.checked_in_at || ""),
      timestamp: String(trsReg.timestamp || ""),
    })));
  }

  if (action === "tournament_events") {
    var tevSb = supabaseSelect_("tournament_events", "select=*&order=created_at.desc");
    var tevList = tevSb.map(function(r) {
      return {
        event_id: String(r.event_id || ""),
        name: String(r.name || ""),
        date: String(r.date || ""),
        entry_fee: Number(r.entry_fee) || 0,
        max_players: Number(r.max_players) || 0,
        registration_close: String(r.registration_close || ""),
        status: String(r.status || ""),
        created_at: String(r.created_at || ""),
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ events: tevList })));
  }

  if (action === "tournament_list") {
    var tlEvId = String(params.event || "").trim();
    var tlQuery = "select=*&order=sequence_no.asc";
    if (tlEvId) tlQuery += "&event_id=eq." + encodeURIComponent(tlEvId);
    var tlSb = supabaseSelect_("tournament_registrations", tlQuery);
    var tlList = tlSb.map(function(r) {
      return {
        reg_id: String(r.reg_id || ""),
        event_id: String(r.event_id || ""),
        sequence_no: Number(r.sequence_no) || 0,
        display_name: String(r.display_name || ""),
        real_name: String(r.real_name || ""),
        player_name: String(r.player_name || ""),
        phone: String(r.phone || ""),
        facebook: String(r.facebook || ""),
        slip_status: String(r.slip_status || ""),
        slip_url: String(r.slip_url || ""),
        payment_method: String(r.payment_method || ""),
        bank: String(r.bank || ""),
        status: String(r.status || ""),
        checked_in_at: String(r.checked_in_at || ""),
        timestamp: String(r.timestamp || ""),
        note: String(r.note || ""),
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ players: tlList })));
  }

  if (action === "tournament_create_event") {
    var tceName = String(params.name || "").trim();
    var tceDate = String(params.date || "").trim();
    if (!tceName || !tceDate) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing name or date" })));
    var tceDateStr = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMdd");
    var tceExisting = supabaseSelect_("tournament_events", "select=event_id&event_id=like.EVT" + tceDateStr + "*");
    var tceId = "EVT" + tceDateStr + "-" + (tceExisting.length + 1);
    var tceNow = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var tceObj = {
      event_id: tceId, name: tceName, date: tceDate, entry_fee: Number(params.entry_fee) || 0,
      max_players: Number(params.max_players) || 0, rules_text: String(params.rules_text || "").trim(),
      registration_close: String(params.registration_close || "").trim(), status: "open", created_at: tceNow,
    };
    writeSupabaseRow_("tournament_events", tceObj, SUPABASE_TOURNAMENT_EVENTS_HEADER, "event_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({
      ok: true, event_id: tceId,
      reg_link: "https://liff.line.me/2010457385-JHbMDl5I?event=" + tceId,
    })));
  }

  if (action === "tournament_update_event") {
    var tueId = String(params.event || "").trim();
    if (!tueId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing event" })));
    var tueSt = String(params.status || "").trim();
    if (tueSt && ["draft","open","closed","completed"].indexOf(tueSt) < 0)
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "invalid status" })));
    var tueRow = getSupabaseRow_("tournament_events", "event_id", tueId);
    if (!tueRow) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
    if (tueSt) tueRow.status = tueSt;
    if (params.name !== undefined) tueRow.name = String(params.name).trim();
    if (params.date !== undefined) tueRow.date = String(params.date).trim();
    if (params.entry_fee !== undefined) tueRow.entry_fee = Number(params.entry_fee) || 0;
    if (params.max_players !== undefined) tueRow.max_players = Number(params.max_players) || 0;
    if (params.rules_text !== undefined) tueRow.rules_text = String(params.rules_text).trim();
    if (params.registration_close !== undefined) tueRow.registration_close = String(params.registration_close).trim();
    writeSupabaseRow_("tournament_events", tueRow, SUPABASE_TOURNAMENT_EVENTS_HEADER, "event_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  }

  if (action === "tournament_update_reg") {
    var turId = String(params.reg_id || "").trim();
    var turField = String(params.field || "").trim();
    var turValue = String(params.value || "").trim();
    if (!turId || !turField) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing params" })));
    if (["slip_status","status","note","checked_in_at"].indexOf(turField) < 0) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "invalid field" })));
    var turRow = getSupabaseRow_("tournament_registrations", "reg_id", turId);
    if (!turRow) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
    turRow[turField] = turValue;
    if (turField === "slip_status" && turValue === "verified") {
      var turUid = String(turRow.line_user_id || "");
      var turPName = String(turRow.player_name || "");
      var turSeq = Number(turRow.sequence_no) || 0;
      var turEvId = String(turRow.event_id || "");
      var turEvName = "", turEvDate = "";
      var turEvRow = getSupabaseRow_("tournament_events", "event_id", turEvId);
      if (turEvRow) {
        turEvName = String(turEvRow.name || "");
        turEvDate = String(turEvRow.date || "");
      }
      if (turUid && turUid !== "dev_user") {
        var turStatusUrl = "https://waka-liff.vercel.app/treg_status.html?id=" + encodeURIComponent(turId);
        var turMsg = "✅ ยืนยันการชำระเงินแล้ว!\n"
          + "ทัวร์นาเมนต์: " + turEvName + (turEvDate ? " — " + turEvDate : "") + "\n"
          + "ลำดับที่: " + turSeq + " | ชื่อแข่ง: " + turPName
          + "\n\n🔗 QR สำหรับวันงาน:\n" + turStatusUrl;
        _linePush(turUid, turMsg);
      }
    }
    writeSupabaseRow_("tournament_registrations", turRow, SUPABASE_TOURNAMENT_REG_HEADER, "reg_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  }

  if (action === "tournament_export") {
    var texEvId = String(params.event || "").trim();
    var texCatFilter = String(params.category || "").trim();
    var csvCols = ["reg_id","sequence_no","player_name","real_name","phone","facebook","payment_method","bank","slip_status","status","timestamp","category"];
    var csv = "﻿" + csvCols.join(",") + "\n";
    var texQuery = "select=*";
    if (texEvId) texQuery += "&event_id=eq." + encodeURIComponent(texEvId);
    var texSb = supabaseSelect_("tournament_registrations", texQuery);
    texSb.forEach(function(r) {
      var texCatList = Array.isArray(r.selected_categories) ? r.selected_categories : [];
      var texCatNames = texCatList.map(function(c) { return c.name; }).join(", ");
      if (texCatFilter && !texCatList.some(function(c) { return c.name === texCatFilter; })) return;
      var csvRow = csvCols.map(function(c) {
        if (c === "category") return '"' + texCatNames.replace(/"/g, '""') + '"';
        if (c === "phone") {
          // ="..." forces Excel to keep the leading 0 as text instead of
          // auto-converting the cell to a number on open.
          return '="' + String(r[c] || "").replace(/"/g, '""') + '"';
        }
        return '"' + String(r[c] || "").replace(/"/g, '""') + '"';
      });
      csv += csvRow.join(",") + "\n";
    });
    return ContentService.createTextOutput(csv).setMimeType(ContentService.MimeType.CSV);
  }

  if (action === "tournament_lookup") {
    var tluQ = String(params.q || params.id || "").trim().toLowerCase();
    if (!tluQ) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing query" })));
    var tluSb = supabaseSelect_("tournament_registrations", "select=*");
    var tluFound = tluSb
      .filter(function(r) {
        return String(r.reg_id || "").toLowerCase().indexOf(tluQ) >= 0
          || String(r.player_name || "").toLowerCase().indexOf(tluQ) >= 0
          || String(r.real_name || "").toLowerCase().indexOf(tluQ) >= 0;
      })
      .map(function(r) {
        return {
          reg_id: String(r.reg_id || ""),
          sequence_no: Number(r.sequence_no) || 0,
          player_name: String(r.player_name || ""),
          real_name: String(r.real_name || ""),
          phone: String(r.phone || ""),
          event_id: String(r.event_id || ""),
          slip_status: String(r.slip_status || ""),
          status: String(r.status || ""),
          checked_in_at: String(r.checked_in_at || ""),
        };
      });
    return _cors(ContentService.createTextOutput(JSON.stringify({ players: tluFound.slice(0, 20) })));
  }

  if (action === "tournament_categories") {
    var tcEvId = String(params.event || "").trim();
    if (!tcEvId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing event" })));
    var tcSb = supabaseSelect_("tournament_categories", "select=*&event_id=eq." + encodeURIComponent(tcEvId) + "&order=sort_order.asc");
    var cats = tcSb
      .filter(function(c) { return String(c.status || "") !== "deleted"; })
      .map(function(c) {
        return {
          category_id: String(c.category_id || ""),
          name: String(c.name || ""),
          entry_fee: Number(c.entry_fee) || 0,
          sort_order: Number(c.sort_order) || 0,
          status: String(c.status || "open"),
        };
      });
    return _cors(ContentService.createTextOutput(JSON.stringify({ categories: cats })));
  }

  if (action === "tournament_add_category") {
    var tacEvId = String(params.event || "").trim();
    var tacName = String(params.name || "").trim();
    var tacFee = Number(params.fee) || 0;
    if (!tacEvId || !tacName) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing params" })));
    var tacExisting = supabaseSelect_("tournament_categories", "select=category_id&event_id=eq." + encodeURIComponent(tacEvId));
    var tacId = "CAT" + Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyyMMddHHmmss");
    var tacObj = {
      category_id: tacId, event_id: tacEvId, name: tacName, entry_fee: tacFee,
      max_players: 0, sort_order: tacExisting.length + 1, status: "open",
    };
    writeSupabaseRow_("tournament_categories", tacObj, SUPABASE_TOURNAMENT_CATEGORIES_HEADER, "category_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, category_id: tacId })));
  }

  if (action === "tournament_delete_category") {
    var tdcId = String(params.category_id || "").trim();
    if (!tdcId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing category_id" })));
    var tdcRow = getSupabaseRow_("tournament_categories", "category_id", tdcId);
    if (!tdcRow) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
    tdcRow.status = "deleted";
    writeSupabaseRow_("tournament_categories", tdcRow, SUPABASE_TOURNAMENT_CATEGORIES_HEADER, "category_id");
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  }

  return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unknown action" })));
}

function isDuplicateSlip(ss, ref) {
  if (!ref) return false;
  var cache = CacheService.getScriptCache();
  var cacheKey = "slip_ref_" + String(ref).trim();
  if (cache.get(cacheKey)) return true;

  var rows = supabaseSelect_("orders", "select=order_id&slip_txn_id=eq." + encodeURIComponent(String(ref).trim()) + "&limit=1");
  if (rows.length > 0) {
    cache.put(cacheKey, "1", 3600);
    return true;
  }
  return false;
}

function isCorrectAccount(ss, toAccount, toName) {
  var acctOk = true;
  var shopAccount = _getConfigValue(null, "bank_account");
  if (shopAccount && toAccount) {
    var clean1 = String(toAccount).replace(/[-\s]/g, "");
    var clean2 = String(shopAccount).replace(/[-\s]/g, "");
    var digits1 = clean1.replace(/[^0-9]/g, "");
    acctOk = clean1.indexOf(clean2) >= 0 || clean2.indexOf(clean1) >= 0
      || (digits1.length >= 4 && clean2.indexOf(digits1) >= 0);
  }

  var nameOk = true;
  if (toName) {
    var shopNameTh = _getConfigValue(null, "bank_account_name") || "";
    var shopNameEn = _getConfigValue(null, "bank_account_name_en") || "";
    var shopNames = [];
    shopNameTh.split("|").forEach(function(n) { n = n.trim(); if (n) shopNames.push(n.toLowerCase()); });
    shopNameEn.split("|").forEach(function(n) { n = n.trim(); if (n) shopNames.push(n.toLowerCase()); });
    var slipName = String(toName).toLowerCase().replace(/[.\s]+/g, " ").trim();
    if (shopNames.length > 0) {
      nameOk = false;
      for (var ni = 0; ni < shopNames.length; ni++) {
        if (nameMatch(slipName, shopNames[ni])) { nameOk = true; break; }
      }
    }
  }

  return acctOk && nameOk;
}

function isPartialMatch(slipAcct, shopAcct) {
  var slip = String(slipAcct).replace(/[-\s.]/g, "").toLowerCase();
  var shop = String(shopAcct).replace(/[-\s.]/g, "");
  if (!slip || !shop) return true;

  if (slip.length === shop.length) {
    var matchCount = 0;
    var digitCount = 0;
    for (var i = 0; i < slip.length; i++) {
      if (slip[i] >= "0" && slip[i] <= "9") {
        digitCount++;
        if (slip[i] === shop[i]) matchCount++;
      }
    }
    return digitCount >= 3 && matchCount === digitCount;
  }

  var slipDigits = slip.replace(/[^0-9]/g, "");
  return slipDigits.length >= 3 && shop.indexOf(slipDigits) >= 0;
}

function nameMatch(slipName, shopName) {
  if (slipName.indexOf(shopName) >= 0) return true;
  if (shopName.indexOf(slipName) >= 0 && slipName.length >= 8) return true;
  var shorter = slipName.length < shopName.length ? slipName : shopName;
  var longer  = slipName.length < shopName.length ? shopName : slipName;
  return shorter.length >= 8 && longer.indexOf(shorter) === 0;
}

function nameSimilarity(a, b) {
  if (!a || !b) return 0;
  a = a.replace(/[.\s]+/g, "").trim();
  b = b.replace(/[.\s]+/g, "").trim();
  if (a === b) return 1;
  var longer = a.length > b.length ? a : b;
  var shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  var matchCount = 0;
  for (var i = 0; i < shorter.length; i++) {
    if (longer.indexOf(shorter[i]) >= 0) matchCount++;
  }
  return matchCount / longer.length;
}

function checkSlipOKQuota() {
  var slipokKey = PROPS.getProperty("SLIPOK_KEY");
  var slipokBranch = PROPS.getProperty("SLIPOK_BRANCH") || "1";
  var res = UrlFetchApp.fetch("https://api.slipok.com/api/line/apikey/" + slipokBranch + "/quota", {
    headers: { "x-authorization": slipokKey }
  });
  Logger.log(res.getContentText());
  return JSON.parse(res.getContentText());
}

function verifySlipWithSlipOK(base64, orderTotal) {
  try {
    var slipokKey = PROPS.getProperty("SLIPOK_KEY");
    var slipokBranch = PROPS.getProperty("SLIPOK_BRANCH") || "1";
    if (!slipokKey) return { error: "ไม่มี SLIPOK_KEY" };

    var bytes = Utilities.base64Decode(base64);
    var blob = Utilities.newBlob(bytes, "image/jpeg", "slip.jpg");

    var payload = { files: blob, log: "true" };
    if (orderTotal) payload.amount = String(orderTotal);

    var res = UrlFetchApp.fetch("https://api.slipok.com/api/line/apikey/" + slipokBranch, {
      method: "post",
      muteHttpExceptions: true,
      headers: { "x-authorization": slipokKey },
      payload: payload
    });

    var rawText = res.getContentText();
    var body = JSON.parse(rawText);
    if (!body.success) return { error: "SlipOK: " + (body.message || rawText.substring(0, 200)) };
    if (!body.data) return { error: "SlipOK: no data" };

    var d = body.data;
    if (d.success === false) return { error: "SlipOK: QR ไม่ถูกต้อง - " + (d.message || "") };

    var rcvAcct = (d.receiver && d.receiver.account && d.receiver.account.value) || "";
    var rcvName = (d.receiver && (d.receiver.displayName || d.receiver.name)) || "";
    var sndName = (d.sender && (d.sender.displayName || d.sender.name)) || "";
    var bankCode = d.sendingBank || "";

    return {
      amount: Number(d.amount) || 0,
      date: (d.transDate || "") + " " + (d.transTime || ""),
      bank: bankCode,
      ref: d.transRef || "",
      to_account: rcvAcct,
      to_name: rcvName,
      sender_name: sndName,
      suspicious: false,
      suspicious_reason: "",
      source: "slipok"
    };
  } catch (err) {
    return { error: "SlipOK error: " + err.message };
  }
}

function verifySlipWithClaude(base64) {
  try {
    var claudeKey = PROPS.getProperty("CLAUDE_KEY");
    if (!claudeKey) return { error: "ไม่มี CLAUDE_KEY" };

    var res = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      muteHttpExceptions: true,
      headers: {
        "x-api-key": claudeKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      payload: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        system: 'คุณคือระบบอ่านสลิปโอนเงินไทยที่ต้องแม่นยำสูงสุด ห้ามเดาหรือแก้ไขข้อมูลเอง\n\n'
          + 'รายชื่อ/คำที่พบบ่อยในระบบนี้ (ใช้เทียบเสียง/รูปร่างตัวอักษรที่ใกล้เคียงเวลาอ่านไม่ชัด):\n'
          + '- วากะ (WAKA) — ระวังสับสนกับ "วาทะ" (ก/ท คล้ายกัน)\n'
          + '- บจก. วากะ คอร์ป / WAKA CORP — ชื่อบัญชีปลายทาง\n'
          + '- WAKA COFFEE — ชื่อบัญชี PromptPay/แม่มณี\n'
          + '- บริษัท วากะ คอร์ป จำกัด — ชื่อเต็ม\n\n'
          + 'กฎการอ่าน:\n'
          + '1. อ่านชื่อตามที่ปรากฏ ห้ามตัดคำใหม่หรือสลับลำดับ\n'
          + '2. ถ้าคำที่อ่านได้มีรูปร่าง/เสียงใกล้เคียงกับคำในลิสต์ด้านบน ให้เลือกคำในลิสต์\n'
          + '3. ตัวเลข (จำนวนเงิน, เลขอ้างอิง, เลขบัญชี) ต้องอ่านทุกหลักอย่างละเอียด\n'
          + '4. สลิปไทยปกติจะซ่อนเลขบัญชีบางส่วนเป็น xxx หรือ * อย่าถือว่าผิดปกติ\n'
          + '5. suspicious=true เฉพาะกรณีชัดเจนว่าตัดต่อ เช่น ตัวเลขซ้อนกัน ฟอนต์คนละแบบ layout ไม่ตรง',
        messages: [{
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64 } },
            { type: "text", text: 'อ่านสลิปโอนเงินนี้ ตอบเป็น JSON เท่านั้น ห้ามครอบด้วย markdown:\n{"amount": 0, "date": "", "bank": "", "ref": "", "to_account": "", "to_name": "", "suspicious": false, "suspicious_reason": "", "confidence_note": ""}\nto_account=เลขบัญชีปลายทาง, to_name=ชื่อบัญชีปลายทาง, confidence_note=จุดที่อ่านไม่มั่นใจ(ถ้ามี)' }
          ]
        }]
      })
    });

    var rawText = res.getContentText();
    var body = JSON.parse(rawText);
    if (body.error) return { error: body.error.message || body.error.type || "API error" };
    var text = (body.content && body.content[0] && body.content[0].text) || "";
    if (!text) return { error: "Claude ไม่ตอบ: " + rawText.substring(0, 200) };
    text = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
    var match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); }
      catch (pe) { return { error: "JSON parse error: " + match[0].substring(0, 200) }; }
    }
    return { error: "ไม่พบ JSON: " + text.substring(0, 200) };
  } catch (err) {
    return { error: err.message };
  }
}

// ── Shipment: สร้างล็อตส่งสาขา ──────────────────────────────────────────────
// data: { to_branch, items: [{name, qty_box, qty_pack, qty_box_extra, qty_pack_extra}] }
function handleCreateShipment(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var nowDisplay = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var shipId = "SH" + Utilities.formatDate(new Date(), "Asia/Bangkok", "yyMMddHHmmss");

    // D4: ตรวจ duplicate shipment_id ก่อน insert
    var shExisting = supabaseSelect_("shipments", "select=shipment_id&shipment_id=eq." + encodeURIComponent(shipId));
    if (shExisting.length > 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ล็อตนี้ถูกสร้างไปแล้ว กรุณารอสักครู่แล้วลองใหม่" })));
    }

    var items = data.items || [];
    // ตัดสต็อกกลาง (catalog, Supabase-primary)
    var shCatRows = _fetchCatalogRows_();
    var shChangedNames = [];
    for (var idx = 0; idx < items.length; idx++) {
      var it = items[idx];
      var shRow = _findCatalogRow_(shCatRows, it.name);
      if (!shRow) continue;
      var totalBox = (it.qty_box || 0) + (it.qty_box_extra || 0);
      var totalPack = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
      if (totalBox > 0)  { shRow.qty_box  = Math.max(0, (Number(shRow.qty_box)  || 0) - totalBox);  shChangedNames.push(it.name); }
      if (totalPack > 0) { shRow.qty_pack = Math.max(0, (Number(shRow.qty_pack) || 0) - totalPack); shChangedNames.push(it.name); }
    }

    var shObj = { shipment_id: shipId, timestamp: now, to_branch: data.to_branch || "", status: "จัดส่ง", items_json: items, received_at: null };
    writeSupabaseRow_("shipments", shObj, SUPABASE_SHIPMENTS_HEADER, "shipment_id", lock);
    if (shChangedNames.length) _pushCatalogRows_(shCatRows, shChangedNames);

    // LINE แจ้งกลุ่ม staff
    try {
      var cfgWs = ss.getSheetByName(TAB_CONFIG);
      var groupId = _getConfigValue(cfgWs, "group_staff");
      if (groupId) {
        var itemLines = items.map(function(it) {
          var parts = [];
          var tb = (it.qty_box || 0) + (it.qty_box_extra || 0);
          var tp = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
          if (tb > 0) parts.push("Box " + tb + (it.qty_box_extra ? " (เผื่อ " + it.qty_box_extra + ")" : ""));
          if (tp > 0) parts.push("Pack " + tp + (it.qty_pack_extra ? " (เผื่อ " + it.qty_pack_extra + ")" : ""));
          return "  - " + it.name + ": " + parts.join(", ");
        }).join("\n");
        var receiveUrl = "https://waka-liff.vercel.app/warehouse.html?tab=history";
        _linePush(groupId, "📦 สร้างล็อตส่งสาขา " + (data.to_branch || "") + "\n\n" + shipId + " — " + nowDisplay + "\n\n" + itemLines + "\n\nเมื่อสินค้าถึงสาขาแล้ว กดรับของที่:\n" + receiveUrl);
      }
    } catch(_) {}

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, shipment_id: shipId })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── Shipment: ยกเลิกลอต + คืนสต็อกกลาง ─────────────────────────────────────
function handleCancelShipment(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    // shipment_id isn't a unique key (see supabase/schema.sql — historical
    // Sheet-era duplicates exist), so fetch every row with this shipment_id
    // and take the first one that isn't already received/cancelled, same
    // as the old Sheet scan's `continue`-past-finished-rows behavior.
    var csRows = supabaseSelect_("shipments", "select=id,status,items_json&shipment_id=eq." + encodeURIComponent(data.shipment_id));
    var csTarget = null;
    for (var i = 0; i < csRows.length; i++) {
      var status = String(csRows[i].status || "");
      if (status === "รับแล้ว" || status === "ยกเลิก") continue;
      csTarget = csRows[i];
      break;
    }
    if (!csTarget) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบลอต" })));
    }

    // คืนสต็อกกลาง (catalog, Supabase-primary)
    var items = Array.isArray(csTarget.items_json) ? csTarget.items_json : [];
    var csCatRows = items.length > 0 ? _fetchCatalogRows_() : null;
    var csChangedNames = [];
    if (csCatRows) {
      for (var idx = 0; idx < items.length; idx++) {
        var it = items[idx];
        var csRow = _findCatalogRow_(csCatRows, it.name);
        if (!csRow) continue;
        var totalBox = (it.qty_box || 0) + (it.qty_box_extra || 0);
        var totalPack = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
        if (totalBox > 0)  { csRow.qty_box  = (Number(csRow.qty_box)  || 0) + totalBox;  csChangedNames.push(it.name); }
        if (totalPack > 0) { csRow.qty_pack = (Number(csRow.qty_pack) || 0) + totalPack; csChangedNames.push(it.name); }
      }
    }
    var csPatchRes = patchSupabase_("shipments", "id=eq." + csTarget.id, { status: "ยกเลิก" });
    if (!csPatchRes.ok) throw new Error("Supabase shipments cancel failed: " + csPatchRes.text);
    lock.releaseLock();
    if (csChangedNames.length) _pushCatalogRows_(csCatRows, csChangedNames);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch(err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── Shipment: สาขารับของ + เพิ่มสต็อกสาขา + แจ้งลูกค้า ───────────────────
// data: { shipment_id }
function handleReceiveShipment(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var staffName = String(data.staff_name || "").trim();
    // shipment_id isn't a unique key — same historical-duplicate handling as
    // handleCancelShipment: take the first row that isn't already received/cancelled.
    var rsRows = supabaseSelect_("shipments", "select=id,to_branch,status,items_json&shipment_id=eq." + encodeURIComponent(data.shipment_id));
    var rsTarget = null;
    for (var i = 0; i < rsRows.length; i++) {
      var rowStatus = String(rsRows[i].status || "");
      if (rowStatus === "รับแล้ว" || rowStatus === "ยกเลิก") continue;
      rsTarget = rsRows[i];
      break;
    }
    if (!rsTarget) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true }))); }
    var branch = String(rsTarget.to_branch || "");
    var items = Array.isArray(rsTarget.items_json) ? rsTarget.items_json : [];

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var rsPatchRes = patchSupabase_("shipments", "id=eq." + rsTarget.id, { status: "รับแล้ว", received_at: now });
    if (!rsPatchRes.ok) throw new Error("Supabase shipments receive failed: " + rsPatchRes.text);

    // เพิ่มสต็อกสาขา (Supabase-primary)
    var bsRows = _fetchStockBranchRows_(branch);
    var bsRowsToWrite = [];
    for (var idx = 0; idx < items.length; idx++) {
      var it = items[idx];
      var addBox = (it.qty_box || 0) + (it.qty_box_extra || 0);
      var addPack = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
      var bsRow = _findStockBranchRow_(bsRows, it.name, branch);
      if (bsRow) {
        if (addBox  > 0) { bsRow.qty_box  = (Number(bsRow.qty_box)  || 0) + addBox; }
        if (addPack > 0) { bsRow.qty_pack = (Number(bsRow.qty_pack) || 0) + addPack; }
        if (addBox > 0 || addPack > 0) bsRowsToWrite.push(bsRow);
      } else {
        bsRow = { name: it.name, category: it.category || "", branch: branch, qty_box: addBox, qty_pack: addPack };
        bsRows.push(bsRow);
        bsRowsToWrite.push(bsRow);
      }
    }
    // Same reasoning as handleWakagymRegister: push every changed
    // stock_branch row to Supabase now (fast, needs the lock — concurrent
    // shipment receives for the same branch/product must not race), but
    // defer each row's mirrorToReportSheet_ scan until after the lock
    // releases below.
    var pendingStockMirrors = [];
    bsRowsToWrite.forEach(function(r) {
      var res = pushToSupabase_("stock_branch", r);
      if (!res.ok) throw new Error("Supabase stock_branch write failed (" + r.name + "/" + r.branch + "): " + res.text);
      pendingStockMirrors.push(r);
    });

    // แจ้ง LINE ลูกค้าทุกคนที่มีออเดอร์ยืนยัน + สาขานี้ + ยังไม่ส่ง
    // fulfillment=not.in.(...) ทำใน PostgREST ไม่ได้เพราะ NULL (ออเดอร์ใหม่ยัง
    // ไม่เคยตั้ง fulfillment) จะหลุด filter ไปด้วย — กรองใน JS แทน
    //
    // This can match an unbounded number of orders (every unshipped
    // confirmed order for the branch) — the same defer pattern applies,
    // now doubly important since this loop was previously the single
    // worst-case source of lock-hold time in the whole file: N order
    // mirror-scans + N LINE pushes, all serialized under one script-wide
    // lock that every other concurrent request had to wait behind.
    var excludedFf = ["พร้อมรับ", "บางส่วน", "รับบางส่วนแล้ว", "สาขายืนยัน", "รับแล้ว"];
    var oMatches = supabaseSelect_("orders", "select=*&branch=eq." + encodeURIComponent(branch) + "&slip_status=eq.ยืนยัน");
    var pendingOrderMirrors = [];
    var pendingNotifications = [];
    for (var j = 0; j < oMatches.length; j++) {
      var ord = oMatches[j];
      var oFf = ord.fulfillment || "";
      if (excludedFf.indexOf(oFf) >= 0) continue;
      ord.fulfillment = "พร้อมรับ";
      ord.fulfilled_at = now;
      var ordRes = pushToSupabase_("orders", ord);
      if (!ordRes.ok) throw new Error("Supabase orders write failed: " + ordRes.text);
      pendingOrderMirrors.push(ord);
      var uid = ord.line_user_id || "";
      var oid = String(ord.order_id || "");
      if (uid) {
        var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + oid;
        pendingNotifications.push({ uid: uid, msg: "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + oid + "\n\nดูสถานะ:\n" + trackUrl });
      }
    }

    lock.releaseLock();
    pendingStockMirrors.forEach(function(r) { mirrorToReportSheet_("stock_branch", SUPABASE_STOCK_BRANCH_HEADER, ["name", "branch"], r); });
    pendingOrderMirrors.forEach(function(o) { mirrorToReportSheet_("orders", SUPABASE_ORDERS_HEADER, "order_id", o); });
    pendingNotifications.forEach(function(n) { _linePush(n.uid, n.msg); });

    var groupStaffReceive = _getConfigValue(null, "group_staff");
    if (groupStaffReceive && staffName) {
      var receiveItemsText = items.map(function(it) {
        var parts = [];
        var tb = (it.qty_box || 0) + (it.qty_box_extra || 0);
        var tp = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
        if (tb > 0) parts.push("Box " + tb);
        if (tp > 0) parts.push("Pack " + tp);
        return "  - " + it.name + ": " + parts.join(", ");
      }).join("\n");
      _linePush(groupStaffReceive, "📥 " + staffName + " รับของจากคลังที่สาขา " + branch + " แล้ว\nล็อต: " + data.shipment_id + "\n\n" + receiveItemsText);
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ส่งมอบลูกค้า: ตัดสต็อกสาขา ────────────────────────────────────────────
// data: { order_id, staff_name }
function handleHandoverOrder(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
    var staffName = String(data.staff_name || "").trim();

    var order = getSupabaseOrder_(data.order_id);
    if (!order) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
    }
    var branch = order.branch || "";
    if (!_branchAuthorized(data.code, branch)) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }
    var items = Array.isArray(order.items_json) ? order.items_json : [];

    // หา item ที่จะส่งมอบรอบนี้:
    // ถ้ามี ready_at (partial flow) → เอาเฉพาะที่ ready_at set แต่ยังไม่ handed_at
    // ถ้าไม่มี ready_at เลย (old order) → เอา item ทั้งหมดที่ยังไม่ handed_at
    var hasReadyAt = items.some(function(it) { return !!it.ready_at; });
    var itemsToHandover = items.filter(function(it) {
      if (it.cancelled_at) return false;
      if (it.handed_at) return false;
      return hasReadyAt ? !!it.ready_at : true;
    });

    if (itemsToHandover.length === 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีสินค้าที่พร้อมส่งมอบ" })));
    }

    // ตัดสต็อกสาขาเฉพาะ itemsToHandover (Supabase-primary)
    var hoRows = _fetchStockBranchRows_(branch);
    var hoRowsToWrite = [];
    for (var idx = 0; idx < itemsToHandover.length; idx++) {
      var it = itemsToHandover[idx];
      var hoRow = _findStockBranchRow_(hoRows, it.name, branch);
      if (!hoRow) continue;
      var hoField = it.type === "box" ? "qty_box" : "qty_pack";
      hoRow[hoField] = Math.max(0, (Number(hoRow[hoField]) || 0) - (it.qty || 1));
      hoRowsToWrite.push(hoRow);
    }
    hoRowsToWrite.forEach(function(r) { _writeStockBranchRow_(r); });

    // ตั้ง handed_at บน item ที่เพิ่งส่งมอบ
    var handoverNames = [];
    for (var idx = 0; idx < items.length; idx++) {
      for (var jj = 0; jj < itemsToHandover.length; jj++) {
        if (items[idx] === itemsToHandover[jj]) {
          items[idx].handed_at = now;
          handoverNames.push(items[idx].name + " x" + items[idx].qty + (items[idx].type === "box" ? " กล่อง" : " ซอง"));
          break;
        }
      }
    }
    order.items_json = items;

    // กำหนด fulfillment ใหม่
    var allDone = items.every(function(it) { return !!it.handed_at || !!it.cancelled_at; });
    var newFf = allDone ? "สาขายืนยัน" : "รับบางส่วนแล้ว";
    order.fulfillment = newFf;
    order.staff_confirmed_at = now;
    _clearDashCache();

    // แจ้งลูกค้า
    var uid = order.line_user_id || "";
    if (uid) {
      var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + data.order_id;
      var pendingItems = items.filter(function(it) { return !it.handed_at && !it.cancelled_at; });
      var msg;
      if (allDone) {
        msg = "สาขาส่งมอบสินค้าครบแล้ว กรุณากดยืนยันรับของ\n\nออเดอร์: #" + data.order_id + "\n\nกดยืนยัน:\n" + trackUrl;
      } else {
        msg = "📦 ส่งมอบสินค้าบางส่วนแล้ว\nออเดอร์: #" + data.order_id + "\n\n✅ รับแล้ว:\n" +
          handoverNames.map(function(n) { return "- " + n; }).join("\n") +
          "\n\n⏳ รอสินค้า:\n" + pendingItems.map(function(it) { return "- " + it.name + " x" + it.qty; }).join("\n") +
          "\n\nสินค้าที่เหลือจะแจ้งให้ทราบเมื่อพร้อม";
      }
      _linePush(uid, msg);
      order.notified_at = now;
    }

    var groupStaffHandover = _getConfigValue(null, "group_staff");
    if (groupStaffHandover && staffName) {
      _linePush(groupStaffHandover, "🤝 " + staffName + " ส่งมอบออเดอร์ #" + data.order_id + " ที่สาขา " + branch + " แล้ว\n" +
        handoverNames.map(function(n) { return "- " + n; }).join("\n"));
    }

    writeSupabaseOrder_(order, lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now, fulfillment: newFf })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── แจ้งพร้อมรับบางส่วน ─────────────────────────────────────────────────────
// data: { order_id, indices: [0,1,...] } — zero-based index ของ items ที่พร้อม
function handlePartialReady(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var indices = data.indices || [];
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");

    var order = getSupabaseOrder_(data.order_id);
    if (!order) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
    }
    var branch = order.branch || "";
    if (!_branchAuthorized(data.code, branch)) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }
    var uid = order.line_user_id || "";
    var items = Array.isArray(order.items_json) ? order.items_json : [];

    // ตั้ง ready_at บน items ที่เลือก (ที่ยังไม่ handed_at, ไม่ cancelled, และยังไม่ ready_at มาก่อน)
    var newlyReady = [];
    for (var ii = 0; ii < indices.length; ii++) {
      var idx = indices[ii];
      if (idx >= 0 && idx < items.length && !items[idx].handed_at && !items[idx].cancelled_at && !items[idx].ready_at) {
        items[idx].ready_at = now;
        newlyReady.push(items[idx]);
      }
    }

    // ไม่มีอะไรเปลี่ยนจริง (รายการที่เลือกแจ้งพร้อมรับไปแล้วทั้งหมด) — ไม่ต้องเขียนซ้ำ
    // หรือแจ้งลูกค้าซ้ำ กันปุ่มที่กดซ้ำ (เช่นหน้าค้นหาที่ข้อมูลยังไม่ refresh) ส่ง LINE ซ้ำ
    if (newlyReady.length === 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "รายการที่เลือกแจ้งพร้อมรับไปแล้ว" })));
    }

    order.items_json = items;

    // fulfillment ใหม่
    var activeItems = items.filter(function(it) { return !it.cancelled_at; });
    var allReady = activeItems.length > 0 && activeItems.every(function(it) { return !!it.ready_at || !!it.handed_at; });
    var newFf = allReady ? "พร้อมรับ" : "บางส่วน";
    order.fulfillment = newFf;
    order.fulfilled_at = now;
    _clearDashCache();

    // LINE แจ้งลูกค้า
    if (uid) {
      var readyItems = items.filter(function(it) { return (!!it.ready_at || !!it.handed_at) && !it.cancelled_at; });
      var pendingItems = items.filter(function(it) { return !it.ready_at && !it.handed_at && !it.cancelled_at; });
      var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + data.order_id;
      var msg = "📦 สินค้า" + (allReady ? "พร้อมรับแล้ว!" : "บางส่วนพร้อมรับแล้ว!") + "\nออเดอร์: #" + data.order_id + "\n";
      msg += "\n✅ พร้อมรับ:\n" + readyItems.map(function(it) {
        return "- " + it.name + " x" + it.qty + (it.type === "box" ? " กล่อง" : " ซอง");
      }).join("\n");
      if (pendingItems.length > 0) {
        msg += "\n\n⏳ รอสินค้า:\n" + pendingItems.map(function(it) {
          return "- " + it.name + " x" + it.qty + (it.type === "box" ? " กล่อง" : " ซอง");
        }).join("\n");
      }
      msg += "\n\nกรุณามารับที่สาขา" + branch + " ได้เลยครับ\n" + trackUrl;
      _linePush(uid, msg);
      order.notified_at = now;
    }

    writeSupabaseOrder_(order, lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, fulfillment: newFf })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ยกเลิกบางชิ้นในออเดอร์ ──────────────────────────────────────────────────
// data: { order_id, indices: [0,1,...], reason: "..." }
function handlePartialCancelItems(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var indices = data.indices || [];
    var reason = String(data.reason || "");
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");

    var order = getSupabaseOrder_(data.order_id);
    if (!order) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
    }
    var branch = order.branch || "";
    if (!_branchAuthorized(data.code, branch)) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }
    var uid = order.line_user_id || "";
    var items = Array.isArray(order.items_json) ? order.items_json : [];

    // mark items ที่ยังไม่ handed_at เป็น cancelled
    var cancelledItems = [];
    for (var ii = 0; ii < indices.length; ii++) {
      var idx = indices[ii];
      if (idx >= 0 && idx < items.length && !items[idx].handed_at && !items[idx].cancelled_at) {
        items[idx].cancelled_at = now;
        items[idx].cancel_reason = reason;
        cancelledItems.push(items[idx]);
      }
    }
    if (cancelledItems.length === 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีรายการที่ยกเลิกได้" })));
    }

    // คืน stock + limits
    restoreStock(cancelledItems);
    restoreCatalogLimits(cancelledItems);

    order.items_json = items;

    // ถ้าทุก item cancelled → ปิด order
    if (items.every(function(it) { return !!it.cancelled_at; })) {
      order.fulfillment = "ยกเลิก";
    }
    _clearDashCache();

    // LINE แจ้งลูกค้า
    if (uid) {
      var cancelText = cancelledItems.map(function(it) {
        return "- " + it.name + " x" + it.qty + (it.type === "box" ? " กล่อง" : " ซอง");
      }).join("\n");
      var reasonLine = reason ? "\nเหตุผล: " + reason : "";
      _linePush(uid,
        "❌ ยกเลิกสินค้าบางรายการ\nออเดอร์: #" + data.order_id + "\n\n" +
        "รายการที่ยกเลิก:\n" + cancelText + reasonLine +
        "\n\nหากมีข้อสงสัยกรุณาติดต่อทีมงาน 🙏"
      );
    }

    writeSupabaseOrder_(order, lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, cancelled: cancelledItems.length })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── อัปโหลดรูปสินค้าไป Google Drive ────────────────────────────────────────
// data: { base64, mimeType, filename }
function handleUploadProductImage(data) {
  try {
    var base64 = data.base64 || "";
    if (!base64) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no image" })));
    var folderId = PROPS.getProperty("PRODUCT_IMG_FOLDER_ID") || PROPS.getProperty("SLIP_FOLDER_ID");
    var folder = folderId ? DriveApp.getFolderById(folderId) : DriveApp.getRootFolder();
    var mimeType = data.mimeType || "image/jpeg";
    var filename = String(data.filename || ("product_" + new Date().getTime() + ".jpg")).replace(/[^a-zA-Z0-9._-]/g, "_");
    var bytes = Utilities.base64Decode(base64);
    var blob = Utilities.newBlob(bytes, mimeType, filename);
    var file = folder.createFile(blob);
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var url = "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w800";
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, url: url })));
  } catch(err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function _sanitize(val) {
  var s = String(val || "");
  if (s.length > 0 && "=+-@\t\r".indexOf(s[0]) >= 0) s = "'" + s;
  return s;
}

function _driveUrl(url) {
  if (!url) return "";
  var m = url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return "https://drive.google.com/thumbnail?id=" + m[1] + "&sz=w800";
  return url;
}

function handleConfirmSlip(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var order = getSupabaseOrder_(data.order_id);
    if (!order) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));

    var currentSlip = order.slip_status || "";
    if (currentSlip === "ยืนยัน") return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    order.slip_status = "ยืนยัน";
    order.notes = "Admin confirm " + now;

    var uid = order.line_user_id || "";
    var orderId = String(order.order_id || "");
    var branch = order.branch || "";
    var total = order.total || 0;
    var items = Array.isArray(order.items_json) ? order.items_json : [];

    if (uid) {
      var message;
      if (data.custom_message && String(data.custom_message).trim()) {
        message = String(data.custom_message).trim();
      } else {
        var itemsText = items.map(function(it) {
          var unit = it.type === "box" ? "กล่อง" : "ซอง";
          return "  - " + it.name + " (" + unit + ") x" + it.qty;
        }).join("\n");
        var isDelivery = branch === "จัดส่ง";
        message = "ยืนยันการชำระเงินแล้ว ✅\n\nออเดอร์: #" + orderId + "\n\n" + itemsText + "\n\nยอดรวม: " + total + " บาท\n" + (isDelivery ? "จัดส่งพัสดุ" : "รับที่สาขา: " + branch) + "\n\nทีมงานจะแจ้งเมื่อสินค้าพร้อมรับครับ";
      }
      _linePush(uid, message);
    }

    writeSupabaseOrder_(order, lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  } finally {
    // writeSupabaseOrder_ already released the lock on the success path
    // (before its mirror step) — this is a safety-net re-release for the
    // early-return/error paths above that never reached that call, and is a
    // harmless no-op if the lock is already free.
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ── แอดมินยกเลิก/ปฏิเสธออเดอร์ (เช่น กดพลาด หรือลูกค้าแนบสลิปผิด) ──
// data: { order_id, reason (optional) }
function handleRejectSlip(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var order = getSupabaseOrder_(data.order_id);
    if (!order) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));

    var orderId = String(order.order_id || "");
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var reason = String(data.reason || "").trim();
    var note = "Admin reject " + now + (reason ? " (" + reason + ")" : "");

    order.slip_status = "ยกเลิก";
    order.notes = note;

    var uid = order.line_user_id || "";
    if (uid && uid !== "dev_user") {
      var reasonLine = reason ? "\nเหตุผล: " + reason : "";
      var msg = "🙏 แอดมินขออนุญาตยกเลิกออเดอร์ #" + orderId + " หากมีข้อสงสัยหรือต้องการสอบถามเพิ่มเติม ติดต่อแอดมินได้เลยนะคะ" + reasonLine +
        "\n\nขออภัยลูกค้าด้วยนะคะ ขอบคุณค่ะ 💛";
      _linePush(uid, msg);
    }

    writeSupabaseOrder_(order, lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  } finally {
    // See handleConfirmSlip's identical comment — harmless no-op re-release.
    try { lock.releaseLock(); } catch (_) {}
  }
}

// ── แจ้งเตือนลูกค้าซ้ำ (manual, จากแอดมิน) ──
// data: { order_id }
function handleNotifyCustomer(data) {
  try {
    var order = getSupabaseOrder_(data.order_id);
    if (!order) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));

    var uid = order.line_user_id || "";
    if (!uid) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ออเดอร์นี้ไม่มี LINE user id" })));

    var orderId = String(order.order_id || "");
    var branch = order.branch || "";
    var total = order.total || 0;
    var slipStatus = order.slip_status || "";
    var fulfillment = order.fulfillment || "รอเตรียม";
    var items = Array.isArray(order.items_json) ? order.items_json : [];

    var message;
    if (data.custom_message && String(data.custom_message).trim()) {
      message = String(data.custom_message).trim();
    } else {
      var itemsText = items.map(function(it) {
        var unit = it.type === "box" ? "กล่อง" : "ซอง";
        return "  - " + it.name + " (" + unit + ") x" + it.qty;
      }).join("\n");
      var isDelivery = branch === "จัดส่ง";
      message = "แจ้งเตือนสถานะออเดอร์ #" + orderId + "\n\n" + itemsText +
        "\n\nยอดรวม: " + total + " บาท\n" +
        (isDelivery ? "จัดส่งพัสดุ" : "รับที่สาขา: " + branch) +
        "\n\nสถานะสลิป: " + (slipStatus || "รอตรวจ") +
        "\nสถานะจัดส่ง: " + fulfillment;
    }
    _linePush(uid, message);
    var notifyNow = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
    order.notified_at = notifyNow;
    writeSupabaseOrder_(order);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: notifyNow })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ส่งข้อความ (เช่น ปิดงาน/ขอบคุณ) ให้ผู้สมัครทัวร์นาเมนต์ที่เลือกเป็นชุด ──
// data: { reg_ids: [...], custom_message }
function handleNotifyTournamentPlayers(data) {
  try {
    var message = String(data.custom_message || "").trim();
    var regIds = Array.isArray(data.reg_ids) ? data.reg_ids.map(String) : [];
    if (!message || !regIds.length) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing custom_message or reg_ids" })));
    }
    var idSet = {};
    regIds.forEach(function(id) { idSet[id] = true; });
    var ntpSb = supabaseSelect_("tournament_registrations", "select=reg_id,line_user_id");
    var sent = 0;
    ntpSb.forEach(function(r) {
      if (!idSet[String(r.reg_id)]) return;
      var uid = r.line_user_id || "";
      if (!uid || uid === "dev_user") return;
      _linePush(uid, message);
      sent++;
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, sent: sent })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เพิ่มสต็อกสินค้าเดิม ──
// data: { name, add_box, add_pack }
function handleAddStock(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = getSupabaseRow_("catalog", "name", data.name);
    if (!row) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้าใน catalog: " + data.name })));
    }
    if (data.add_box)  row.qty_box  = (Number(row.qty_box)  || 0) + Number(data.add_box);
    if (data.add_pack) row.qty_pack = (Number(row.qty_pack) || 0) + Number(data.add_pack);
    if (data.limit_box !== undefined && data.limit_box !== null) row.limit_box = Number(data.limit_box);
    if (data.limit_pack !== undefined && data.limit_pack !== null) row.limit_pack = Number(data.limit_pack);
    CacheService.getScriptCache().remove("catalog_config");
    writeSupabaseRow_("catalog", row, SUPABASE_CATALOG_HEADER, "name", lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เพิ่มสินค้าใหม่ใน catalog ──
// data: { name, category, price_box, price_pack, cost_box, cost_pack, barcode, initial_box, initial_pack }
function handleAddProduct(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var existing = getSupabaseRow_("catalog", "name", data.name);
    if (existing) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "สินค้าชื่อนี้มีอยู่แล้ว" })));
    }

    var limBox = (data.limit_box === "" || data.limit_box === undefined || data.limit_box === null) ? null : Number(data.limit_box);
    var limPack = (data.limit_pack === "" || data.limit_pack === undefined || data.limit_pack === null) ? null : Number(data.limit_pack);
    var newRow = {
      name: data.name, category: data.category || "", slug: "",
      cost_box: Number(data.cost_box) || 0, cost_p: Number(data.cost_pack) || 0,
      price_box: Number(data.price_box) || 0, price_pack: Number(data.price_pack) || 0,
      qty_box: Number(data.initial_box) || 0, qty_pack: Number(data.initial_pack) || 0,
      limit_box: limBox, limit_pack: limPack, active: "TRUE",
      image_url: data.image_url || "", barcode: data.barcode || "", notice: "",
    };
    CacheService.getScriptCache().remove("catalog_config");
    writeSupabaseRow_("catalog", newRow, SUPABASE_CATALOG_HEADER, "name", lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function handleUpdateProduct(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = getSupabaseRow_("catalog", "name", data.name);
    if (!row) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + data.name }))); }
    if (data.category !== undefined) row.category = data.category;
    if (data.cost_box !== undefined) row.cost_box = Number(data.cost_box) || 0;
    if (data.cost_pack !== undefined) row.cost_p = Number(data.cost_pack) || 0;
    if (data.price_box !== undefined) row.price_box = Number(data.price_box) || 0;
    if (data.price_pack !== undefined) row.price_pack = Number(data.price_pack) || 0;
    if (data.limit_box !== undefined) row.limit_box = data.limit_box === "" ? null : Number(data.limit_box);
    if (data.limit_pack !== undefined) row.limit_pack = data.limit_pack === "" ? null : Number(data.limit_pack);
    if (data.active !== undefined) row.active = data.active ? "TRUE" : "FALSE";
    if (data.image_url !== undefined) row.image_url = data.image_url || "";
    if (data.barcode !== undefined) row.barcode = data.barcode || "";
    if (data.notice !== undefined) row.notice = data.notice || "";
    CacheService.getScriptCache().remove("catalog_config");
    writeSupabaseRow_("catalog", row, SUPABASE_CATALOG_HEADER, "name", lock);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เบิกสินค้าจากสต็อกสาขา ────────────────────────────────────────────────
// data: { branch, name, type, qty, reason, staff_name }
function handleWithdrawStock(data) {
  var branch = String(data.branch || "").trim();
  var name   = String(data.name   || "").trim();
  var type   = String(data.type   || "box").trim();
  var qty    = Number(data.qty)   || 0;
  var reason = String(data.reason || "").trim();
  var staffName = String(data.staff_name || "").trim();

  if (!branch || !name || qty <= 0) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ (branch, name, qty)" })));
  }
  if (!_branchAuthorized(data.code, branch)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var bsRow = _findStockBranchRow_(_fetchStockBranchRows_(branch), name, branch);
    if (!bsRow) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch })));
    }
    var wField = type === "box" ? "qty_box" : "qty_pack";
    bsRow[wField] = Math.max(0, (Number(bsRow[wField]) || 0) - qty);
    _writeStockBranchRow_(bsRow);

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var wObj = { timestamp: now, branch: branch, name: name, type: type, qty: qty, reason: reason };
    var wRes = pushToSupabase_("withdrawals", wObj);
    if (!wRes.ok) throw new Error("Supabase withdrawals write failed: " + wRes.text);
    lock.releaseLock();
    mirrorToReportSheet_("withdrawals", SUPABASE_WITHDRAWALS_HEADER, ["timestamp", "branch", "name"], wObj);

    var groupStaffWithdraw = _getConfigValue(null, "group_staff");
    if (groupStaffWithdraw && staffName) {
      var unitLabel = type === "box" ? "กล่อง" : "ซอง";
      _linePush(groupStaffWithdraw, "📤 " + staffName + " เบิก " + name + " x" + qty + " " + unitLabel + " จากสาขา " + branch +
        (reason ? "\nเหตุผล: " + reason : ""));
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── คืนสต็อกจากสาขากลับคลังกลาง ──────────────────────────────────────────
// data: { branch, name, qty_box, qty_pack }
function handleReturnStock(data) {
  var branch  = String(data.branch   || "").trim();
  var name    = String(data.name     || "").trim();
  var qtyBox  = Number(data.qty_box  || 0);
  var qtyPack = Number(data.qty_pack || 0);

  if (!branch || !name || (qtyBox <= 0 && qtyPack <= 0)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // ลดสต็อกสาขา (Supabase-primary)
    var bsRow = _findStockBranchRow_(_fetchStockBranchRows_(branch), name, branch);
    if (!bsRow) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch }))); }
    if (qtyBox  > 0) bsRow.qty_box  = Math.max(0, (Number(bsRow.qty_box)  || 0) - qtyBox);
    if (qtyPack > 0) bsRow.qty_pack = Math.max(0, (Number(bsRow.qty_pack) || 0) - qtyPack);
    _writeStockBranchRow_(bsRow);

    // เพิ่มสต็อกกลาง (catalog, Supabase-primary)
    var catRow = getSupabaseRow_("catalog", "name", name);
    if (catRow) {
      if (qtyBox  > 0) catRow.qty_box  = (Number(catRow.qty_box)  || 0) + qtyBox;
      if (qtyPack > 0) catRow.qty_pack = (Number(catRow.qty_pack) || 0) + qtyPack;
      writeSupabaseRow_("catalog", catRow, SUPABASE_CATALOG_HEADER, "name");
    }

    // บันทึก log
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var srObj = { timestamp: now, branch: branch, name: name, qty_box: qtyBox, qty_pack: qtyPack };
    var srRes = pushToSupabase_("stock_returns", srObj);
    if (!srRes.ok) throw new Error("Supabase stock_returns write failed: " + srRes.text);
    CacheService.getScriptCache().remove("catalog_config");
    lock.releaseLock();
    mirrorToReportSheet_("stock_returns", SUPABASE_STOCK_RETURNS_HEADER, ["timestamp", "branch", "name"], srObj);

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ขายหน้าร้าน (walk-in): ตัดสต็อกสาขา + บันทึกยอดขาย ────────────────────
// แยกจาก orders โดยตั้งใจ — ไม่มี LINE user, ไม่มีสลิปให้ตรวจ, และไม่ถูกรวม
// เข้ารายงาน/แดชบอร์ดยอดขายออนไลน์
// data: { branch, items: [{name, type, qty, price}], payment_method, bank, code }
function _genWalkinSaleId() {
  var now = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var yy = String(now.getFullYear()).slice(-2);
  var prefix = "WS" + yy + pad(now.getMonth() + 1) + pad(now.getDate());
  var propKey = "walkin_seq_" + prefix;
  var seq = parseInt(PROPS.getProperty(propKey) || "0", 10) + 1;
  PROPS.setProperty(propKey, String(seq));
  return prefix + String(seq).padStart(3, "0");
}

function handleWalkinSale(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var branch = String(data.branch || "").trim();
    var items = Array.isArray(data.items) ? data.items : [];
    if (!branch || items.length === 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ (branch, items)" })));
    }
    if (!_branchAuthorized(data.code, branch)) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }

    var bsRows = _fetchStockBranchRows_(branch);
    // ตรวจสต็อกให้ครบทุกรายการก่อนตัดจริงรายการใดรายการหนึ่ง — กันเคสตัดสต็อก
    // ไปแล้วครึ่งตะกร้าแล้วมาพบว่ารายการหลังสต็อกไม่พอ
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qty = Number(it.qty) || 0;
      if (qty <= 0) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: String(it.name || "") + ": จำนวนต้องมากกว่า 0" })));
      }
      var field = it.type === "box" ? "qty_box" : "qty_pack";
      var bsRow = _findStockBranchRow_(bsRows, it.name, branch);
      var have = bsRow ? (Number(bsRow[field]) || 0) : 0;
      if (have < qty) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: String(it.name || "") + " สต็อกสาขาไม่พอ (เหลือ " + have + ")" })));
      }
    }

    // ตัดสต็อกสาขา + บันทึกยอดขาย (fast REST writes, ยังอยู่ใต้ lock เพราะแข่งกับ
    // การขาย/รับของพร้อมกันได้) แต่ deferred mirror ไปหลังปล่อย lock — เหตุผล
    // เดียวกับ writeSupabaseOrder_/handleReceiveShipment: mirror scan ช้าและ
    // ไม่ควรบล็อก request อื่นที่รอ script-wide lock เดียวกันอยู่
    var pendingMirrors = [];
    var total = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qty = Number(it.qty) || 0;
      var price = Number(it.price) || 0;
      total += price * qty;
      var field = it.type === "box" ? "qty_box" : "qty_pack";
      var bsRow = _findStockBranchRow_(bsRows, it.name, branch);
      bsRow[field] = Math.max(0, (Number(bsRow[field]) || 0) - qty);
      var bsRes = pushToSupabase_("stock_branch", bsRow);
      if (!bsRes.ok) throw new Error("Supabase stock_branch write failed (" + bsRow.name + "): " + bsRes.text);
      pendingMirrors.push({ table: "stock_branch", header: SUPABASE_STOCK_BRANCH_HEADER, keyCol: ["name", "branch"], obj: bsRow });
    }

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var saleId = _genWalkinSaleId();
    var saleObj = {
      sale_id: saleId, timestamp: now, branch: branch,
      items_json: items.map(function(it) { return { name: it.name, type: it.type, qty: Number(it.qty) || 0, price: Number(it.price) || 0 }; }),
      total: total, payment_method: data.payment_method || "cash", bank: data.bank || null,
    };
    var saleRes = pushToSupabase_("walkin_sales", saleObj);
    if (!saleRes.ok) throw new Error("Supabase walkin_sales write failed: " + saleRes.text);
    pendingMirrors.push({ table: "walkin_sales", header: SUPABASE_WALKIN_SALES_HEADER, keyCol: "sale_id", obj: saleObj });

    lock.releaseLock();
    pendingMirrors.forEach(function(m) { mirrorToReportSheet_(m.table, m.header, m.keyCol, m.obj); });

    var staffName = String(data.staff_name || "").trim();
    var groupStaffWalkin = _getConfigValue(null, "group_staff");
    if (groupStaffWalkin && staffName) {
      var payLabel = saleObj.payment_method === "cash" ? "💵 เงินสด" : ("📱 โอน" + (saleObj.bank ? " " + saleObj.bank : ""));
      var walkinItemsText = items.map(function(it) {
        var u = it.type === "box" ? "กล่อง" : "ซอง";
        return "  - " + it.name + " (" + u + ") x" + it.qty;
      }).join("\n");
      _linePush(groupStaffWalkin, "🛒 " + staffName + " ขายหน้าร้านที่สาขา " + branch + " ฿" + total + " (" + payLabel + ")\n\n" + walkinItemsText);
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, sale_id: saleId, total: total })));
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function clearCache() {
  CacheService.getScriptCache().remove("catalog_config");
}

// ── ONE-TIME: เติม notified_at ย้อนหลังให้ออเดอร์เก่าที่ผ่าน "แจ้งพร้อมรับ" ──
// ก่อนหน้านี้ handlePartialReady ไม่เคยบันทึก notified_at (เพิ่งเพิ่มวันนี้) ทั้งที่
// LINE ถูกส่งไปจริงตอนนั้น — ใช้เวลาจาก fulfilled_at (เวลาที่เปลี่ยนเป็น
// "พร้อมรับ"/"บางส่วน" ซึ่งคือตอนที่ _linePush ถูกเรียก) แทนที่ notified_at
// ที่ว่างอยู่ ไม่แตะแถวที่มี notified_at อยู่แล้ว รันซ้ำได้ปลอดภัย
// รันจาก GAS Editor → เลือก backfillPartialReadyNotifiedAt → กด Run → ดู Execution Log
function backfillPartialReadyNotifiedAt() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ws = ss.getSheetByName(TAB_ORDERS);
  var rows = ws.getDataRange().getValues();
  var hdr = rows[0];
  var col = function(name) { return hdr.indexOf(name); };
  var ffCol = col("fulfillment");
  var notifiedCol = col("notified_at");
  var fulfilledAtCol = col("fulfilled_at");
  if (notifiedCol < 0 || fulfilledAtCol < 0) {
    Logger.log("❌ ไม่พบคอลัมน์ notified_at หรือ fulfilled_at ใน orders — เช็ค header ก่อน");
    return;
  }
  var updated = 0;
  for (var i = 1; i < rows.length; i++) {
    var ff = String(rows[i][ffCol] || "");
    if (ff !== "พร้อมรับ" && ff !== "บางส่วน") continue;
    if (rows[i][notifiedCol]) continue;
    var fulfilledAt = rows[i][fulfilledAtCol];
    if (!fulfilledAt) continue;
    ws.getRange(i + 1, notifiedCol + 1).setValue(fulfilledAt);
    var updatedRow = rows[i].slice();
    updatedRow[notifiedCol] = fulfilledAt;
    pushOrderToSupabase_(updatedRow);
    updated++;
    Logger.log("✅ " + rows[i][col("order_id")] + " (" + ff + ") → notified_at = " + fulfilledAt);
  }
  Logger.log("── เสร็จสิ้น: เติม notified_at ย้อนหลัง " + updated + " ออเดอร์ ──");
}

// ── TEST: ทดสอบ partial fulfillment flow โดยไม่กระทบออเดอร์จริง ─────────────
// รันจาก GAS Editor → เลือก testPartialFlow → กด Run
// ดู log ใน Execution Log
function testPartialFlow() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ws = ss.getSheetByName(TAB_ORDERS);
  var hdr = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
  var col = function(name) { return hdr.indexOf(name); };

  var testId = "TEST_" + new Date().getTime();
  var testItems = [
    { name: "TEST-ITEM-A", type: "box", qty: 1, price: 100 },
    { name: "TEST-ITEM-B", type: "box", qty: 2, price: 200 },
  ];
  // เพิ่ม test row — ใช้ line_user_id "dev_user" เพื่อกัน LINE push จริง
  var newRow = new Array(hdr.length).fill("");
  newRow[col("order_id")]    = testId;
  newRow[col("timestamp")]   = "2099-01-01T00:00:00+07:00";
  newRow[col("line_user_id")]= "dev_user";
  newRow[col("display_name")]= "TEST";
  newRow[col("items_json")]  = JSON.stringify(testItems);
  newRow[col("total")]       = 300;
  newRow[col("branch")]      = "ต้นสักคอร์เนอร์";
  newRow[col("slip_status")] = "ยืนยัน";
  newRow[col("fulfillment")] = "";
  ws.appendRow(newRow);
  Logger.log("✅ สร้าง test order: " + testId);

  // 1. แจ้งพร้อมรับ item[0] เท่านั้น
  var r1 = handlePartialReady({ order_id: testId, indices: [0], code: ADMIN_CODE });
  var d1 = JSON.parse(r1.getContent());
  Logger.log("partialReady(indices=[0]): " + JSON.stringify(d1));
  if (d1.ok && d1.fulfillment === "บางส่วน") {
    Logger.log("✅ PASS: fulfillment = บางส่วน");
  } else {
    Logger.log("❌ FAIL: expected บางส่วน, got " + d1.fulfillment);
  }

  // 2. ตรวจ items_json — item[0] ต้องมี ready_at, item[1] ต้องไม่มี
  var rows = ws.getDataRange().getValues();
  var testRow = null;
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][col("order_id")]) === testId) { testRow = rows[i]; break; }
  }
  if (testRow) {
    var items = JSON.parse(testRow[col("items_json")]);
    Logger.log("items[0].ready_at = " + items[0].ready_at);
    Logger.log("items[1].ready_at = " + items[1].ready_at);
    if (items[0].ready_at && !items[1].ready_at) Logger.log("✅ PASS: ready_at ถูกต้อง");
    else Logger.log("❌ FAIL: ready_at ไม่ถูกต้อง");
  }

  // 2b. เรียกซ้ำ indices=[0] อีกครั้ง — ไม่ควรแจ้งซ้ำ ต้องได้ error กลับมาแทน
  var r1b = handlePartialReady({ order_id: testId, indices: [0], code: ADMIN_CODE });
  var d1b = JSON.parse(r1b.getContent());
  Logger.log("partialReady(indices=[0]) ซ้ำ: " + JSON.stringify(d1b));
  if (!d1b.ok && d1b.error) Logger.log("✅ PASS: กันแจ้งซ้ำ — ไม่ส่ง LINE ซ้ำ");
  else Logger.log("❌ FAIL: เรียกซ้ำแล้วควรได้ error แต่ได้ " + JSON.stringify(d1b));

  // 3. ส่งมอบ (handover) — ควรหักเฉพาะ item[0]
  var r2 = handleHandoverOrder({ order_id: testId, code: ADMIN_CODE });
  var d2 = JSON.parse(r2.getContent());
  Logger.log("handoverOrder: " + JSON.stringify(d2));
  if (d2.ok && d2.fulfillment === "รับบางส่วนแล้ว") {
    Logger.log("✅ PASS: fulfillment = รับบางส่วนแล้ว");
  } else {
    Logger.log("❌ FAIL: expected รับบางส่วนแล้ว, got " + d2.fulfillment);
  }

  // 4. ตรวจ items_json — item[0] ต้องมี handed_at, item[1] ยังไม่มี
  rows = ws.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][col("order_id")]) === testId) { testRow = rows[i]; break; }
  }
  if (testRow) {
    var items2 = JSON.parse(testRow[col("items_json")]);
    Logger.log("items[0].handed_at = " + items2[0].handed_at);
    Logger.log("items[1].handed_at = " + items2[1].handed_at);
    if (items2[0].handed_at && !items2[1].handed_at) Logger.log("✅ PASS: handed_at ถูกต้อง");
    else Logger.log("❌ FAIL: handed_at ไม่ถูกต้อง");
  }

  // 5. ยกเลิก item[1] ที่เหลือ
  var r3 = handlePartialCancelItems({ order_id: testId, indices: [1], reason: "test", code: ADMIN_CODE });
  var d3 = JSON.parse(r3.getContent());
  Logger.log("partialCancelItems(indices=[1]): " + JSON.stringify(d3));
  if (d3.ok && d3.cancelled === 1) Logger.log("✅ PASS: ยกเลิก 1 item");
  else Logger.log("❌ FAIL: " + JSON.stringify(d3));

  // ลบ test row
  rows = ws.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][col("order_id")]) === testId) {
      ws.deleteRow(i + 1);
      Logger.log("🧹 ลบ test row แล้ว");
      break;
    }
  }

  Logger.log("── Test เสร็จสิ้น ──");
}

// ────────────────────────────────────────────────────────────────
// testWakagymFlow — รัน full WAKA GYM flow โดยไม่ต้องเปิด browser
// เลือก testWakagymFlow แล้วกด Run ดู log ใน Execution Log
// ⚠️  จะส่ง LINE ไป group_staff จริง (1 ข้อความต่อผู้เล่น)
// ────────────────────────────────────────────────────────────────
function testWakagymFlow() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
  var testTag = "TEST_WG_" + new Date().getTime();

  // ── 1. สร้าง event วันนี้ tier S ──────────────────────────────
  var evWs = _ensureTab(ss, TAB_WAKAGYM_EVENTS,
    ["event_id","date","branch","tier","entry_fee","status","created_by"]);
  var testEventId = testTag + "_EV";
  evWs.appendRow([testEventId, today, "WAKA GYM", "S", 200, "open", "test"]);
  Logger.log("✅ สร้าง event: " + testEventId);

  // ── 2. ลงทะเบียน 2 คน (cash, dev_user — ไม่ push LINE ลูกค้า) ──
  var r1 = handleWakagymRegister({
    lineUserId: "dev_user", displayName: "TestUser1",
    players: [{ playerName: testTag + "_P1", realName: testTag + "_P1" }],
    paymentMethod: "cash", phone: "0800000001"
  });
  var d1 = JSON.parse(r1.getContent());
  Logger.log("register P1: " + JSON.stringify(d1));
  if (!d1.success) { Logger.log("❌ FAIL register P1"); _testWgCleanup(ss, testTag, testEventId); return; }
  var regId1 = d1.results[0].regId;
  Logger.log("✅ reg P1: " + regId1);

  var r2 = handleWakagymRegister({
    lineUserId: "dev_user", displayName: "TestUser2",
    players: [{ playerName: testTag + "_P2", realName: testTag + "_P2" }],
    paymentMethod: "cash", phone: "0800000002"
  });
  var d2 = JSON.parse(r2.getContent());
  Logger.log("register P2: " + JSON.stringify(d2));
  if (!d2.success) { Logger.log("❌ FAIL register P2"); _testWgCleanup(ss, testTag, testEventId); return; }
  var regId2 = d2.results[0].regId;
  Logger.log("✅ reg P2: " + regId2);

  // ── 3. Submit results (inline logic เหมือน wakagym_submit_results) ──
  var regWs = ss.getSheetByName(TAB_WAKAGYM_REG);
  var statsWs = ss.getSheetByName(TAB_PLAYER_STATS);
  var regRows = regWs.getDataRange().getValues();
  var regHdr = regRows[0];
  var rc = function(n) { return regHdr.indexOf(n); };
  var stRows = statsWs.getDataRange().getValues();
  var stHdr = stRows[0];
  var stc = function(n) { return stHdr.indexOf(n); };

  var srResults = [
    { reg_id: regId1, placement: "1st",  wins_3match: 3 },
    { reg_id: regId2, placement: "2nd",  wins_3match: 2 }
  ];
  var tier = "S";
  var expectedTokens = {};
  for (var ri = 0; ri < srResults.length; ri++) {
    var sr = srResults[ri];
    var wins = Math.min(Math.max(parseInt(sr.wins_3match) || 0, 0), 3);
    var tokens = (TOKEN_TABLE[tier] && TOKEN_TABLE[tier][sr.placement]) || 0;
    var promos = PROMO_TABLE[wins] || 1;
    expectedTokens[sr.reg_id] = tokens;
    for (var rj = 1; rj < regRows.length; rj++) {
      if (String(regRows[rj][rc("reg_id")]) !== sr.reg_id) continue;
      var pName = String(regRows[rj][rc("player_name")] || "").trim();
      if (rc("placement") >= 0)     regWs.getRange(rj+1, rc("placement")+1).setValue(sr.placement);
      if (rc("wins_3match") >= 0)   regWs.getRange(rj+1, rc("wins_3match")+1).setValue(wins);
      if (rc("tokens_earned") >= 0) regWs.getRange(rj+1, rc("tokens_earned")+1).setValue(tokens);
      if (rc("promo_packs") >= 0)   regWs.getRange(rj+1, rc("promo_packs")+1).setValue(promos);
      for (var si = 1; si < stRows.length; si++) {
        if (String(stRows[si][stc("player_name")]).trim() !== pName) continue;
        var curTok = (Number(stRows[si][stc("total_tokens")]) || 0) + tokens;
        statsWs.getRange(si+1, stc("total_tokens")+1).setValue(curTok);
        stRows[si][stc("total_tokens")] = curTok;
        break;
      }
      Logger.log("✅ บันทึกผล " + pName + ": " + sr.placement + " → 🪙" + tokens + " 📦" + promos);
      break;
    }
  }

  // ── 4. Give rewards ──────────────────────────────────────────
  var rewardRegIds = [regId1, regId2];
  regRows = regWs.getDataRange().getValues(); // reload after writes
  regHdr = regRows[0];
  rc = function(n) { return regHdr.indexOf(n); };
  for (var gi = 1; gi < regRows.length; gi++) {
    var rid = String(regRows[gi][rc("reg_id")]);
    if (rewardRegIds.indexOf(rid) < 0) continue;
    if (String(regRows[gi][rc("rewards_given")]).toLowerCase() === "true") continue;
    var givenAt = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
    regWs.getRange(gi+1, rc("rewards_given")+1).setValue("TRUE");
    if (rc("note") >= 0) regWs.getRange(gi+1, rc("note")+1).setValue("TEST แจก " + givenAt);
    Logger.log("✅ give rewards: " + String(regRows[gi][rc("player_name")]));
  }

  // ── 5. Verify player_stats ───────────────────────────────────
  stRows = statsWs.getDataRange().getValues();
  stHdr = stRows[0];
  stc = function(n) { return stHdr.indexOf(n); };
  regRows = regWs.getDataRange().getValues();
  regHdr = regRows[0];
  rc = function(n) { return regHdr.indexOf(n); };
  var allPass = true;
  for (var vi = 1; vi < regRows.length; vi++) {
    var vRid = String(regRows[vi][rc("reg_id")]);
    if (rewardRegIds.indexOf(vRid) < 0) continue;
    var vName = String(regRows[vi][rc("player_name")] || "").trim();
    var vExpected = expectedTokens[vRid] || 0;
    var vRewards = String(regRows[vi][rc("rewards_given")] || "");
    for (var vsi = 1; vsi < stRows.length; vsi++) {
      if (String(stRows[vsi][stc("player_name")]).trim() !== vName) continue;
      var vActual = Number(stRows[vsi][stc("total_tokens")]) || 0;
      if (vActual === vExpected && vRewards.toLowerCase() === "true") {
        Logger.log("✅ PASS " + vName + ": tokens=" + vActual + " rewards_given=" + vRewards);
      } else {
        Logger.log("❌ FAIL " + vName + ": tokens=" + vActual + " (expected " + vExpected + ") rewards=" + vRewards);
        allPass = false;
      }
      break;
    }
  }
  Logger.log(allPass ? "✅ ทุก assertion ผ่าน" : "❌ มี assertion ที่ fail");

  // ── 6. Cleanup ────────────────────────────────────────────────
  _testWgCleanup(ss, testTag, testEventId);
  Logger.log("── testWakagymFlow เสร็จสิ้น ──");
}

function _testWgCleanup(ss, testTag, testEventId) {
  // ลบจาก wakagym_events
  var evWs = ss.getSheetByName(TAB_WAKAGYM_EVENTS);
  if (evWs) {
    var evRows = evWs.getDataRange().getValues();
    for (var i = evRows.length - 1; i >= 1; i--) {
      if (String(evRows[i][0]) === testEventId) { evWs.deleteRow(i+1); break; }
    }
  }
  // ลบจาก wakagym_reg
  var regWs = ss.getSheetByName(TAB_WAKAGYM_REG);
  if (regWs) {
    var regRows = regWs.getDataRange().getValues();
    for (var i = regRows.length - 1; i >= 1; i--) {
      if (String(regRows[i][regRows[0].indexOf("player_name")]).indexOf(testTag) === 0 ||
          String(regRows[i][regRows[0].indexOf("real_name")]).indexOf(testTag) === 0) {
        regWs.deleteRow(i+1);
      }
    }
  }
  // ลบจาก player_stats
  var stWs = ss.getSheetByName(TAB_PLAYER_STATS);
  if (stWs) {
    var stRows = stWs.getDataRange().getValues();
    for (var i = stRows.length - 1; i >= 1; i--) {
      if (String(stRows[i][0]).indexOf(testTag) === 0) { stWs.deleteRow(i+1); }
    }
  }
  Logger.log("🧹 ลบ test data แล้ว (" + testTag + ")");
}

