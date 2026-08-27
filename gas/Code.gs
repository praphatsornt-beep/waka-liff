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
const SCRIPT_SECRET = PROPS.getProperty("SCRIPT_SECRET") || "";
// แยก OA ต่างหาก (WAKA NOTI BOT) เฉพาะแจ้งเตือน staff แบบสดๆ 6 จุดที่ปริมาณสูง
// (รับลอต/เบิกสาขา/แกะกล่อง/ขายหน้าร้าน/ยกเลิกขายหน้าร้าน/ส่งมอบลูกค้า) — แยก
// โควต้า 300/เดือนออกจาก OA หลักที่ลูกค้าใช้ กันไม่ให้ยอดสั่งซื้อ/ยืนยันสลิปของ
// ลูกค้าโดนบล็อกเพราะพนักงานใช้โควต้าหมด
const STAFF_LIVE_LINE_TOKEN = PROPS.getProperty("STAFF_LIVE_LINE_TOKEN") || "";
// ── Telegram — แยกออกจาก LINE ทั้งหมดเพราะ Telegram Bot API ไม่มีโควต้า
// ข้อความ/เดือนแบบ LINE OA (ส่งได้ไม่จำกัดฟรี) ใช้กลุ่ม/แชทเดียวกันสำหรับ
// 2 เรื่อง: (1) แจ้งไฟแนนซ์ล้วนๆ (แทน finance_line_id เดิม ไม่ผ่าน LINE เลย)
// (2) เป็น mirror ให้แจ้งเตือนกลุ่ม staff (STAFF_LIVE_LINE_TOKEN) ที่ยังส่งผ่าน
// LINE เป็นหลักอยู่ — กันเคส LINE OA ตัวนั้นชนโควต้า 300/เดือนแล้วข้อความเงียบ
// หายไปโดยไม่มีใครรู้ตัว (ดู _notifyStaffGroup_)
const TELEGRAM_BOT_TOKEN     = PROPS.getProperty("TELEGRAM_BOT_TOKEN") || "";
const TELEGRAM_FINANCE_CHAT_ID = PROPS.getProperty("TELEGRAM_FINANCE_CHAT_ID") || "";

// Branch login codes (mirrors BRANCH_CODES/PIN_ADMIN in liff/app.html) — kept
// here too so branch-scoped read/write actions can verify the caller actually
// knows the code for the branch they're requesting, not just the branch name
// (the `branch` query/body param alone is not proof of identity — anyone who
// can reach the API can set it to any value).
//
// Read from Script Properties, not hardcoded — the previous hardcoded values
// (here AND duplicated in liff/app.html + tools/screens/*.py) were exposed by
// this being a public GitHub repo (2026-08-09 audit finding C-1). Fails
// closed (empty map / empty string) if the properties aren't set yet, rather
// than falling back to the old compromised values.
const BRANCH_CODES = (function() {
  try { return JSON.parse(PROPS.getProperty("BRANCH_CODES") || "{}"); }
  catch (e) { return {}; }
})();
const ADMIN_CODE = PROPS.getProperty("ADMIN_CODE") || "";

// Thai strings that visually match can still fail === if one side picked up
// stray formatting during copy/paste (e.g. through the Apps Script editor).
// normalize() + trim() on both sides makes the compare resilient to that.
function _norm(s) { return String(s || "").trim().normalize("NFC"); }

// branch === "" means "no specific branch requested" (e.g. warehouse.html's
// all-branches overview) — left unrestricted, matching existing behavior.
function _branchAuthorized(code, branch) {
  if (!branch) return true;
  code = String(code || "").trim();
  // Script Properties values can pick up trailing whitespace when typed/pasted
  // into the Apps Script editor's Properties UI — a strict === against the raw
  // property here would silently fail auth forever with no visible cause, same
  // class of bug _norm()'s docstring above already calls out for branch names.
  if (code === String(ADMIN_CODE || "").trim()) return true;
  return _norm(BRANCH_CODES[code]) === _norm(branch);
}

const SUPABASE_URL         = PROPS.getProperty("SUPABASE_URL") || "";
const SUPABASE_SERVICE_KEY = PROPS.getProperty("SUPABASE_SERVICE_KEY") || "";

// ── Supabase writes — Supabase is the sole store of record for every table
// in this file. No Google Sheet is read from or written to anywhere below.
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

// บันทึกทุกการกระทำที่มีผลต่อข้อมูลจริงลง staff_actions เพื่อตรวจสอบย้อนหลัง
// ได้ว่าใครทำอะไร เมื่อไหร่ — best-effort เหมือน pushToSupabase_ ทั่วไป (fail
// เงียบๆ แค่ log) เพราะการบันทึก audit log ต้องไม่มีทางไปบล็อกการกระทำจริงที่
// มันกำลังบันทึกอยู่ ไม่มีชื่อพนักงาน = ข้าม ไม่บันทึกอะไรเลย (กันแถวที่ตรวจ
// สอบย้อนหลังไม่ได้อยู่ดีปนอยู่ในตาราง)
function _logStaffAction_(staffName, branch, action, targetId, detail) {
  var name = String(staffName || "").trim();
  if (!name) return;
  pushToSupabase_("staff_actions", {
    staff_name: name,
    branch: branch || null,
    action: action,
    target_id: targetId || null,
    detail: detail || null,
  });
}

// ── orders: Supabase is the sole store of record ────────────────────────

// Reads the current full order row from Supabase. items_json comes back
// already parsed (a real array, not a JSON string) since it's a native
// jsonb column — callers should NOT JSON.parse() it again.
function getSupabaseOrder_(orderId) {
  var rows = supabaseSelect_("orders", "select=*&order_id=eq." + encodeURIComponent(orderId) + "&limit=1");
  return rows[0] || null;
}

// Upserts the full order object as the authoritative record. Throws on
// failure — there's no Sheet write to fall back on, so a failed write here
// must fail the caller's action too.
//
// Optional `lock`: releases the caller's script-wide lock (shared by EVERY
// concurrent GAS execution) as soon as the authoritative write succeeds,
// since nothing after that point (LINE notifications etc.) needs it held —
// passed in by the caller as the last thing it does under lock.
function writeSupabaseOrder_(obj, lock) {
  var res = pushToSupabase_("orders", obj);
  if (!res.ok) throw new Error("Supabase orders write failed: " + res.text);
  if (lock) { try { lock.releaseLock(); } catch (_) {} }
  return obj;
}

// Generic versions of the two helpers above, for every other
// Supabase-primary table (tournament_events, tournament_categories,
// catalog, stock_branch, etc.).
function getSupabaseRow_(table, keyCol, keyValue) {
  var rows = supabaseSelect_(table, "select=*&" + keyCol + "=eq." + encodeURIComponent(keyValue) + "&limit=1");
  return rows[0] || null;
}
// Optional `lock` — see writeSupabaseOrder_'s comment above, same reasoning.
function writeSupabaseRow_(table, obj, header, keyCol, lock) {
  var res = pushToSupabase_(table, obj);
  if (!res.ok) throw new Error("Supabase " + table + " write failed: " + res.text);
  if (lock) { try { lock.releaseLock(); } catch (_) {} }
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

// DELETE-by-filter, same filter shape as patchSupabase_ (e.g. "id=eq.123").
function deleteSupabase_(table, filterQuery) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, code: 0, text: "SUPABASE_URL/SUPABASE_SERVICE_KEY not set" };
  try {
    var res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/" + table + "?" + filterQuery, {
      method: "delete",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
        Prefer: "return=minimal",
      },
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      var text = res.getContentText();
      Logger.log("deleteSupabase_(" + table + ") HTTP " + code + ": " + text);
      return { ok: false, code: code, text: text };
    }
    return { ok: true, code: code, text: "" };
  } catch (e) {
    Logger.log("deleteSupabase_(" + table + ") failed: " + e.message);
    return { ok: false, code: -1, text: e.message };
  }
}

// Renames a product atomically — updates catalog.name and every matching
// stock_branch.name in one Postgres transaction via the rename_product() SQL
// function (see supabase/schema.sql), so a rename can never leave branch
// stock stranded under the old name.
function _renameProductRpc_(oldName, newName) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return { ok: false, text: "SUPABASE_URL/SUPABASE_SERVICE_KEY not set" };
  try {
    var res = UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/rpc/rename_product", {
      method: "post",
      contentType: "application/json",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      },
      payload: JSON.stringify({ old_name: oldName, new_name: newName }),
      muteHttpExceptions: true,
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      var text = res.getContentText();
      Logger.log("_renameProductRpc_ HTTP " + code + ": " + text);
      return { ok: false, text: text };
    }
    return { ok: true, text: "" };
  } catch (e) {
    Logger.log("_renameProductRpc_ failed: " + e.message);
    return { ok: false, text: e.message };
  }
}

// ครอบคลุมทุกแถวของตารางที่มี items_json (ไม่กรอง status/เวลา) เพราะ
// action=report / walkin_product_report join ต้นทุนจาก catalog ด้วยชื่อ
// ย้อนหลังได้ไม่จำกัดเวลา, และ handleReceiveShipment อ่านชื่อจาก
// shipments.items_json ตรงๆ ตอนสาขากดรับของ — ถ้าไม่ sync ทุกแถว (ไม่ใช่แค่
// ล็อตที่ยังไม่รับ) ทั้งรายงานย้อนหลังและล็อตที่รับไปแล้วก่อนหน้านี้จะโชว์/จับคู่
// ด้วยชื่อเก่าเงียบๆ (บั๊กจริงที่เจอกับ BT11 หลัง rename [Preorder] → [พร้อมส่ง],
// แก้ครั้งแรกด้วย tools/backfill_renamed_product_names.py ก่อนจะมาป้องกันไว้ตรงนี้)
function _renameHistoricalItemsJson_(table, idCol, oldName, newName) {
  var rows = supabaseSelect_(table, "select=" + idCol + ",items_json");
  rows.forEach(function(r) {
    var items = Array.isArray(r.items_json) ? r.items_json : [];
    var changed = false;
    items.forEach(function(it) {
      if (it.name === oldName) { it.name = newName; changed = true; }
    });
    if (!changed) return;
    var idVal = r[idCol];
    var res = patchSupabase_(table, idCol + "=eq." + encodeURIComponent(idVal), { items_json: items });
    if (!res.ok) Logger.log("_renameHistoricalItemsJson_ failed for " + table + "." + idCol + "=" + idVal + ": " + res.text);
  });
}

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

// UrlFetchApp.fetchAll() ยิงหลาย request จริงพร้อมกัน (ไม่ใช่ทีละตัวแบบเรียก
// supabaseSelect_() วนลูป) — ใช้เฉพาะจุดที่ต้อง query Supabase มากกว่า 1 ครั้ง
// ในการเรียกเดียวกัน อย่าง action=dashboard ที่โหลดทุกครั้งที่เปิด app.html
function supabaseSelectBatch_(specs) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return specs.map(function() { return []; });
  var requests = specs.map(function(s) {
    return {
      url: SUPABASE_URL + "/rest/v1/" + s.table + (s.query ? "?" + s.query : ""),
      method: "get",
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: "Bearer " + SUPABASE_SERVICE_KEY,
      },
      muteHttpExceptions: true,
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  return responses.map(function(res, i) {
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      throw new Error("supabaseSelectBatch_(" + specs[i].table + ") HTTP " + code + ": " + res.getContentText());
    }
    return JSON.parse(res.getContentText());
  });
}

// ── _config: Supabase-primary ────────────────────────────────────────────
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
  if (Object.keys(map).length > 0) cache.put("config_map", JSON.stringify(map), 120);
  return map;
}

function setConfig_(key, value) {
  var pushResult = pushToSupabase_("config", { key: key, value: value });
  CacheService.getScriptCache().remove("config_map");
  return pushResult;
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
var SUPABASE_CATALOG_HEADER = [
  "name", "category", "slug", "cost_box", "cost_p", "price_box", "price_pack",
  "qty_box", "qty_pack", "limit_box", "limit_pack", "active", "image_url", "barcode", "notice",
  "id", "packs_per_box", "status",
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
// No "id" here — it's a DB-generated surrogate (shipment_id isn't reliably
// unique historically, see supabase/schema.sql), not a meaningful key.
var SUPABASE_SHIPMENTS_HEADER = ["shipment_id", "timestamp", "to_branch", "status", "items_json", "received_at"];
var SUPABASE_WITHDRAWALS_HEADER = ["timestamp", "branch", "name", "type", "qty", "reason"];
var SUPABASE_STOCK_RETURNS_HEADER = ["timestamp", "branch", "name", "qty_box", "qty_pack"];
var SUPABASE_WALKIN_SALES_HEADER = ["sale_id", "timestamp", "branch", "items_json", "total", "payment_method", "bank", "staff_name"];
// No "id" here — surrogate key (bigserial), same reasoning as shipments.
var SUPABASE_PURCHASES_HEADER = ["purchase_id", "timestamp", "supplier", "doc_no", "items_json", "total_cost", "amount_paid", "status", "received_at", "staff_name", "notes"];

const BRANCHES = ["ต้นสักคอร์เนอร์", "เมืองทองธานี", "ศรีนครินทร์"];

function _cors(output) {
  return output.setMimeType(ContentService.MimeType.JSON);
}

// GET: โหลด catalog หรือลูกค้าดูสถานะออเดอร์ (ไม่มีปุ่มกดยืนยันรับของแล้ว —
// พนักงานกดส่งมอบก็ปิด order ทันที ดู confirm.html)
// Public (ไม่ต้อง _s): catalog, confirm, order_status
// Staff only (ต้อง _s): ทุกอย่างอื่น
var PUBLIC_API_DOS = ["order_status",
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
    if (action === "api") {
      // verify_code รับรหัส PIN/สาขา — บังคับ POST เท่านั้น กัน PIN หลุดไปอยู่
      // ใน query string (server access log, browser history) ถ้ามีคนยิงผ่าน GET
      if (doParam === "verify_code") {
        return _cors(ContentService.createTextOutput(JSON.stringify({ ok: false, error: "POST only" })));
      }
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
        id:         String(cr.id || ""),
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
// Public POST (ไม่ต้อง _s): LINE webhook, สั่งซื้อ (data.items), tournamentRegister,
// checkPickupReady (precheck อ่านอย่างเดียว ไม่มีข้อมูลอ่อนไหว)
var PUBLIC_ACTIONS_POST = ["tournamentRegister", "checkPickupReady"];

function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    var isPublicPost = Array.isArray(data.events) ||
                       (data.items && !data._action) ||
                       (data._action && PUBLIC_ACTIONS_POST.indexOf(data._action) >= 0);

    if (!isPublicPost && SCRIPT_SECRET && (e.parameter._s || "") !== SCRIPT_SECRET) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }

    if (data._action === "checkPickupReady") {
      return handleCheckPickupReady(data);
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

    if (data._action === "recordPurchase") {
      return handleRecordPurchase(data);
    }

    if (data._action === "receivePurchase") {
      return handleReceivePurchase(data);
    }

    if (data._action === "recordPurchasePayment") {
      return handleRecordPurchasePayment(data);
    }

    if (data._action === "addProduct") {
      return handleAddProduct(data);
    }

    if (data._action === "updateProduct") {
      return handleUpdateProduct(data);
    }

    if (data._action === "deleteProduct") {
      return handleDeleteProduct(data);
    }

    if (data._action === "convertBoxToPack") {
      return handleConvertBoxToPack(data);
    }

    if (data._action === "withdrawStock") {
      return handleWithdrawStock(data);
    }

    if (data._action === "adjustBranchStock") {
      return handleAdjustBranchStock(data);
    }

    if (data._action === "withdrawCentralStock") {
      return handleWithdrawCentralStock(data);
    }

    if (data._action === "returnStock") {
      return handleReturnStock(data);
    }

    if (data._action === "walkinSale") {
      return handleWalkinSale(data);
    }

    if (data._action === "cancelWalkinSale") {
      return handleCancelWalkinSale(data);
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
        // เหมือน !waka-setup แต่สำหรับ OA ตัวที่สอง (WAKA NOTI BOT) — เว็บฮุคของ
        // channel ใหม่ต้องชี้มาที่ URL นี้ด้วยเช่นกัน ตอบกลับด้วย
        // STAFF_LIVE_LINE_TOKEN เพราะ group นี้มีแค่บอทตัวใหม่เป็นสมาชิก
        if (src.type === "group" && src.groupId && msgText.trim() === "!waka-noti-setup") {
          setConfig_("group_staff_live", src.groupId);
          _linePush(src.groupId, "ตั้งค่ากลุ่ม staff (WAKA NOTI BOT) สำเร็จ!\nGroup ID: " + src.groupId, STAFF_LIVE_LINE_TOKEN);
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

    // สลิป (ถ้ามี) ตรวจทีหลังแบบ async ผ่าน processPendingSlipVerifications()
    // (time-driven trigger, ไม่ใช่ inline ใน doPost นี้อีกต่อไป — ดูเหตุผลเต็มที่
    // คอมเมนต์เหนือ writeSupabaseOrder_(newOrder) ตัวแรกด้านล่าง) ที่นี่แค่ตั้งสถานะ
    // ชั่วคราวไว้ก่อน
    var hasSlip    = !!data.slipBase64;
    var slipStatus = hasSlip ? "รอตรวจ" : "ไม่มีสลิป";
    var slipNote   = hasSlip ? "กำลังตรวจสอบสลิป..." : "ลูกค้าไม่ได้แนบสลิป";
    var slipUrl    = "";
    var slipAmount = "";
    var slipTxnId  = "";
    var slipDate   = "";

    // ── Lock เฉพาะช่วงวิกฤต: ตรวจ + หักสต็อก + บันทึกออเดอร์ ──
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(10000)) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: "ระบบยุ่งอยู่ กรุณาลองใหม่สักครู่" })));
    }
    var orderId = _genOrderId();

    // ── ตรวจ limit + หักสต็อก — อ่าน catalog จาก Supabase ครั้งเดียว ส่งต่อทั้ง 3 ฟังก์ชัน ──
    var catRowsForOrder = null;
    // branchCoverage: ระดับ "ทั้งออเดอร์" (true เฉพาะเมื่อไม่มี item พรีออเดอร์ปน
    // อยู่เลย และ item ที่เหลือทั้งหมดสาขามีของพอ) — ใช้ตัดสิน "พร้อมรับทันที"
    // (_tryInstantReady_) และแจ้งเตือนคลังกลาง (_notifyBranchRestockNeeded_)
    var branchCoverage = { covered: false };
    var readyItemsForOrder = [];
    // readyCovered: เฉพาะ item สถานะ "พร้อมส่ง" (ไม่รวมพรีออเดอร์) — ใช้ตัดสินว่า
    // จะหักสต็อกจากสาขาหรือคลังกลางสำหรับ item กลุ่มนี้
    var readyCovered = false;
    if (data.items && data.items.length > 0) {
      catRowsForOrder = _fetchCatalogRows_();
      // ปิดช่องโหว่ลูกค้าค้างหน้าตะกร้าไว้ข้ามช่วงที่มีคน rename สินค้า — เขียน
      // item.name ให้ตรงกับชื่อปัจจุบันเสมอถ้า item มี id ที่ resolve เจอ ก่อนตรวจ
      // limit/หักสต็อกด้านล่างซึ่งยัง match ด้วยชื่อเหมือนเดิมทั้งหมด
      _resolveItemsAgainstCatalog_(data.items, catRowsForOrder);

      // แยก item ตาม catalog.status (พนักงานตั้งเองที่หน้า "สินค้า") ก่อนเช็ค/หัก
      // อะไรทั้งหมด — พรีออเดอร์ต้องไม่แตะสต็อกกลาง/สาขาเลยไม่ว่ากรณีใด แม้ว่าตอน
      // นี้จะมีสต็อกอยู่แล้วก็ตาม (พนักงานยังไม่ได้ประกาศว่า "พร้อมส่ง")
      for (var si = 0; si < data.items.length; si++) {
        var sIt = data.items[si];
        var sRow = _findCatalogRow_(catRowsForOrder, sIt.name);
        sIt._preorder = !!(sRow && sRow.status === "preorder");
        if (!sIt._preorder) readyItemsForOrder.push(sIt);
      }
      var allItemsReady = readyItemsForOrder.length === data.items.length;

      // ดึงสต็อกสาขาครั้งเดียว (หัก reservation จากออเดอร์อื่นที่สาขานี้แล้ว) แล้ว
      // เช็คความครอบคลุมได้ทั้ง 2 ระดับจากข้อมูลชุดเดียว กันยิง Supabase ซ้ำสองรอบ
      var branchStockLookup = _branchStockLookup_(data.branch);
      readyCovered = _itemsCoveredByLookup_(branchStockLookup, readyItemsForOrder);
      branchCoverage = { covered: allItemsReady && readyCovered };

      var limitCheck = checkCatalogLimits(data.items, catRowsForOrder, readyCovered);
      if (limitCheck.error) {
        try { lock.releaseLock(); } catch(_) {}
        return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: limitCheck.error })));
      }
      // ทำเครื่องหมาย branch-sourced — เฉพาะ item "พร้อมส่ง" ที่หักจากสาขาจริงเท่านั้น
      // ใช้ตอน cancel เพื่อคืนไปที่ stock_branch แทน catalog (ดู restoreStock)
      if (readyCovered) {
        readyItemsForOrder.forEach(function(it) { it._branch_source = true; });
      }
    }

    // Supabase is the store of record for orders (Phase 2) — writing here is
    // what makes the order succeed or fail; a throw propagates to doPost's
    // top-level catch, which releases the lock and reports the error.
    //
    // เขียนออเดอร์ด้วยสถานะสลิปชั่วคราว ("รอตรวจ"/"ไม่มีสลิป") ก่อน แล้วค่อยตรวจ
    // สลิปจริง (ช้า — เรียก SlipOK แล้ว fallback Claude vision ได้) ทีหลังแบบ async —
    // เดิมตรวจสลิปก่อนเขียนออเดอร์เลย ถ้า fetch ฝั่งลูกค้า timeout ระหว่างรอผลตรวจ
    // (มือถือ/เน็ตอ่อน) ลูกค้าจะไม่รู้ว่าออเดอร์เข้าระบบหรือยัง เห็นแต่ error
    // เครือข่าย แล้วมักกดสั่งใหม่แนบสลิปเดิมซ้ำ กลายเป็นเคส "สลิปซ้ำ" — สลับลำดับ
    // ให้ออเดอร์ (พร้อมหักสต็อก/limit แล้ว) ปลอดภัยอยู่ใน Supabase ก่อนเข้าสู่ช่วง
    // ที่ช้า ไม่ว่าการตรวจสลิปจะช้าแค่ไหนก็ตาม — และตอนนี้ doPost ตอบกลับลูกค้า
    // ทันทีหลัง write นี้เลย (ไม่รอผลตรวจสลิปอีกต่อไป) ตรวจสลิปจริงย้ายไปทำใน
    // processPendingSlipVerifications() (time-driven trigger) แทน กันกรณีลูกค้า
    // เน็ตหลุด/สลับแอประหว่างรอผลตรวจ (ยิ่งตรวจช้ายิ่งเสี่ยง) แล้วพลาดเห็นหน้า
    // "สั่งซื้อสำเร็จ" ทั้งที่ออเดอร์บันทึกจริงแล้ว
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
      // limit_box/pack หักทุก item เสมอ รวมพรีออเดอร์ด้วย (limit คือเพดานขายผ่าน
      // ลิงค์ ไม่เกี่ยวกับสต็อกจริง) — ส่วนสต็อกจริง (คลังกลาง/สาขา) หักเฉพาะ item
      // สถานะ "พร้อมส่ง" (readyItemsForOrder) เท่านั้น พรีออเดอร์ไม่แตะสต็อกเลย
      var updatedRows = deductCatalogLimits(data.items, catRowsForOrder);
      if (readyItemsForOrder.length > 0) {
        if (readyCovered) {
          deductBranchStock_(data.branch, readyItemsForOrder);
        } else {
          deductStock(readyItemsForOrder, updatedRows || catRowsForOrder);
        }
      }
    }

    // ปล่อย lock ก่อนตรวจสลิป — ตรวจสลิปเป็น external API ช้า ถือ lock ค้างไว้
    // ระหว่างนั้นจะบล็อกออเดอร์อื่นที่กำลังเข้าคิวพร้อมกันโดยไม่จำเป็น (งานที่ต้อง
    // กันชนกันจริงๆ คือหักสต็อก/limit ด้านบน ซึ่งทำเสร็จภายใต้ lock แล้ว)
    lock.releaseLock();

    // ── ตรวจสลิปจริง (ช้า — SlipOK แล้ว fallback Claude vision ได้) ย้ายไปทำ async
    // ผ่าน processPendingSlipVerifications() (time-driven trigger รันทุก 1 นาที) แทน
    // การตรวจ inline ตรงนี้แบบเดิม — เหตุผล: doPost คืน response ให้ browser ลูกค้า
    // ก็ต่อเมื่อ return แล้วเท่านั้น ถ้ารอผลตรวจสลิปก่อน (เดิม) ลูกค้าที่เน็ตมือถือ/
    // LINE in-app browser หลุดหรือสลับแอประหว่างรอ (ตรวจช้าเมื่อไหร่ยิ่งเสี่ยง) จะไม่
    // เห็นหน้า "สั่งซื้อสำเร็จ" เลย ทั้งที่ออเดอร์บันทึกจริงแล้วเสมอ (เขียนไปแล้วด้านบน)
    // — ตอบกลับทันทีตรงนี้แทน (ก่อนตรวจสลิป) ให้หน้า success ขึ้นชัวร์ทุกครั้ง แล้วให้
    // trigger เป็นคนตรวจสลิป + ส่ง LINE ยืนยันผลทีหลัง (ข้อความเดียวกับเดิมทุกประการ
    // ผ่าน notifyCustomer() — ดู processPendingSlipVerifications())
    if (hasSlip) {
      // บันทึกรูปสลิปขึ้น Drive ทันที (เร็ว — แค่ Drive API ไม่ใช่ SlipOK/Claude ที่ช้า)
      // เก็บ slip_url ไว้ให้ trigger อ่านไฟล์กลับมาตรวจทีหลัง
      try {
        slipUrl = saveSlipToDrive(data.slipBase64, orderId);
        if (slipUrl) {
          newOrder.slip_url = slipUrl;
          writeSupabaseOrder_(newOrder);
        }
      } catch(_) {}
    } else {
      // ไม่มีสลิป — ไม่มีอะไรช้า (ไม่ต้องรอ SlipOK/Claude) แจ้ง LINE/Telegram ทันทีได้เลย
      // เหมือนเดิมทุกประการ ไม่ได้รับผลกระทบจากการย้ายไป async ด้านบน
      try {
        var streamlitUrl = "https://waka-space.streamlit.app/orders";
        if (TELEGRAM_FINANCE_CHAT_ID) {
          var itemsSummary = (data.items || []).map(function(i) {
            var u = i.type === "box" ? "กล่อง" : "ซอง";
            return "  - " + i.name + " (" + u + ") x" + (i.qty || 1);
          }).join("\n");
          var finMsg2 = "📩 ออเดอร์มีปัญหา #" + orderId
            + "\nลูกค้า: " + (data.displayName || "") + (data.realName ? " (" + data.realName + ")" : "")
            + "\nสาขา: " + (data.branch || "")
            + "\nยอด: " + data.total + " บาท"
            + "\n\n" + itemsSummary
            + "\n\n❌ ปัญหา: 📩 ไม่ได้แนบสลิป"
            + "\n\nตรวจสอบ:\n" + streamlitUrl;
          _telegramPush(TELEGRAM_FINANCE_CHAT_ID, finMsg2);
        }
        if (data.lineUserId) notifyCustomer(data.lineUserId, { orderId: orderId, items: data.items, displayName: data.displayName, branch: data.branch, address: data.address, total: data.total, slipStatus: slipStatus, instantReady: false });
      } catch(_) {}
    }

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
function _findCatalogRowById_(rows, id) {
  if (!id) return null;
  var idStr = String(id).trim();
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].id || "").trim() === idStr) return rows[i];
  }
  return null;
}
// เขียน item.name ให้ตรงกับชื่อปัจจุบันใน catalog เสมอ เมื่อ item มี id (รหัส
// สินค้า) ที่ resolve เจอ — ปิดช่องโหว่ตอนลูกค้า/staff ค้าง cart ไว้ข้ามช่วงที่
// มีคน rename สินค้า: ชื่อที่ client แคชไว้อาจเก่า แต่ id ไม่เปลี่ยน ทำให้ row ที่
// บันทึกจริงเป็นชื่อปัจจุบันเสมอ ไม่ทำให้ deductStock/checkCatalogLimits หา
// แถวไม่เจอแล้วข้ามการหักสต็อกไปเงียบๆ. item ที่ไม่มี id (client เก่า/ข้อมูล
// ย้อนหลัง) ผ่านไปเหมือนเดิมโดยไม่แก้อะไร
function _resolveItemsAgainstCatalog_(items, catRows) {
  (items || []).forEach(function(it) {
    var row = _findCatalogRowById_(catRows, it.id);
    if (row) it.name = row.name;
  });
  return items;
}
// ใช้แทน getSupabaseRow_("catalog","name",...) ตรงๆ ในจุดที่รับ id มาด้วย —
// ลอง id ก่อน (คงที่ไม่เปลี่ยนตามชื่อ) แล้วค่อย fallback เป็นชื่อ (รองรับ client/
// session เก่าที่ยังไม่ส่ง id มา)
function _resolveProductRow_(name, id) {
  var row = id ? getSupabaseRow_("catalog", "id", id) : null;
  return row || getSupabaseRow_("catalog", "name", name);
}
// เขียน row ที่เปลี่ยนกลับ Supabase — เรียกหลังแก้ rows ใน memory
function _pushCatalogRows_(rows, changedNames) {
  var names = {};
  changedNames.forEach(function(n) { names[String(n).trim()] = true; });
  rows.forEach(function(r) {
    if (!names[String(r.name).trim()]) return;
    var res = pushToSupabase_("catalog", r);
    if (!res.ok) throw new Error("Supabase catalog write failed (" + r.name + "): " + res.text);
  });
}

// checkCatalogLimits: ตรวจ limit_box/limit_pack และ actual stock (qty_box/qty_pack)
// skipStockCheck (optional bool): ข้ามการตรวจ "สต็อกกลางไม่พอ" — ใช้เมื่อ caller
// เช็คแล้วว่าสาขาที่ลูกค้าเลือกรับมีของพอส่งมอบเองอยู่แล้ว (_checkBranchCoverage_)
// จึงไม่ต้องพึ่งสต็อกกลางเลยสำหรับออเดอร์นี้ — limit_box/pack ยังตรวจตามปกติเสมอ
//
// catalog.status (พนักงานตั้งเองที่หน้า "สินค้า") เป็นตัวกำหนดว่าจะตรวจสต็อกจริง
// ด้วยมั้ย: "inactive" ปฏิเสธทันที, "preorder" ตรวจแค่ limit ไม่แตะสต็อกเลยไม่ว่า
// qty_box/pack จะมีค่าเท่าไหร่ก็ตาม (ต่างจากเดิมที่เดาจาก qty===0), ส่วน "ready"
// (หรือแถวเก่าที่ยังไม่มี status — ก่อน migration) ตรวจสต็อกตามปกติ
function checkCatalogLimits(items, _rows, skipStockCheck) {
  var rows = _rows || _fetchCatalogRows_();
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    var row = _findCatalogRow_(rows, item.name);
    if (!row) continue;
    if (row.status === "inactive") {
      return { error: item.name + " ปิดการขายแล้ว" };
    }
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
    if (row.status === "preorder") continue; // พรีออเดอร์ — ไม่แตะสต็อกจริงเลย
    // ตรวจ actual stock — แจ้งเตือนถ้าสต็อกกลางไม่พอ
    var stock = Number(row[stockField]) || 0;
    if (!skipStockCheck && stock > 0 && item.qty > stock) {
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
    _clearCatalogCache_();
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

// deductBranchStock_: หัก stock_branch แทนคลังกลาง — ใช้เมื่อออเดอร์ออนไลน์เลือกรับ
// ที่สาขาที่มีของพร้อมส่งมอบเองอยู่แล้ว (branchCoverage.covered ใน doPost) ของก้อนนี้
// ย้ายออกจากคลังกลางไปสาขาตั้งแต่ตอนส่งของแล้ว (handleCreateShipment ตัดกลางไปแล้ว)
// จึงไม่แตะ catalog เลย กันคลังกลางโดนหักซ้ำสอง
function deductBranchStock_(branch, items) {
  var rows = _fetchStockBranchRows_(branch);
  items.forEach(function(item) {
    var row = _findStockBranchRow_(rows, item.name, branch);
    if (!row) return;
    var field = item.type === "box" ? "qty_box" : "qty_pack";
    row[field] = Math.max(0, (Number(row[field]) || 0) - (item.qty || 1));
    var res = pushToSupabase_("stock_branch", row);
    if (!res.ok) throw new Error("Supabase stock_branch write failed (" + row.name + "/" + branch + "): " + res.text);
  });
}

// restoreStock: คืนสต็อกตอนยกเลิกออเดอร์/รายการ — `branch` (ชื่อสาขาของออเดอร์) ใช้
// เฉพาะ item ที่มี _branch_source (หักจาก stock_branch ไปตอนสั่งซื้อ) เพื่อคืนกลับไปที่
// สต็อกสาขาแทนคลังกลาง ส่วนที่เหลือคืนเข้า catalog ตามปกติ
function restoreStock(items, branch) {
  var branchItems = items.filter(function(it) { return it._branch_source; });
  var centralItems = items.filter(function(it) { return !it._branch_source; });

  if (branchItems.length > 0 && branch) {
    var bsRows = _fetchStockBranchRows_(branch);
    branchItems.forEach(function(item) {
      var row = _findStockBranchRow_(bsRows, item.name, branch);
      if (!row) return;
      var field = item.type === "box" ? "qty_box" : "qty_pack";
      row[field] = (Number(row[field]) || 0) + (item.qty || 1);
      var res = pushToSupabase_("stock_branch", row);
      if (!res.ok) throw new Error("Supabase stock_branch restore failed (" + row.name + "/" + branch + "): " + res.text);
    });
  }

  if (centralItems.length > 0) {
    var rows = _fetchCatalogRows_();
    var changedNames = [];
    for (var idx = 0; idx < centralItems.length; idx++) {
      var item = centralItems[idx];
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
    _clearCatalogCache_();
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
// Optional `lock` — see writeSupabaseOrder_'s comment above, same reasoning.
function _writeStockBranchRow_(row, lock) {
  var res = pushToSupabase_("stock_branch", row);
  if (!res.ok) throw new Error("Supabase stock_branch write failed (" + row.name + "/" + row.branch + "): " + res.text);
  if (lock) { try { lock.releaseLock(); } catch (_) {} }
  return row;
}

function _clearDashCache() {
  try { CacheService.getScriptCache().remove("dashboard_v1"); } catch(_) {}
}

// เคลียร์ทั้ง catalog_config (แคตตาล็อกลูกค้า, doGet) และ product_list_v1
// (รายการสินค้าสำหรับพนักงาน, action=product_list) พร้อมกัน — สองแคชนี้มาจาก
// ข้อมูล catalog ชุดเดียวกัน ต้องเคลียร์คู่กันเสมอไม่งั้นอันใดอันหนึ่งจะเก่าค้าง
function _clearCatalogCache_() {
  var cache = CacheService.getScriptCache();
  try { cache.remove("catalog_config"); } catch(_) {}
  try { cache.remove("product_list_v1"); } catch(_) {}
}

// ── เช็คว่าสต็อกสาขา (หลังหักที่ "จองไว้แล้ว" ให้ออเดอร์อื่นที่พร้อมรับ/รับบางส่วน
// ที่สาขานี้ — ยืนยันสลิปแล้วแต่ยังไม่ส่งมอบจริง) พอส่งมอบ items ทั้งหมดของออเดอร์นี้
// มั้ย ใช้ทั้งตอนตัดสินใจว่าจะเช็ค/หักสต็อกจากคลังกลางหรือจากสาขา (ดู doPost,
// deductBranchStock_) และตอนตั้ง fulfillment = "พร้อมรับ" ทันที (_tryInstantReady_)
// กันออเดอร์ใหม่แย่งของชิ้นเดียวกันไปนับซ้ำว่า "พอ" ทั้งที่จริงมีของให้แค่ใบเดียว
// ดึงสต็อกสาขา (หัก reservation จากออเดอร์อื่นที่ยืนยันสลิปแล้วแต่ยังไม่ส่งมอบ
// ที่สาขานี้ออกแล้ว) แยกออกมาจาก _checkBranchCoverage_ เพื่อให้ doPost เช็คความ
// ครอบคลุมได้หลายชุด item (ทั้งออเดอร์ vs เฉพาะ item สถานะ "พร้อมส่ง") จาก
// การดึงข้อมูลรอบเดียว แทนที่จะยิง Supabase ซ้ำต่อชุด — คืน null ถ้าไม่มีสาขา/
// เป็นออเดอร์จัดส่ง (เหมือน _checkBranchCoverage_ เดิม)
function _branchStockLookup_(branch) {
  var b = branch || "";
  if (!b || b === "จัดส่ง") return null;

  var bsRows = _fetchStockBranchRows_(b);
  var stockLookup = {};
  bsRows.forEach(function(r) {
    stockLookup[r.name] = { qty_box: Number(r.qty_box) || 0, qty_pack: Number(r.qty_pack) || 0 };
  });

  var committedFf = ["พร้อมรับ", "บางส่วน", "รับบางส่วนแล้ว", "สาขายืนยัน"];
  var others = supabaseSelect_("orders", "select=order_id,items_json,fulfillment&branch=eq." + encodeURIComponent(b) + "&slip_status=eq.ยืนยัน");
  others.forEach(function(o) {
    if (committedFf.indexOf(o.fulfillment || "") < 0) return;
    var oItems = Array.isArray(o.items_json) ? o.items_json : [];
    oItems.forEach(function(it) {
      var s = stockLookup[it.name];
      if (!s) return;
      var field = it.type === "box" ? "qty_box" : "qty_pack";
      s[field] -= (it.qty || 1);
    });
  });

  return stockLookup;
}

// เช็คว่า stockLookup (จาก _branchStockLookup_) พอส่งมอบ items ทั้งหมดในชุดนี้มั้ย
function _itemsCoveredByLookup_(stockLookup, items) {
  var arr = Array.isArray(items) ? items : [];
  if (!stockLookup || arr.length === 0) return false;
  return arr.every(function(it) {
    var s = stockLookup[it.name];
    var field = it.type === "box" ? "qty_box" : "qty_pack";
    return s && s[field] >= (it.qty || 1);
  });
}

function _checkBranchCoverage_(branch, items) {
  var stockLookup = _branchStockLookup_(branch);
  return { covered: _itemsCoveredByLookup_(stockLookup, items) };
}

// data: { branch, items } — public precheck จาก LIFF ก่อนกดยืนยันสั่งซื้อ ถามว่า
// สาขาที่เลือกมีของพอส่งมอบทันทีมั้ย (เพื่อเสนอเปลี่ยนเป็นจัดส่งถ้าไม่พอ) อ่านอย่างเดียว
// ไม่ล็อก ไม่หักอะไร — ผลลัพธ์แค่ boolean ไม่รั่วจำนวนสต็อกจริง
function handleCheckPickupReady(data) {
  var items = data.items || [];
  // พรีออเดอร์ไม่มีของที่สาขาไหนอยู่แล้วโดยนิยาม (ยังไม่ประกาศ "พร้อมส่ง") —
  // เช็ค branch coverage ไปก็ได้ false เสมอ ทำให้เด้ง prompt "ยังไม่พร้อมส่งมอบ
  // ทันที เปลี่ยนเป็นจัดส่งไหม" ผิดๆ ทั้งที่พรีออเดอร์ต้องรอไม่ว่าจะเลือกรับที่
  // สาขาหรือจัดส่งก็ตาม — กรองออกก่อน เหลือแค่ item "พร้อมส่ง" ที่ความครอบคลุม
  // สต็อกสาขามีความหมายจริง
  var catRows = _fetchCatalogRows_();
  var readyItems = items.filter(function(it) {
    var row = _findCatalogRow_(catRows, it.name);
    return !(row && row.status === "preorder");
  });
  var cov = readyItems.length > 0 ? _checkBranchCoverage_(data.branch, readyItems) : { covered: true };
  return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, ready: cov.covered })));
}

// ── ถ้าสต็อกสาขามีของครบพอส่งมอบอยู่แล้ว ตอนสลิปกลายเป็น "ยืนยัน" ก็ตั้งพร้อมรับ
// ทันที ไม่ต้องรอให้มีล็อตส่งของมาใหม่ค่อยเช็ค (เดิมเช็คแค่ตอน handleReceiveShipment) ──
// เรียกจาก 2 จุดที่สลิปกลายเป็น "ยืนยัน": ตอนสั่งซื้อ (auto-verify) และตอน admin
// กดยืนยันสลิปทีหลัง (handleConfirmSlip). แก้ไข `order` ในหน่วยความจำแล้วคืน true
// ถ้าตั้งพร้อมรับสำเร็จ — caller เป็นคนเขียนลง Supabase + ส่ง LINE แจ้งเอง
//
// precomputedCovered (optional boolean): ถ้า caller เช็ค _checkBranchCoverage_
// ไปแล้วก่อนหน้านี้ในคำขอเดียวกัน (เช่นตอนสร้างออเดอร์ ที่ต้องเช็คก่อนเพื่อตัดสินใจ
// เรื่องหักสต็อกอยู่แล้ว) ส่งผลลัพธ์เข้ามาได้เลย กันอ่าน Supabase ซ้ำ — ถ้าไม่ส่งมา
// (เช่นตอน handleConfirmSlip ที่เวลาผ่านไปแล้ว ต้องเช็คสดใหม่) ฟังก์ชันนี้เช็คเอง
function _tryInstantReady_(order, precomputedCovered) {
  var branch = order.branch || "";
  if (!branch || branch === "จัดส่ง") return false;
  var items = Array.isArray(order.items_json) ? order.items_json : [];
  if (items.length === 0) return false;

  var covered;
  if (typeof precomputedCovered === "boolean") {
    covered = precomputedCovered;
  } else {
    // มี item พรีออเดอร์ปนอยู่ = ยังไม่พร้อมรับทั้งใบแน่ๆ ไม่ว่าของที่เหลือจะพอ
    // ที่สาขามั้ยก็ตาม (ใช้ตอน handleConfirmSlip เช็คสดใหม่ — ตอนสั่งซื้อ doPost
    // ส่ง precomputedCovered ที่คิดตามตรรกะเดียวกันนี้มาแล้ว)
    var hasPreorder = items.some(function(it) { return !!it._preorder; });
    var readyItems = items.filter(function(it) { return !it._preorder; });
    covered = !hasPreorder && _checkBranchCoverage_(branch, readyItems).covered;
  }
  if (!covered) return false;

  order.fulfillment = "พร้อมรับ";
  order.fulfilled_at = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
  return true;
}

// ── แจ้งพนักงานคลังกลางว่าต้องส่งของไปสาขา ────────────────────────────────
// เรียกเฉพาะตอนสลิปยืนยันแล้วเท่านั้น (ตอนสั่งซื้อที่ auto-verify หรือตอน
// handleConfirmSlip) กันแจ้งเตือนก่อนเวลาสำหรับออเดอร์ที่ยังไม่ผ่านการตรวจสลิป
// `covered` = ผลจาก _checkBranchCoverage_/_tryInstantReady_ ของออเดอร์นี้ —
// ถ้า covered (ของพอที่สาขาอยู่แล้ว) หรือเป็นออเดอร์จัดส่ง ไม่ต้องแจ้งอะไร
// กรองเฉพาะ item ที่ไม่ใช่พรีออเดอร์ (_preorder) — พรีออเดอร์ยังไม่มีของที่ไหน
// เลยด้วยซ้ำ แจ้งให้ "ส่งไปสาขา" ตอนนี้ไม่มีประโยชน์ (คลังกลางก็ไม่มีจะส่ง)
function _notifyBranchRestockNeeded_(order, covered) {
  var branch = order.branch || "";
  if (!branch || branch === "จัดส่ง" || covered) return;
  var items = Array.isArray(order.items_json) ? order.items_json : [];
  var needed = items.filter(function(it) { return !it._preorder; });
  if (needed.length === 0) return;
  var groupStaff = _getConfigValue(null, "group_staff_live");
  if (!groupStaff) return;
  var lines = needed.map(function(it) {
    var u = it.type === "box" ? "กล่อง" : "ซอง";
    return "  - " + it.name + " x" + (it.qty || 1) + " " + u;
  }).join("\n");
  _notifyStaffGroup_(groupStaff, "📮 สาขา " + branch + " ของไม่พอส่งมอบออเดอร์ #" + (order.order_id || "") +
    " — กรุณาส่งของไปสาขาเพิ่ม:\n" + lines);
}

function notifyCustomer(userId, order) {
  var items = (order.items || []).map(function(i) {
    var unitLabel = i.type === "box" ? "กล่อง" : "ซอง";
    return "  - " + i.name + " (" + unitLabel + ") x" + i.qty;
  }).join("\n");
  var isDelivery = order.branch === "จัดส่ง";
  var lines = [
    "WAKA ขอบคุณสำหรับคำสั่งซื้อเลขที่ #" + order.orderId,
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
  } else if (order.instantReady) {
    // สลิปผ่านอัตโนมัติ + สต็อกสาขาพอส่งมอบอยู่แล้วตอนสั่ง — รวมแจ้ง "รับออเดอร์
    // แล้ว" กับ "พร้อมรับแล้ว" เป็นข้อความเดียว แทนที่จะยิง 2 ข้อความติดกัน (เดิม
    // ลูกค้าได้ "รับออเดอร์แล้ว...ทีมงานจะตรวจสอบ" ตามด้วย "พร้อมรับแล้ว" ทันที
    // ซึ่งขัดแย้งกันเอง เพราะจริงๆ ตรวจ+พร้อมรับเสร็จในตาเดียวกันไปแล้ว)
    var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + order.orderId;
    lines.push("สินค้าพร้อมรับที่สาขา" + order.branch + " แล้ว!");
    lines.push("");
    lines.push("ดูสถานะ:\n" + trackUrl);
  } else {
    lines.push("ทีมงานจะตรวจสอบและแจ้งกลับทาง LINE ครับ");
    lines.push("");
    lines.push("เช็คสถานะได้ที่:\n" + "https://waka-liff.vercel.app/confirm.html?order=" + order.orderId);
  }
  _linePush(userId, lines.join("\n"));
}

// เดิมไม่เช็ค response เลย (muteHttpExceptions:true กันไม่ให้ throw แต่ก็ไม่มี
// ใครอ่าน response code ต่อ) — ถ้า LINE_TOKEN หมดอายุ/ผิด หรือบอทถูกเตะออกจาก
// กลุ่ม ข้อความจะเงียบหายไปโดยไม่มีร่องรอยอะไรเลยแม้แต่ใน log ต่างจาก
// pushToSupabase_/patchSupabase_ ที่ log ความล้มเหลวไว้เสมอ ตรวจ+log ให้เหมือน
// กัน อย่างน้อยเปิด Executions ใน Apps Script แล้วดูย้อนหลังได้ว่าพังเพราะอะไร
function _linePush(to, text, token) {
  try {
    var res = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/push", {
      method: "post",
      muteHttpExceptions: true,
      headers: {
        Authorization:  "Bearer " + (token || LINE_TOKEN),
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({ to, messages: [{ type: "text", text: text }] }),
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log("_linePush(" + to + ") HTTP " + code + ": " + res.getContentText());
    }
  } catch (e) {
    Logger.log("_linePush(" + to + ") failed: " + e.message);
  }
}

// ── ส่งข้อความ Telegram — เทียบเท่า _linePush() แต่ผ่าน Telegram Bot API แทน
// ใช้เฉพาะแจ้งไฟแนนซ์ตอนนี้ (ดู doPost) ไม่ผูกกับ order/customer flow อื่นเลย
function _telegramPush(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) return;
  try {
    var res = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "post",
      muteHttpExceptions: true,
      contentType: "application/json",
      payload: JSON.stringify({ chat_id: chatId, text: text }),
    });
    var code = res.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log("_telegramPush(" + chatId + ") HTTP " + code + ": " + res.getContentText());
    }
  } catch (e) {
    Logger.log("_telegramPush(" + chatId + ") failed: " + e.message);
  }
}

// ── แจ้งกลุ่ม staff ทั้ง LINE และ Telegram พร้อมกันเสมอ — LINE (STAFF_LIVE_LINE_TOKEN)
// ยังเป็นช่องทางหลักที่พนักงานเคยชินอยู่แล้ว ไม่ได้ตัดออก แค่มิเรอร์ข้อความเดียวกัน
// ไปที่ TELEGRAM_FINANCE_CHAT_ID ด้วยเสมอ (ไม่มีโควต้า/เดือน) เผื่อ LINE OA ตัวนี้
// ชนโควต้า 300/เดือนแล้วข้อความหายไปเงียบๆ พนักงานยังเห็นผ่าน Telegram อยู่
function _notifyStaffGroup_(groupId, text) {
  _linePush(groupId, text, STAFF_LIVE_LINE_TOKEN);
  _telegramPush(TELEGRAM_FINANCE_CHAT_ID, text);
}

// ── เช็คโควต้าข้อความ LINE ที่เหลือเดือนนี้ — ทั้ง OA หลัก (ลูกค้า, WAKA ORDER,
// LINE_TOKEN) และ OA staff (WAKA NOTI BOT, STAFF_LIVE_LINE_TOKEN) แยกกัน เพราะ
// แยกโควต้ากันไว้ตั้งแต่แรกไม่ให้แจ้งเตือน staff ปริมาณสูงไปแย่งโควต้าออเดอร์
// ลูกค้า (ดูคอมเมนต์ STAFF_LIVE_LINE_TOKEN บนสุดของไฟล์) — รัน manual ใน Apps
// Script editor (Run → checkLineQuota) แล้วดูผลใน Logger (View → Logs) หรือ
// ผลลัพธ์ return ก็ได้ ไม่มีปุ่มเรียกจากที่อื่นในระบบ เหมือน checkSlipOKQuota()
function checkLineQuota() {
  function fetchOne(label, token) {
    if (!token) return { label: label, error: "ไม่มี token" };
    var headers = { Authorization: "Bearer " + token };
    var quotaRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/quota", {
      headers: headers, muteHttpExceptions: true,
    });
    var usageRes = UrlFetchApp.fetch("https://api.line.me/v2/bot/message/quota/consumption", {
      headers: headers, muteHttpExceptions: true,
    });
    if (quotaRes.getResponseCode() !== 200 || usageRes.getResponseCode() !== 200) {
      return { label: label, error: "HTTP " + quotaRes.getResponseCode() + "/" + usageRes.getResponseCode() + ": " + quotaRes.getContentText() };
    }
    var quota = JSON.parse(quotaRes.getContentText()); // { type: "limited"|"none", value?: N }
    var usage = JSON.parse(usageRes.getContentText()); // { totalUsage: N }
    var limit = quota.type === "limited" ? Number(quota.value) : null; // "none" = ไม่จำกัด (แผนเสียเงินบางแบบ)
    var used = Number(usage.totalUsage) || 0;
    return {
      label: label,
      limit: limit,
      used: used,
      remaining: limit === null ? null : Math.max(0, limit - used),
    };
  }

  var results = [
    fetchOne("ลูกค้า (WAKA ORDER)", LINE_TOKEN),
    fetchOne("staff (WAKA NOTI BOT)", STAFF_LIVE_LINE_TOKEN),
  ];
  results.forEach(function(r) {
    if (r.error) {
      Logger.log(r.label + ": error — " + r.error);
    } else if (r.limit === null) {
      Logger.log(r.label + ": ไม่จำกัดโควต้า (ใช้ไปแล้ว " + r.used + " ข้อความเดือนนี้)");
    } else {
      Logger.log(r.label + ": เหลือ " + r.remaining + " / " + r.limit + " (ใช้ไปแล้ว " + r.used + ")");
    }
  });
  return results;
}

// ── ล้าง Script Properties ของตัวนับเลขที่รายวัน (order/purchase/walkin) ────
// _genOrderId/_genPurchaseId/_genWalkinSaleId เก็บตัวนับไว้เป็น Script Property
// คนละคีย์ต่อวัน (order_seq_YYMMDD, purchase_seq_YYMMDD, walkin_seq_YYMMDD)
// แล้วไม่เคยลบทิ้งเลย — คีย์ของเมื่อวานไม่มีจุดไหนอ่าน/เขียนอีกแล้วหลังเที่ยงคืน
// ผ่านไป แต่ค้างอยู่ถาวร ทำให้ properties สะสมวันละสูงสุด 3 คีย์ไปเรื่อยๆ จนเกิน
// 50 (Apps Script UI จำกัดดู/แก้ไขได้แค่ 50 ตัวแรกผ่านหน้าเว็บ ต้องจัดการผ่าน
// Properties Service แทน) — ฟังก์ชันนี้ลบทุกคีย์ที่ตรง prefix เหล่านี้ที่ "ไม่ใช่
// วันนี้" ออกทั้งหมด ปลอดภัยเพราะไม่มีจุดไหนในระบบอ่านค่าของวันเก่ากลับไปใช้เลย
function cleanupOldSequenceProps() {
  var todayPrefix = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyMMdd");
  var seqPrefixes = ["order_seq_", "purchase_seq_", "walkin_seq_"];
  var all = PROPS.getProperties();
  var deleted = [];
  Object.keys(all).forEach(function(key) {
    for (var i = 0; i < seqPrefixes.length; i++) {
      var p = seqPrefixes[i];
      if (key.indexOf(p) === 0 && key !== p + todayPrefix) {
        PROPS.deleteProperty(key);
        deleted.push(key);
        break;
      }
    }
  });
  Logger.log("cleanupOldSequenceProps: ลบ " + deleted.length + " คีย์ — " + deleted.join(", "));
  return deleted;
}

// ── ติดตั้ง trigger รายวันให้ cleanupOldSequenceProps() รันเองอัตโนมัติ ─────
// รันฟังก์ชันนี้ "ครั้งเดียว" จาก Apps Script editor (Run → installCleanupTrigger)
// — ลบ trigger ชื่อเดิมทิ้งก่อนสร้างใหม่เสมอ กันเผลอรันซ้ำแล้วได้ trigger ซ้ำ
// หลายตัว หลังติดตั้งแล้ว properties จะไม่มีวันเกิน 50 จากสาเหตุนี้อีก ไม่ต้อง
// ทำ cleanup ด้วยมือเองอีกเลย
function installCleanupTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "cleanupOldSequenceProps") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("cleanupOldSequenceProps")
    .timeBased()
    .everyDays(1)
    .atHour(3)
    .create();
}

// ── ตรวจสลิปแบบ async (time-driven trigger, รันทุก 1 นาที) ──────────────────
// เดิม doPost ตรวจสลิป (SlipOK → fallback Claude vision ถ้า SlipOK ไม่ผ่าน) แบบ
// synchronous ก่อน return response — ยิ่งตรวจช้า (fallback Claude) ลูกค้าที่เน็ต
// มือถือ/LINE in-app browser หลุดหรือสลับแอประหว่างรอยิ่งเสี่ยงไม่เห็นหน้า "สั่งซื้อ
// สำเร็จ" เลย ทั้งที่ออเดอร์บันทึกจริงแล้วเสมอ (ดูคอมเมนต์ใน doPost) — ตอนนี้ doPost
// ตอบกลับทันทีหลังบันทึกออเดอร์ (สถานะ "รอตรวจ") แล้วปล่อยให้ trigger นี้เป็นคนตรวจ
// สลิปจริง + ส่ง LINE ยืนยันผลทีหลัง (ข้อความเดียวกับเดิมทุกประการ ผ่าน
// notifyCustomer() — ไม่ได้แยกส่งเป็น 2 ข้อความ)
//
// ติดตั้ง trigger ด้วย installSlipVerificationTrigger() (รันมือครั้งเดียว)
function processPendingSlipVerifications() {
  // กัน trigger 2 รอบทับซ้อนกันประมวลผลออเดอร์เดียวกัน (เช่นรอบก่อนยังไม่จบ)
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return;

  try {
    // batch จำกัด 5 ออเดอร์/รอบ กัน trigger รันเกินเวลาที่ Apps Script อนุญาต —
    // ออเดอร์ที่เหลือถูกหยิบไปทำในรอบถัดไป (ทุก 1 นาที) — ไม่กรอง slip_url ที่นี่
    // (บาง order อาจ saveSlipToDrive พลาดแล้ว slip_url ว่าง — ให้เข้าไปเช็คในลูปแทน
    // จะได้ log ให้เห็นสาเหตุ แทนที่จะหายไปเงียบๆ จาก query เลย)
    var pending = supabaseSelect_("orders", "select=order_id&slip_status=eq.รอตรวจ&order=timestamp.asc&limit=5");

    pending.forEach(function(row) {
      var orderId = row.order_id;
      try {
        var order = getSupabaseOrder_(orderId);
        if (!order) return;
        // เช็คซ้ำ — เผื่อแอดมินกด handleConfirmSlip/handleRejectSlip เองไปแล้ว
        // ระหว่างที่ order นี้เข้าคิวรอ trigger รอบนี้อยู่ (กัน LINE ซ้ำซ้อน)
        if (order.slip_status !== "รอตรวจ") return;

        var slipBase64 = _fetchDriveFileAsBase64_(order.slip_url);
        if (!slipBase64) {
          Logger.log("processPendingSlipVerifications(" + orderId + "): ไม่มี/อ่าน slip_url ไม่ได้ (" + order.slip_url + ") — ข้ามรอบนี้");
          return; // ยังค้าง "รอตรวจ" ต่อไป เห็นได้บน dashboard ฝั่งแอดมิน (pending list เดิม)
        }

        var verified = _verifyAndClassifySlip_(slipBase64, order.total);
        order.slip_status = verified.slipStatus;
        order.slip_amount = verified.slipAmount || null;
        order.slip_txn_id = verified.slipTxnId || null;
        order.notes       = verified.slipNote || null;

        var instantReady = verified.slipStatus === "ยืนยัน" && _tryInstantReady_(order);
        writeSupabaseOrder_(order);

        if (order.line_user_id) {
          notifyCustomer(order.line_user_id, {
            orderId: orderId, items: order.items_json, displayName: order.display_name,
            branch: order.branch, address: order.address, total: order.total,
            slipStatus: order.slip_status, instantReady: instantReady,
          });
        }

        // แจ้งไฟแนนซ์ผ่าน Telegram — เนื้อหา/เงื่อนไขเดิมทุกอย่างจาก doPost (ย้ายมา
        // ที่นี่เพราะตอนนี้ต้องรอผลตรวจสลิปจริงก่อนถึงจะส่งได้)
        if (TELEGRAM_FINANCE_CHAT_ID) {
          var itemsSummary = (Array.isArray(order.items_json) ? order.items_json : []).map(function(i) {
            var u = i.type === "box" ? "กล่อง" : "ซอง";
            return "  - " + i.name + " (" + u + ") x" + (i.qty || 1);
          }).join("\n");
          var streamlitUrl = "https://waka-space.streamlit.app/orders";
          var finMsg2;
          if (order.slip_status === "ยืนยัน") {
            finMsg2 = "✅ ออเดอร์ผ่านอัตโนมัติ #" + orderId
              + "\nลูกค้า: " + (order.display_name || "") + (order.real_name ? " (" + order.real_name + ")" : "")
              + "\nสาขา: " + (order.branch || "")
              + "\nยอด: " + order.total + " บาท"
              + "\n\n" + itemsSummary;
            if (order.notes) finMsg2 += "\n\n📋 " + order.notes;
          } else {
            var problemLabel = {
              "ยอดไม่ตรง": "💰 ยอดเงินไม่ตรง",
              "บัญชีไม่ตรง": "🏦 บัญชีไม่ตรง",
              "สลิปซ้ำ": "🔁 สลิปซ้ำ (เลขอ้างอิงเคยใช้แล้ว)",
              "สงสัยปลอม": "🚨 สงสัยสลิปปลอม",
              "รอตรวจ": "🔍 อ่านสลิปไม่ได้",
              "รอตรวจเพิ่ม": "🔍 ต้องตรวจเพิ่ม",
            };
            finMsg2 = "⚠️ ออเดอร์มีปัญหา #" + orderId
              + "\nลูกค้า: " + (order.display_name || "") + (order.real_name ? " (" + order.real_name + ")" : "")
              + "\nสาขา: " + (order.branch || "")
              + "\nยอด: " + order.total + " บาท"
              + "\n\n" + itemsSummary
              + "\n\n❌ ปัญหา: " + (problemLabel[order.slip_status] || order.slip_status);
            if (order.notes) finMsg2 += "\n📋 " + order.notes;
          }
          if (verified.slipDate) finMsg2 += "\n\n📅 วันที่โอน: " + verified.slipDate;
          finMsg2 += "\n\nตรวจสอบ:\n" + streamlitUrl;
          _telegramPush(TELEGRAM_FINANCE_CHAT_ID, finMsg2);
        }

        if (order.slip_status === "ยืนยัน") _notifyBranchRestockNeeded_(order, instantReady);
      } catch (e) {
        Logger.log("processPendingSlipVerifications(" + orderId + ") failed: " + e.message);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

// ดึงไฟล์กลับจาก Drive (ที่ saveSlipToDrive อัปโหลดไว้ตอน doPost) มาเป็น base64
// สำหรับส่งเข้า SlipOK/Claude — parse Drive file id ออกจาก URL รูปแบบ
// "thumbnail?id=XXXX&sz=..." ที่ saveSlipToDrive คืนมา
function _fetchDriveFileAsBase64_(driveUrl) {
  var m = String(driveUrl || "").match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (!m) return "";
  try {
    var bytes = DriveApp.getFileById(m[1]).getBlob().getBytes();
    return Utilities.base64Encode(bytes);
  } catch (e) {
    Logger.log("_fetchDriveFileAsBase64_(" + driveUrl + ") failed: " + e.message);
    return "";
  }
}

// ── ติดตั้ง trigger ให้ processPendingSlipVerifications() รันเองทุก 1 นาที ──────
// รันฟังก์ชันนี้ "ครั้งเดียว" จาก Apps Script editor (Run → installSlipVerificationTrigger)
// — ลบ trigger ชื่อเดิมทิ้งก่อนสร้างใหม่เสมอ กันเผลอรันซ้ำแล้วได้ trigger ซ้ำหลายตัว
// (เหมือน installCleanupTrigger() ด้านบน) — 1 นาทีคือความถี่ละเอียดสุดที่ Apps
// Script time-driven trigger รองรับ
function installSlipVerificationTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === "processPendingSlipVerifications") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("processPendingSlipVerifications")
    .timeBased()
    .everyMinutes(1)
    .create();
}

// `cfgWs` param kept (but unused) — every call site still passes `null` as
// the first arg from before _config reads went Supabase-only (getConfig_).
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

// ── Tournament Registration ─────────────────────────────────────────────────
function handleTournamentRegister(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
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

    if (data.lineUserId && data.lineUserId !== "dev_user") {
      var custMsg = "🏆 ลงทะเบียนสำเร็จ!\n"
        + "ทัวร์นาเมนต์: " + eventName + "\n"
        + "ลำดับที่: " + seqNo + "\n"
        + "ชื่อแข่ง: " + String(data.playerName || "");
      if (payMethod !== "cash") custMsg += "\n📋 สถานะสลิป: รอตรวจ";
      custMsg += "\n\n🔗 ดูสถานะ + QR:\n" + statusUrl;
      _linePush(data.lineUserId, custMsg);
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

function handleApi(params) {
  var action = params.do || "";

  // ── ตรวจ PIN แอดมิน/รหัสสาขาตอน login — เดิม liff/app.html เก็บ ADMIN_CODE/
  // BRANCH_CODES ทั้งชุดเป็นค่าคงที่ในไฟล์ ใครก็ view-source เห็นรหัสของทุกสาขา
  // รวมถึง PIN แอดมินได้หมด ทั้งที่แต่ละคนควรรู้แค่รหัสของตัวเอง — ย้ายมาตรวจที่นี่
  // แทน ส่งกลับแค่ผลของรหัสที่พิมพ์มา (role + สาขาที่ตรงกับรหัสนั้นรหัสเดียว) ไม่ส่ง
  // ADMIN_CODE/BRANCH_CODES ทั้งชุดออกไปให้ client เลย ต้องยิงผ่าน POST เท่านั้น
  // (client ฝั่ง checkPin/loginBranch เรียกแบบนี้อยู่แล้ว) กัน PIN หลุดไปอยู่ใน query
  // string/server log แบบ GET
  if (action === "verify_code") {
    var vcCode = String(params.code || "").trim();
    if (vcCode && vcCode === String(ADMIN_CODE || "").trim()) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, role: "admin", branch: "ทั้งหมด" })));
    }
    var vcBranch = vcCode ? BRANCH_CODES[vcCode] : null;
    if (vcBranch) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, role: "staff", branch: vcBranch })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: false })));
  }

  if (action === "search") {
    var q = String(params.q || "").toLowerCase().trim();
    if (!q) return _cors(ContentService.createTextOutput(JSON.stringify({ orders: [] })));
    // Optional branch scoping — app.html's branch-portal search passes this
    // so staff only find/handover their own branch's orders; other callers
    // (e.g. an admin-wide lookup with no branch context) omit it and keep
    // searching every branch, unchanged.
    var seBranch = String(params.branch || "").trim();
    if (seBranch && !_branchAuthorized(params.code, seBranch)) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }
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
      if (seBranch && srow.branch !== seBranch) continue;
      var seMatch = srow.order_id.toLowerCase().indexOf(q) >= 0
        || srow.real_name.toLowerCase().indexOf(q) >= 0
        || srow.display_name.toLowerCase().indexOf(q) >= 0
        || srow.email.toLowerCase().indexOf(q) >= 0
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
      if (uid) _linePush(uid, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + orderId + "\n\nดูสถานะ:\n" + trackUrl + "\n\nสามารถแจ้งเลขที่ออเดอร์ เพื่อรับสินค้าที่สาขาได้เลยครับ");
    } else if (newStatus === "handover") {
      // ยกเลิกขั้นตอน "ลูกค้ากดยืนยันรับของ" — พนักงานกดส่งมอบ/จัดส่งถือว่า
      // order จบทันที ไม่ต้องรอลูกค้ากดยืนยันอีกขั้น (ตามคำขอเจ้าของร้าน)
      order.fulfillment = isDelivery ? "จัดส่งแล้ว" : "สาขายืนยัน";
      order.staff_confirmed_at = now;
      order.customer_confirmed_at = now;
      if (uid) {
        var doneMsg = isDelivery
          ? "🎉 WAKA ได้จัดส่งสินค้าครบทุกชิ้นตามคำสั่งซื้อแล้ว\nออเดอร์: #" + orderId + "\n\nขอบคุณที่อุดหนุน WAKA SPACE ครับ 🙏\n\nหากคุณยังไม่ได้รับพัสดุ กรุณาติดต่อแอดมินโดยด่วน"
          : "🎉 WAKA ได้ส่งมอบสินค้าครบทุกชิ้นตามคำสั่งซื้อแล้ว\nออเดอร์: #" + orderId + "\n\nขอบคุณที่อุดหนุน WAKA SPACE ครับ 🙏\n\nหากคุณยังไม่ได้รับสินค้า กรุณาติดต่อแอดมินโดยด่วน";
        _linePush(uid, doneMsg);
      }
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

  // ── สต็อกที่กันไว้ที่แต่ละสาขาแล้ว (พร้อมรับ — ลูกค้ายังไม่มารับ) ──
  // ต่างจาก branch_summary ตรงที่นี่คือของที่ "ถึงสาขาแล้ว" และถูกจองไว้ให้
  // ออเดอร์นี้แล้ว ไม่ใช่ของที่ยังต้องส่ง — ใช้ตอนสร้างล็อตใหม่เพื่อรู้ว่า
  // สต็อกที่สาขาเท่าไหร่ที่ขายหน้าร้านไม่ได้เพราะกันไว้ให้ออเดอร์อยู่แล้ว
  if (action === "branch_reserved") {
    var brSb = supabaseSelect_("orders", "select=branch,items_json&slip_status=eq.ยืนยัน&fulfillment=eq.พร้อมรับ");
    var brSummary = {};
    brSb.forEach(function(r) {
      var branch = r.branch || "";
      var items = r.items_json || [];
      if (!brSummary[branch]) brSummary[branch] = {};
      for (var x = 0; x < items.length; x++) {
        var key = items[x].name;
        if (!brSummary[branch][key]) brSummary[branch][key] = { name: key, qty_box: 0, qty_pack: 0, order_count: 0 };
        if (items[x].type === "box") brSummary[branch][key].qty_box += (items[x].qty || 1);
        else brSummary[branch][key].qty_pack += (items[x].qty || 1);
        brSummary[branch][key].order_count++;
      }
    });
    var brResult = {};
    for (var rb in brSummary) {
      brResult[rb] = [];
      for (var rk in brSummary[rb]) brResult[rb].push(brSummary[rb][rk]);
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ branches: brResult })));
  }

  // ── สต็อกกลาง ──
  if (action === "central_stock") {
    var csRows = supabaseSelect_("catalog", "select=name,id,category,qty_box,qty_pack");
    var stock = csRows.filter(function(r) { return r.name; }).map(function(r) {
      return { name: String(r.name), id: String(r.id || ""), category: String(r.category || ""), qty_box: Number(r.qty_box) || 0, qty_pack: Number(r.qty_pack) || 0 };
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
    // ตัวกรอง branch/month เสริม (optional) — ใช้โดยการ์ด "รายงานยอดขาย" ใน
    // เมนูสาขาของ app.html (liff/report.html เรียกแบบไม่ใส่ตัวกรองเลย ยังได้
    // พฤติกรรมเดิมทุกสาขา/ทุกช่วงเวลาเหมือนก่อนหน้านี้). branch ที่ระบุต้อง
    // ผ่าน _branchAuthorized เหมือน action อื่นๆ ที่ผูกกับสาขา
    var repBranchFilter = String(params.branch || "").trim();
    var repMonthFilter = String(params.month || "").trim(); // "YYYY-MM"
    if (repBranchFilter && !_branchAuthorized(params.code, repBranchFilter)) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }

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

    var repQuery = "select=branch,timestamp,items_json&slip_status=eq.ยืนยัน";
    if (repBranchFilter) repQuery += "&branch=eq." + encodeURIComponent(repBranchFilter);
    var repSb = supabaseSelect_("orders", repQuery);
    var reportRows = repSb.map(function(r) {
      // Supabase's timestamp is UTC — convert to Bangkok-local before using
      // as the by-date grouping key, same reasoning as the dashboard fix.
      var localDate = Utilities.formatDate(new Date(r.timestamp), "Asia/Bangkok", "yyyy-MM-dd");
      return { branch: r.branch || "ไม่ระบุ", dateKey: localDate, items: r.items_json || [] };
    }).filter(function(rr) {
      return !repMonthFilter || rr.dateKey.indexOf(repMonthFilter) === 0;
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
          name: String(lr.name), id: String(lr.id || ""), category: String(lr.category || ""),
          price_box: Number(lr.price_box) || 0, price_pack: Number(lr.price_pack) || 0,
          cost_box: Number(lr.cost_box) || 0, cost_pack: Number(lr.cost_p) || 0,
          barcode: barcode, stock_box: Number(lr.qty_box) || 0, stock_pack: Number(lr.qty_pack) || 0,
        }
      })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ found: false })));
  }

  // ── รายการสินค้าทั้งหมด (สำหรับหน้ารับสต็อก) ──
  // Cache 120 วิ (เหมือน catalog_config แต่สั้นกว่า เพราะเป็นข้อมูลฝั่งพนักงาน
  // ที่อยากให้สดกว่าลูกค้าเล็กน้อย) — ก่อนหน้านี้ยิง supabaseSelect_ เต็มตาราง
  // catalog ทุกครั้งที่ app.html สลับมาแท็บ "รับเข้า" ไม่มี cache เลยสักครั้ง
  if (action === "product_list") {
    var plCache = CacheService.getScriptCache();
    var plCached = plCache.get("product_list_v1");
    if (plCached) return _cors(ContentService.createTextOutput(plCached));

    var plRows = supabaseSelect_("catalog", "select=*");
    var products = plRows.filter(function(r) { return r.name; }).map(function(r) {
      return {
        name: String(r.name).trim(), id: String(r.id || ""), category: String(r.category || ""),
        price_box: Number(r.price_box) || 0, price_pack: Number(r.price_pack) || 0,
        cost_box: Number(r.cost_box) || 0, cost_pack: Number(r.cost_p) || 0,
        barcode: String(r.barcode || ""),
        limit_box: (r.limit_box === "" || r.limit_box === undefined || r.limit_box === null) ? -1 : Number(r.limit_box),
        limit_pack: (r.limit_pack === "" || r.limit_pack === undefined || r.limit_pack === null) ? -1 : Number(r.limit_pack),
        stock_box: Number(r.qty_box) || 0, stock_pack: Number(r.qty_pack) || 0,
        packs_per_box: Number(r.packs_per_box) || 0,
      };
    });
    var plJson = JSON.stringify({ products: products });
    try { plCache.put("product_list_v1", plJson, 120); } catch(_) {} // เกิน 100KB ไม่ throw ทับคำขอปัจจุบัน แค่ไม่แคช
    return _cors(ContentService.createTextOutput(plJson));
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
    var dPendingSlips = ["รอตรวจ", "รอตรวจเพิ่ม", "ยอดไม่ตรง", "สลิปซ้ำ", "บัญชีไม่ตรง", "สงสัยปลอม"];

    // นับ pending แยกเป็น query ของตัวเอง กรองที่ Supabase เลย (select=order_id
    // เฉพาะคอลัมน์เดียว) แทนที่จะดึงทั้งตาราง orders มา filter ฝั่ง JS — กัน
    // ปัญหาสองต่อ: (1) ตารางโตขึ้นเรื่อยๆ ก็ยังนับได้ครบไม่ต้องลาก full table,
    // (2) ออเดอร์ค้างตรวจเก่าๆ ที่หลุด limit ของ recent list ด้านล่างจะไม่ตกหล่น
    var dPendingFilter = dPendingSlips.map(function(s) { return encodeURIComponent(s); }).join(",");

    // recent_orders ใช้แสดงผลบนหน้า LIFF "ออเดอร์" — โชว์เฉพาะออเดอร์ที่ยังไม่
    // เสร็จสมบูรณ์เท่านั้น (ดูรายการทั้งหมด/ประวัติย้อนหลังไปดูที่ Streamlit แทน)
    // จำกัด limit ที่ query เลยแทนที่จะดึงทั้งตารางมาตัดทีหลัง ยิ่งออเดอร์สะสม
    // เยอะยิ่งช้าลงเรื่อยๆ ถ้าไม่ limit — สถานะ "เสร็จสมบูรณ์" กรองฝั่ง JS ไม่ใช่
    // SQL because fulfillment เป็น NULL ได้สำหรับออเดอร์ใหม่ที่ยังไม่ขยับสถานะ
    // เลย, ตัวกรอง SQL แบบ not.in/neq จะดรอป NULL แถวเหล่านั้นทิ้งไปเงียบๆ (บั๊ก
    // เดียวกับที่คอมเมนต์ไว้ใน branch_summary ด้านบน)
    // "จัดส่งแล้ว" (delivery) นับเป็น done ด้วย เพราะพนักงานกดส่งมอบก็ปิด order
    // ทันทีแล้ว ไม่มีขั้นตอนรอลูกค้ากดยืนยันรับของแยกต่างหากอีกต่อไป
    var dDoneFulfillment = ["รับแล้ว", "สาขายืนยัน", "จัดส่งแล้ว", "ยกเลิก"];

    // ยิงสองคำขอนี้พร้อมกันจริง (fetchAll) แทนที่จะรอทีละอัน — ตัวนี้เป็นคำขอ
    // แรกสุดที่ app.html ยิงทุกครั้งที่เปิดหน้า (cache miss ทุก 30 วิ) เวลาที่
    // เสียไปกับ round-trip ที่สองจึงคุ้มพิเศษที่จะตัดออก
    var dBatch = supabaseSelectBatch_([
      { table: "orders", query: "select=order_id&slip_status=in.(" + dPendingFilter + ")" },
      { table: "orders", query: "select=order_id,real_name,display_name,phone,items_json,total,slip_status,fulfillment,branch,address,timestamp&order=timestamp.desc&limit=300" },
    ]);
    var dPendingCount = dBatch[0].length;
    var dashSb = dBatch[1];
    var dOrdersToday = 0, dRevenueToday = 0;
    var dRecentOrders = [];
    dashSb.forEach(function(r) {
      var slip = String(r.slip_status || "");
      var ff = String(r.fulfillment || "");
      // Supabase's timestamp is UTC (e.g. "...+00:00"), unlike the Sheet's
      // already-Bangkok-local string — must convert before date-comparing,
      // a naive substring(0,10) here would be off by up to 7 hours.
      var localDate = Utilities.formatDate(new Date(r.timestamp), "Asia/Bangkok", "yyyy-MM-dd");
      if (localDate === today) {
        dOrdersToday++;
        if (slip === "ยืนยัน") dRevenueToday += Number(r.total) || 0;
      }
      var isDone = dDoneFulfillment.indexOf(ff) >= 0 || slip === "ยกเลิก";
      if (isDone) return;
      dRecentOrders.push({
        order_id: String(r.order_id || ""),
        real_name: String(r.real_name || ""),
        display_name: String(r.display_name || ""),
        phone: String(r.phone || ""),
        items_json: JSON.stringify(r.items_json || []),
        total: Number(r.total) || 0,
        slip_status: slip,
        fulfillment: ff,
        branch: String(r.branch || ""),
        address: String(r.address || ""),
        timestamp: String(r.timestamp || ""),
      });
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
    var cancelStaffName = String(params.staff_name || "").trim();
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
      restoreStock(itemsToRestore, order.branch);
      restoreCatalogLimits(itemsToRestore);
    }
    order.fulfillment = "ยกเลิก";
    // Additive, not overwriting — keeps the original slip-verification note
    // (order.notes already holds that) instead of erasing it.
    order.notes = (order.notes ? order.notes + "\n" : "") +
      "ยกเลิกโดย " + (cancelStaffName || "ไม่ระบุชื่อ") + " " + now + (cancelReason ? " เหตุผล: " + cancelReason : "");
    var uid = String(order.line_user_id || "");
    if (uid) {
      var cancelMsg;
      if (cancelReason === "duplicate") {
        cancelMsg = "❌ ออเดอร์ #" + orderId + " ถูกยกเลิก\n\n" +
          "ทีมงาน WAKA ได้รับออเดอร์แรกของคุณเรียบร้อยแล้วครับ\n" +
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
    _logStaffAction_(cancelStaffName, order.branch, "cancel_order", orderId, cancelReason || null);
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
        staff_name: String(r.staff_name || ""),
      };
    });
    return _cors(ContentService.createTextOutput(JSON.stringify({ sales: wsList })));
  }

  // ── รายงานยอดขายหน้าร้านล้วน (ไม่รวมออเดอร์ออนไลน์เลย แม้จะมารับที่สาขา) ──
  // ใช้โดยการ์ด "รายงานยอดขาย" ทั้งใบในเมนูสาขา (KPI, รายวัน, แยกสินค้า, แยก
  // สาขาตอน "ทั้งหมด") — ตามคำขอให้ตัวเลขทั้งใบสะท้อนเฉพาะยอดขายหน้าร้านจริง
  // ไม่ปนกับยอดออนไลน์ (ดู action=report สำหรับยอดรวมออนไลน์+หน้าร้านแบบเดิม
  // ที่ยังใช้อยู่ใน liff/report.html และ Streamlit)
  if (action === "walkin_product_report") {
    var wprBranch = String(params.branch || "").trim();
    var wprMonth = String(params.month || "").trim(); // "YYYY-MM"
    // branch ว่าง = โหมด "ทั้งหมด" (admin) รวมทุกสาขา เหมือน action=report —
    // ไม่เช็ค auth ตอนไม่ระบุ branch เพราะ front-end จำกัดให้เลือก "ทั้งหมด"
    // ได้เฉพาะ role admin อยู่แล้ว (ตามรูปแบบเดียวกับ action=report)
    if (wprBranch && !_branchAuthorized(params.code, wprBranch)) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));

    var wprBatch = supabaseSelectBatch_([
      { table: "catalog", query: "select=name,cost_box,cost_p" },
      { table: "walkin_sales", query: "select=branch,timestamp,items_json" + (wprBranch ? "&branch=eq." + encodeURIComponent(wprBranch) : "") },
    ]);
    var wprCostRows = wprBatch[0];
    var wprCostMap = {};
    wprCostRows.forEach(function(r) {
      if (!r.name) return;
      wprCostMap[String(r.name)] = { cost_box: Number(r.cost_box) || 0, cost_pack: Number(r.cost_p) || 0 };
    });

    var wprSales = wprBatch[1];
    var wprByProduct = {};
    var wprByDate = {};
    var wprByBranch = {};
    var wprTotalRevenue = 0, wprTotalCost = 0;
    wprSales.forEach(function(s) {
      var localDate = Utilities.formatDate(new Date(s.timestamp), "Asia/Bangkok", "yyyy-MM-dd");
      if (wprMonth && localDate.indexOf(wprMonth) !== 0) return;
      var items = Array.isArray(s.items_json) ? s.items_json : [];
      var saleRev = 0, saleCost = 0;
      items.forEach(function(it) {
        var qty = it.qty || 1;
        var c = wprCostMap[it.name] || {};
        var rev = (it.price || 0) * qty;
        var cost = (it.type === "box" ? (c.cost_box || 0) : (c.cost_pack || 0)) * qty;
        saleRev += rev;
        saleCost += cost;

        var key = it.name + "|" + it.type;
        if (!wprByProduct[key]) wprByProduct[key] = { name: it.name, type: it.type, qty: 0, cost: 0, revenue: 0 };
        wprByProduct[key].qty += qty;
        wprByProduct[key].cost += cost;
        wprByProduct[key].revenue += rev;
      });

      wprTotalRevenue += saleRev;
      wprTotalCost += saleCost;

      if (!wprByDate[localDate]) wprByDate[localDate] = { revenue: 0, cost: 0, orders: 0 };
      wprByDate[localDate].revenue += saleRev;
      wprByDate[localDate].cost += saleCost;
      wprByDate[localDate].orders++;

      var wprBr = s.branch || "ไม่ระบุ";
      if (!wprByBranch[wprBr]) wprByBranch[wprBr] = { revenue: 0, cost: 0, orders: 0 };
      wprByBranch[wprBr].revenue += saleRev;
      wprByBranch[wprBr].cost += saleCost;
      wprByBranch[wprBr].orders++;
    });

    return _cors(ContentService.createTextOutput(JSON.stringify({
      total: { revenue: wprTotalRevenue, cost: wprTotalCost, profit: wprTotalRevenue - wprTotalCost },
      by_product: Object.values(wprByProduct),
      by_date: wprByDate,
      by_branch: wprByBranch,
    })));
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

function isDuplicateSlip(ref) {
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

// ── ตรวจสลิป + จัดสถานะ (extract จาก doPost เดิม) ────────────────────────────
// เรียก SlipOK ก่อน ถ้า error fallback ไป Claude vision — คืน {slipStatus,
// slipNote, slipAmount, slipTxnId, slipDate} ตัวเดียวกับที่ doPost เคยคำนวณ
// inline ก่อนเขียนออเดอร์ — ตอนนี้ doPost เขียนออเดอร์ (สถานะ "รอตรวจ") และ
// ปล่อย lock ก่อนเรียกฟังก์ชันนี้แล้ว (ตรวจสลิปเป็น external API ช้า ไม่ควร
// ถือ lock ค้างไว้ระหว่างนั้นเพราะจะบล็อกออเดอร์อื่นที่กำลังเข้าคิว) — ผลตรวจได้
// เมื่อไหร่ doPost ค่อยเขียนทับออเดอร์อีกครั้งด้วยสถานะจริง
function _verifyAndClassifySlip_(slipBase64, orderTotal) {
  var slipStatus = "รอตรวจ";
  var slipNote   = "อ่านสลิปไม่ได้";
  var slipAmount = "";
  var slipTxnId  = "";
  var slipDate   = "";

  var verify = verifySlipWithSlipOK(slipBase64, orderTotal);
  var slipokError = verify.error || "";
  if (verify.error) verify = verifySlipWithClaude(slipBase64);
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
  } else if (slipTxnId && isDuplicateSlip(slipTxnId)) {
    slipStatus = "สลิปซ้ำ";
    slipNote   = "เลขอ้างอิง " + slipTxnId + " เคยใช้แล้ว";
  } else if (Number(verify.amount) < Number(orderTotal)) {
    slipStatus = "ยอดไม่ตรง";
    var src = isSlipOK ? "SlipOK" : "Claude";
    slipNote   = src + ": สลิป " + verify.amount + " บาท แต่ออเดอร์ " + orderTotal + " บาท" + fallbackInfo;
  } else if (isSlipOK) {
    slipStatus = "ยืนยัน";
    slipNote   = "SlipOK (QR verified): ยอดตรง " + verify.amount + " บาท, " + (verify.bank || "") + " " + (verify.date || "") + " " + (verify.to_name || "");
  } else {
    var shopAcct = _getConfigValue(null, "bank_account") || "";
    var shopNameTh = _getConfigValue(null, "bank_account_name") || "";
    var shopNameEn = _getConfigValue(null, "bank_account_name_en") || "";
    var shopNames = [];
    shopNameTh.split("|").forEach(function(n) { n = n.trim(); if (n) shopNames.push(n.toLowerCase()); });
    shopNameEn.split("|").forEach(function(n) { n = n.trim(); if (n) shopNames.push(n.toLowerCase()); });

    var amtOk = Number(verify.amount) >= Number(orderTotal);
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
    details.push("ยอด: " + (amtOk ? "✅ ตรง" : "❌ สลิป " + verify.amount + " ≠ ออเดอร์ " + orderTotal));
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
      slipNote   = (amtOk ? "✅ ยอดตรง" : "❌ ยอดไม่ตรง (สลิป " + verify.amount + " ≠ ออเดอร์ " + orderTotal + ")")
        + "\n" + (acctOk ? "✅ บัญชีตรง" : "❌ บัญชีไม่ตรง (" + (verify.to_account || "-") + ")")
        + "\n" + (nameOk ? "✅ ชื่อตรง" : "❌ ชื่อไม่ตรง (" + (verify.to_name || "-") + ")")
        + "\nadmin กรุณาเช็คแอปธนาคาร" + fallbackInfo;
    }
  }

  return { slipStatus: slipStatus, slipNote: slipNote, slipAmount: slipAmount, slipTxnId: slipTxnId, slipDate: slipDate };
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
// data: { to_branch, items: [{name, qty_box, qty_pack, qty_box_extra, qty_pack_extra}], staff_name }
function handleCreateShipment(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var staffName = String(data.staff_name || "").trim();
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var shipId = "SH" + Utilities.formatDate(new Date(), "Asia/Bangkok", "yyMMddHHmmss");

    // D4: ตรวจ duplicate shipment_id ก่อน insert
    var shExisting = supabaseSelect_("shipments", "select=shipment_id&shipment_id=eq." + encodeURIComponent(shipId));
    if (shExisting.length > 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ล็อตนี้ถูกสร้างไปแล้ว กรุณารอสักครู่แล้วลองใหม่" })));
    }

    var items = data.items || [];
    // ตัดสต็อกกลาง (catalog, Supabase-primary) — หักเฉพาะส่วน qty_box_extra/
    // qty_pack_extra (ส่วน "เผื่อ" ที่ยังไม่เคยถูกหักที่ไหนมาก่อน) เท่านั้น
    // ห้ามรวม qty_box/qty_pack (ส่วน "ออเดอร์") เข้าไปด้วย — ส่วนนั้นถูกหัก
    // คลังกลางไปแล้วตั้งแต่ตอนลูกค้าสั่งซื้อ (deductStock ใน doPost) ถ้าหักซ้ำ
    // ตรงนี้อีกที คลังกลางจะโดนหัก 2 รอบสำหรับของชิ้นเดียวกัน (พบว่าเกิดขึ้นจริง
    // ทุกครั้งที่สร้างล็อตจากยอดค้าง — ดู tools/screens/stock.py's
    // load_pending_branch_demand/_create_shipment_dialog) ทำให้ qty_box คลัง
    // กลางต่ำกว่าความเป็นจริงสะสมไปเรื่อยๆ — stock_branch ตอนรับของ
    // (handleReceiveShipment) ยังใช้ยอดรวมทั้งก้อนเหมือนเดิม เพราะของจริงต้อง
    // ไปถึงสาขาครบทั้งสองส่วน แค่คลังกลางไม่ควรถูกหักซ้ำสำหรับส่วนที่หักไปแล้ว
    var shCatRows = _fetchCatalogRows_();
    // ปิดช่องโหว่เดียวกับ doPost/handleWalkinSale — เผื่อ Streamlit ค้างฟอร์ม
    // สร้างล็อตไว้ข้ามช่วงที่มีคน rename สินค้า
    _resolveItemsAgainstCatalog_(items, shCatRows);
    var shChangedNames = [];
    for (var idx = 0; idx < items.length; idx++) {
      var it = items[idx];
      var shRow = _findCatalogRow_(shCatRows, it.name);
      if (!shRow) continue;
      var newBox = it.qty_box_extra || 0;
      var newPack = it.qty_pack_extra || 0;
      if (newBox > 0)  { shRow.qty_box  = Math.max(0, (Number(shRow.qty_box)  || 0) - newBox);  shChangedNames.push(it.name); }
      if (newPack > 0) { shRow.qty_pack = Math.max(0, (Number(shRow.qty_pack) || 0) - newPack); shChangedNames.push(it.name); }
    }

    var shObj = { shipment_id: shipId, timestamp: now, to_branch: data.to_branch || "", status: "จัดส่ง", items_json: items, received_at: null };
    writeSupabaseRow_("shipments", shObj, SUPABASE_SHIPMENTS_HEADER, "shipment_id", lock);
    if (shChangedNames.length) _pushCatalogRows_(shCatRows, shChangedNames);

    _logStaffAction_(staffName, data.to_branch, "create_shipment", shipId, null);

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, shipment_id: shipId })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── Shipment: ยกเลิกลอต + คืนสต็อกกลาง ─────────────────────────────────────
// data: { shipment_id, staff_name }
function handleCancelShipment(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var staffName = String(data.staff_name || "").trim();
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

    // คืนสต็อกกลาง (catalog, Supabase-primary) — คืนเฉพาะส่วน qty_box_extra/
    // qty_pack_extra ที่ handleCreateShipment หักไปจริงเท่านั้น (ดู comment ที่
    // นั่น) ห้ามคืนรวม qty_box/qty_pack (ส่วน "ออเดอร์") ด้วย เพราะส่วนนั้นไม่เคย
    // ถูกหักตอนสร้างล็อตนี้เลย — ออเดอร์ที่ยังไม่ส่งของสำเร็จจะกลับไปอยู่ในสถานะ
    // "ยังไม่ได้ส่ง" ตามเดิม (โผล่ใน branch_summary/load_pending_branch_demand
    // อีกครั้งให้พนักงานสร้างล็อตใหม่ทีหลัง) ไม่ต้องคืนอะไรให้คลังกลางสำหรับส่วนนั้น
    var items = Array.isArray(csTarget.items_json) ? csTarget.items_json : [];
    var csCatRows = items.length > 0 ? _fetchCatalogRows_() : null;
    var csChangedNames = [];
    if (csCatRows) {
      for (var idx = 0; idx < items.length; idx++) {
        var it = items[idx];
        var csRow = _findCatalogRow_(csCatRows, it.name);
        if (!csRow) continue;
        var totalBox = it.qty_box_extra || 0;
        var totalPack = it.qty_pack_extra || 0;
        if (totalBox > 0)  { csRow.qty_box  = (Number(csRow.qty_box)  || 0) + totalBox;  csChangedNames.push(it.name); }
        if (totalPack > 0) { csRow.qty_pack = (Number(csRow.qty_pack) || 0) + totalPack; csChangedNames.push(it.name); }
      }
    }
    var csPatchRes = patchSupabase_("shipments", "id=eq." + csTarget.id, { status: "ยกเลิก" });
    if (!csPatchRes.ok) throw new Error("Supabase shipments cancel failed: " + csPatchRes.text);
    lock.releaseLock();
    if (csChangedNames.length) _pushCatalogRows_(csCatRows, csChangedNames);
    _logStaffAction_(staffName, null, "cancel_shipment", data.shipment_id, null);
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
    bsRowsToWrite.forEach(function(r) {
      var res = pushToSupabase_("stock_branch", r);
      if (!res.ok) throw new Error("Supabase stock_branch write failed (" + r.name + "/" + r.branch + "): " + res.text);
    });

    // แจ้ง LINE เฉพาะออเดอร์ที่ "ของครบจริง" หลังรับล็อตนี้แล้วเท่านั้น — เดิมโค้ด
    // ตรงนี้ mark ออเดอร์ที่ยังไม่ส่งของสาขานี้ "ทุกใบ" เป็นพร้อมรับ โดยไม่เช็ค
    // เลยว่าของที่เพิ่งรับมาตรงกับสินค้าที่ออเดอร์นั้นสั่งหรือพอจำนวนมั้ย — ทำให้
    // ลูกค้าที่มี 2 ออเดอร์ค้างที่สาขาเดียวกันโดนแจ้ง "พร้อมรับ" พร้อมกันทั้งคู่
    // (เด้งไลน์ 2 ครั้ง) ทั้งที่จริงมีของมาแค่ชิ้นเดียว หรือแม้แต่ออเดอร์สินค้าคนละ
    // ตัวกับที่เพิ่งรับก็โดน mark ผิดไปด้วย (บั๊กเดียวกับที่เจอกับ BT11 ที่เมืองทอง)
    //
    // ตอนนี้เช็คทีละออเดอร์ว่าสต็อกสาขา (หลังบวกล็อตนี้แล้ว) พอส่งมอบ "ครบทุกชิ้น"
    // ในออเดอร์นั้นมั้ย ถ้าพอ ค่อย mark พร้อมรับ+แจ้งเตือน แล้ว "จอง" สต็อกส่วนนั้นไว้
    // ในหน่วยความจำก่อนเช็คออเดอร์ถัดไป กันไม่ให้ 2 ออเดอร์แย่งของชิ้นเดียวกันแล้ว
    // ถูกนับว่าพร้อมทั้งคู่ทั้งที่ของมีไม่พอ (เรียงตามเวลาสั่งก่อน-หลังเพื่อความยุติธรรม)
    // ออเดอร์ที่สินค้าไม่ครบยังคงสถานะเดิมไว้ก่อน ไม่ได้แจ้งอะไรผิดๆ ออกไป
    var excludedFf = ["พร้อมรับ", "บางส่วน", "รับบางส่วนแล้ว", "สาขายืนยัน", "รับแล้ว"];
    var stockLookup = {};
    bsRows.forEach(function(r) {
      stockLookup[r.name] = { qty_box: Number(r.qty_box) || 0, qty_pack: Number(r.qty_pack) || 0 };
    });
    var oMatches = supabaseSelect_("orders", "select=*&branch=eq." + encodeURIComponent(branch) + "&slip_status=eq.ยืนยัน&order=timestamp.asc");
    // ไม่ส่ง LINE แจ้งลูกค้าที่นี่แล้วตามคำขอเจ้าของร้าน (2026-08-27) — จุดนี้
    // (พนักงานกดรับของล็อตที่สาขา) จะประกาศผ่าน OpenChat แทน ยัง mark
    // fulfillment = "พร้อมรับ" ตามปกติ (ให้ระบบรู้สถานะถูกต้อง แสดงในแอดมิน/
    // liff ตามเดิม) แค่ไม่ยิง LINE ส่วนนี้ให้ลูกค้าเท่านั้น
    var readyCount = 0;
    for (var j = 0; j < oMatches.length; j++) {
      var ord = oMatches[j];
      var oFf = ord.fulfillment || "";
      if (excludedFf.indexOf(oFf) >= 0) continue;
      var ordItems = Array.isArray(ord.items_json) ? ord.items_json : [];
      var covered = ordItems.length > 0 && ordItems.every(function(it) {
        var s = stockLookup[it.name];
        var field = it.type === "box" ? "qty_box" : "qty_pack";
        return s && s[field] >= (it.qty || 1);
      });
      if (!covered) continue;
      ordItems.forEach(function(it) {
        var field = it.type === "box" ? "qty_box" : "qty_pack";
        stockLookup[it.name][field] -= (it.qty || 1);
      });
      ord.fulfillment = "พร้อมรับ";
      ord.fulfilled_at = now;
      var ordRes = pushToSupabase_("orders", ord);
      if (!ordRes.ok) throw new Error("Supabase orders write failed: " + ordRes.text);
      readyCount++;
    }

    lock.releaseLock();

    var groupStaffReceive = _getConfigValue(null, "group_staff_live");
    if (groupStaffReceive && staffName) {
      var receiveItemsText = items.map(function(it) {
        var parts = [];
        var tb = (it.qty_box || 0) + (it.qty_box_extra || 0);
        var tp = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
        if (tb > 0) parts.push("Box " + tb);
        if (tp > 0) parts.push("Pack " + tp);
        return "  - " + it.name + ": " + parts.join(", ");
      }).join("\n");
      _notifyStaffGroup_(groupStaffReceive, "📥 " + staffName + " รับของจากคลังที่สาขา " + branch + " แล้ว\nล็อต: " + data.shipment_id + "\n\n" + receiveItemsText);
    }

    _logStaffAction_(staffName, branch, "receive_shipment", data.shipment_id, null);

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now, ready_count: readyCount })));
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
    // ถ้า data.indices ส่งมา (staff เลือกเองจาก dialog) → ใช้รายการนั้นตรงๆ
    // (กรอง cancelled/handed ออกอยู่ดี กันเลือกรายการที่ทำไปแล้วซ้ำ)
    // ไม่งั้น ใช้ auto-logic เดิม: มี ready_at (partial flow) → เอาเฉพาะที่ ready_at
    // set แต่ยังไม่ handed_at, ไม่มี ready_at เลย (old order) → เอาทั้งหมดที่ยังไม่ handed_at
    var itemsToHandover;
    if (Array.isArray(data.indices) && data.indices.length > 0) {
      var idxSet = {};
      data.indices.forEach(function(i) { idxSet[i] = true; });
      itemsToHandover = items.filter(function(it, idx) {
        return idxSet[idx] && !it.cancelled_at && !it.handed_at;
      });
    } else {
      var hasReadyAt = items.some(function(it) { return !!it.ready_at; });
      itemsToHandover = items.filter(function(it) {
        if (it.cancelled_at) return false;
        if (it.handed_at) return false;
        return hasReadyAt ? !!it.ready_at : true;
      });
    }

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

    // กำหนด fulfillment ใหม่ — ส่งมอบครบแล้วถือว่า order จบทันที ไม่ต้องรอลูกค้า
    // กดยืนยันรับของอีกขั้น (ยกเลิกปุ่มนั้นไปแล้วตามคำขอเจ้าของร้าน — พนักงาน
    // เป็นคนยืนยันการส่งมอบเอง ถ้าลูกค้าไม่ได้รับจริงๆ ให้ติดต่อแอดมินแทน)
    var allDone = items.every(function(it) { return !!it.handed_at || !!it.cancelled_at; });
    var newFf = allDone ? "รับแล้ว" : "รับบางส่วนแล้ว";
    order.fulfillment = newFf;
    order.staff_confirmed_at = now;
    if (allDone) order.customer_confirmed_at = now;
    _clearDashCache();

    // แจ้งลูกค้า
    var uid = order.line_user_id || "";
    if (uid) {
      var pendingItems = items.filter(function(it) { return !it.handed_at && !it.cancelled_at; });
      var msg;
      if (allDone) {
        msg = "🎉 WAKA ได้ส่งมอบสินค้าครบทุกชิ้นตามคำสั่งซื้อแล้ว\nออเดอร์: #" + data.order_id + "\n\nขอบคุณที่อุดหนุน WAKA SPACE ครับ 🙏\n\nหากคุณยังไม่ได้รับสินค้า กรุณาติดต่อแอดมินโดยด่วน";
      } else {
        msg = "📦 ส่งมอบสินค้าบางส่วนแล้ว\nออเดอร์: #" + data.order_id + "\n\n✅ รับแล้ว:\n" +
          handoverNames.map(function(n) { return "- " + n; }).join("\n") +
          "\n\n⏳ รอสินค้า:\n" + pendingItems.map(function(it) { return "- " + it.name + " x" + it.qty; }).join("\n") +
          "\n\nหากคุณยังไม่ได้รับสินค้า กรุณาติดต่อแอดมินโดยด่วน";
      }
      _linePush(uid, msg);
      order.notified_at = now;
    }

    var groupStaffHandover = _getConfigValue(null, "group_staff_live");
    if (groupStaffHandover && staffName) {
      var custName = order.real_name || order.display_name || "";
      _notifyStaffGroup_(groupStaffHandover, "🤝 " + staffName + " ส่งมอบออเดอร์ #" + data.order_id + " ที่สาขา " + branch +
        (custName ? " ให้ " + custName : "") + " แล้ว\n" +
        handoverNames.map(function(n) { return "- " + n; }).join("\n"));
    }

    writeSupabaseOrder_(order, lock);
    _logStaffAction_(staffName, branch, "handover_order", data.order_id, newFf);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now, fulfillment: newFf })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── แจ้งพร้อมรับบางส่วน ─────────────────────────────────────────────────────
// data: { order_id, indices: [0,1,...], staff_name } — zero-based index ของ items ที่พร้อม
function handlePartialReady(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var indices = data.indices || [];
    var staffName = String(data.staff_name || "").trim();
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
      var msg = "📦 สินค้าบางรายการพร้อมรับแล้ว!\n\nออเดอร์: #" + data.order_id + "\n";
      msg += "\n✅ พร้อมรับ:\n" + readyItems.map(function(it) {
        return "- " + it.name + " x" + it.qty + (it.type === "box" ? " กล่อง" : " ซอง");
      }).join("\n");
      if (pendingItems.length > 0) {
        msg += "\n\n⏳ รอสินค้า:\n" + pendingItems.map(function(it) {
          return "- " + it.name + " x" + it.qty + (it.type === "box" ? " กล่อง" : " ซอง");
        }).join("\n");
      }
      msg += "\n\nสามารถแจ้งรับสินค้าพร้อมรับที่สาขา" + branch + " ได้เลยครับ และสินค้าอื่นๆ จะรีบแจ้งให้ทราบ เมื่อสินค้ามาถึงครับ\n" + trackUrl;
      _linePush(uid, msg);
      order.notified_at = now;
    }

    writeSupabaseOrder_(order, lock);
    _logStaffAction_(staffName, branch, "partial_ready", data.order_id, newFf);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, fulfillment: newFf })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ยกเลิกบางชิ้นในออเดอร์ ──────────────────────────────────────────────────
// data: { order_id, indices: [0,1,...], reason: "...", staff_name }
function handlePartialCancelItems(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var indices = data.indices || [];
    var reason = String(data.reason || "");
    var staffName = String(data.staff_name || "").trim();
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
    restoreStock(cancelledItems, branch);
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
    _logStaffAction_(staffName, branch, "partial_cancel_items", data.order_id, cancelledItems.length + " รายการ" + (reason ? " — " + reason : ""));
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
    var confirmStaffName = String(data.staff_name || "").trim();
    order.slip_status = "ยืนยัน";
    order.notes = "ยืนยันสลิปโดย " + (confirmStaffName || "แอดมิน (ไม่ระบุชื่อ)") + " " + now;

    var uid = order.line_user_id || "";
    var orderId = String(order.order_id || "");
    var branch = order.branch || "";
    var total = order.total || 0;
    var items = Array.isArray(order.items_json) ? order.items_json : [];
    var instantReady = _tryInstantReady_(order);

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
        message = "WAKA ยืนยันการชำระเงินแล้ว ✅\n\nออเดอร์: #" + orderId + "\n\n" + itemsText + "\n\nยอดรวม: " + total + " บาท\n" + (isDelivery ? "จัดส่งพัสดุ" : "รับที่สาขา: " + branch) + "\n\n" + (instantReady ? "สินค้าพร้อมรับที่สาขาแล้ว🎉" : "ทีมงานจะแจ้งเมื่อสินค้าพร้อมรับครับ");
      }
      _linePush(uid, message);
      if (instantReady && data.custom_message) {
        var readyTrackUrl2 = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;
        _linePush(uid, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + orderId + "\n\nดูสถานะ:\n" + readyTrackUrl2);
      }
    }

    // แจ้ง Telegram ไฟแนนซ์ด้วย — เดิมเส้นทางกดมือนี้ไม่เคยแจ้ง Telegram เลย
    // (มีแต่เส้นทางตรวจอัตโนมัติใน processPendingSlipVerifications ที่แจ้ง) ทำให้
    // ออเดอร์ที่แอดมิน/พนักงานกดยืนยันเองก่อน trigger จะไปถึง ไม่มีร่องรอยใน
    // Telegram เลย — เพิ่มให้ครบทุกเส้นทางที่สลิปกลายเป็น "ยืนยัน"
    if (TELEGRAM_FINANCE_CHAT_ID) {
      var itemsSummaryConfirm = items.map(function(i) {
        var u = i.type === "box" ? "กล่อง" : "ซอง";
        return "  - " + i.name + " (" + u + ") x" + (i.qty || 1);
      }).join("\n");
      var finMsgConfirm = "✅ ยืนยันสลิปโดยแอดมิน #" + orderId
        + "\nลูกค้า: " + (order.display_name || "") + (order.real_name ? " (" + order.real_name + ")" : "")
        + "\nสาขา: " + (branch || "")
        + "\nยอด: " + total + " บาท"
        + "\n\n" + itemsSummaryConfirm
        + "\n\n👤 ยืนยันโดย: " + (confirmStaffName || "ไม่ระบุชื่อ");
      _telegramPush(TELEGRAM_FINANCE_CHAT_ID, finMsgConfirm);
    }

    writeSupabaseOrder_(order, lock);
    _logStaffAction_(confirmStaffName, branch, "confirm_slip", orderId, null);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  } finally {
    // writeSupabaseOrder_ already released the lock on the success path —
    // this is a safety-net re-release for the early-return/error paths
    // above that never reached that call, and is a harmless no-op if the
    // lock is already free.
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

    // idempotent — ปฏิเสธซ้ำ (เช่น กดปุ่มซ้ำก่อนหน้ารีเฟรช) ต้องไม่คืนสต็อก/limit ซ้ำ
    if (order.slip_status === "ยกเลิก") {
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
    }

    var orderId = String(order.order_id || "");
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var reason = String(data.reason || "").trim();
    var rejectStaffName = String(data.staff_name || "").trim();
    var note = "ปฏิเสธสลิปโดย " + (rejectStaffName || "แอดมิน (ไม่ระบุชื่อ)") + " " + now + (reason ? " (" + reason + ")" : "");

    // คืนสต็อก/limit ที่หักไปตั้งแต่ตอนสร้างออเดอร์ (doPost หักทันทีไม่ว่าสลิปจะ
    // ตรวจผ่านหรือไม่) — เดิมฟังก์ชันนี้เปลี่ยนแค่ slip_status ไม่คืนอะไรเลย ทำให้
    // limit_box ของสินค้าพรีออเดอร์ (เช่นลูกค้าส่งสลิปซ้ำแล้วโดนปฏิเสธ) หายไป
    // ถาวรทั้งที่ไม่มีใครได้ของจริง — คืนเฉพาะ item ที่ยังไม่ส่งมอบลูกค้า (กัน
    // double restore กับออเดอร์ที่ส่งมอบไปแล้วบางส่วนก่อนถูกปฏิเสธสลิปทีหลัง)
    // เหมือน action=cancel_order ที่ทำอยู่แล้ว
    var itemsToRestore = (Array.isArray(order.items_json) ? order.items_json : []).filter(function(it) { return !it.handed_at; });
    if (itemsToRestore.length > 0) {
      restoreStock(itemsToRestore, order.branch);
      restoreCatalogLimits(itemsToRestore);
    }

    order.slip_status = "ยกเลิก";
    order.notes = note;

    var uid = order.line_user_id || "";
    if (uid && uid !== "dev_user") {
      var reasonLine = reason ? "\nเหตุผล: " + reason : "";
      var msg = "🙏 แอดมินขออนุญาตยกเลิกออเดอร์ #" + orderId + " หากมีข้อสงสัยหรือต้องการสอบถามเพิ่มเติม ติดต่อแอดมินได้เลยครับ" + reasonLine +
        "\n\nขออภัยลูกค้าด้วยนะครับ ขอบคุณครับ 💛";
      _linePush(uid, msg);
    }

    // แจ้ง Telegram ไฟแนนซ์ด้วย — เหตุผลเดียวกับ handleConfirmSlip ด้านบน
    if (TELEGRAM_FINANCE_CHAT_ID) {
      var itemsSummaryReject = (Array.isArray(order.items_json) ? order.items_json : []).map(function(i) {
        var u = i.type === "box" ? "กล่อง" : "ซอง";
        return "  - " + i.name + " (" + u + ") x" + (i.qty || 1);
      }).join("\n");
      var finMsgReject = "❌ ปฏิเสธ/ยกเลิกสลิปโดยแอดมิน #" + orderId
        + "\nลูกค้า: " + (order.display_name || "") + (order.real_name ? " (" + order.real_name + ")" : "")
        + "\nสาขา: " + (order.branch || "")
        + "\nยอด: " + (order.total || 0) + " บาท"
        + "\n\n" + itemsSummaryReject
        + (reason ? "\n\nเหตุผล: " + reason : "")
        + "\n\n👤 โดย: " + (rejectStaffName || "ไม่ระบุชื่อ");
      _telegramPush(TELEGRAM_FINANCE_CHAT_ID, finMsgReject);
    }

    writeSupabaseOrder_(order, lock);
    _logStaffAction_(rejectStaffName, order.branch, "reject_slip", orderId, reason || null);
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

// ── เพิ่ม/ลด สต็อกสินค้าเดิม (ปรับยอดนับ/แก้ยอดผิด) ──
// ไม่ใช่ที่สำหรับบันทึกการซื้อ — ดู handleRecordPurchase/handleReceivePurchase
// data: { name, add_box, add_pack, reason, staff_name }
function handleAddStock(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var staffName = String(data.staff_name || "").trim();
    var reason = String(data.reason || "").trim();
    var row = _resolveProductRow_(data.name, data.id);
    if (!row) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้าใน catalog: " + data.name })));
    }
    if (data.add_box)  row.qty_box  = (Number(row.qty_box)  || 0) + Number(data.add_box);
    if (data.add_pack) row.qty_pack = (Number(row.qty_pack) || 0) + Number(data.add_pack);
    if (data.limit_box !== undefined && data.limit_box !== null) row.limit_box = Number(data.limit_box);
    if (data.limit_pack !== undefined && data.limit_pack !== null) row.limit_pack = Number(data.limit_pack);
    _clearCatalogCache_();
    writeSupabaseRow_("catalog", row, SUPABASE_CATALOG_HEADER, "name", lock);
    var addStockDetail = (data.add_box ? (Number(data.add_box) > 0 ? "+" : "") + data.add_box + " กล่อง " : "") +
      (data.add_pack ? (Number(data.add_pack) > 0 ? "+" : "") + data.add_pack + " ซอง" : "");
    if (reason) addStockDetail = (addStockDetail || "").trim() + " — " + reason;
    // target_id = รหัสสินค้า (คงที่แม้เปลี่ยนชื่อทีหลัง) ไม่ใช่ชื่อสินค้า — กัน
    // ประวัติเข้า-ออกสินค้าใน Streamlit หลุดหายไปเวลามีการเปลี่ยนชื่อสินค้า
    // (fallback เป็นชื่อถ้าแถวไม่มี id ด้วยเหตุผลใดก็ตาม)
    _logStaffAction_(staffName, null, "add_stock", row.id || data.name, addStockDetail || null);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function _genPurchaseId() {
  var now = new Date();
  var pad = function(n) { return String(n).padStart(2, "0"); };
  var yy = String(now.getFullYear()).slice(-2);
  var prefix = "PO" + yy + pad(now.getMonth() + 1) + pad(now.getDate());
  var propKey = "purchase_seq_" + prefix;
  var seq = parseInt(PROPS.getProperty(propKey) || "0", 10) + 1;
  PROPS.setProperty(propKey, String(seq));
  return prefix + String(seq).padStart(3, "0");
}

// ── บันทึกการซื้อสินค้าเข้า (ค่าใช้จ่าย/ใบสั่งซื้อ) — หลายรายการต่อครั้ง พร้อม
// ผู้ขาย/เอกสาร/ยอดจ่ายจริง (รองรับมัดจำ — amount_paid น้อยกว่า total_cost ได้) ──
// จงใจ "ไม่" แตะ catalog.qty_box/qty_pack ที่นี่ — การสั่งซื้อ/จ่ายเงินกับของจริง
// มาถึงคลังเป็นคนละเหตุการณ์กัน (สั่งแล้วจ่ายมัดจำไว้ก่อน ของค่อยตามมาทีหลังก็
// มี) เหมือน shipments ที่ create → received แยกขั้นตอนกัน — สร้างแถวนี้ไว้เป็น
// สถานะ "รอสินค้า" ก่อนเสมอ ต้องเรียก handleReceivePurchase อีกทีตอนของมาถึงจริง
// ค่อยเพิ่มสต็อกคลังกลาง ต่างจาก handleAddStock (ปุ่ม "เพิ่ม/ลด สต็อกคลังกลาง"
// เดิม) ตรงที่นี่คือ "รายการซื้อ" แบบมีโครงสร้าง เก็บลงตาราง purchases แยก
// ต่างหาก (ใช้ทำรายงานซื้อเข้ารายวัน/รายเดือนได้) — handleAddStock ยังอยู่
// เหมือนเดิมสำหรับแก้ยอดนับผิด/ปรับสต็อกเร็วๆ ที่ไม่ใช่การซื้อจริง
// data: { supplier, doc_no, notes, amount_paid, staff_name,
//         items: [{ name, id, qty_box, qty_pack, cost_box, cost_pack }] }
// cost_box/cost_pack ที่เว้นว่างไว้ = ใช้ต้นทุนปัจจุบันของสินค้านั้น (ไม่บังคับ
// กรอกใหม่ทุกครั้งถ้าราคาซื้อไม่เปลี่ยน) — แต่ถ้ากรอกมา จะอัปเดต catalog.cost_box/
// cost_p ให้เป็นราคาล่าสุดด้วยเช่นกัน (รู้ราคาที่จ่ายได้ตั้งแต่สั่งซื้อ ไม่ต้องรอ
// ของมาถึงก่อนถึงจะอัปเดตต้นทุนได้ — ไม่กระทบมูลค่าสต็อกเพราะ qty ยังไม่ขยับ)
function handleRecordPurchase(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var staffName = String(data.staff_name || "").trim();
    var supplier = String(data.supplier || "").trim();
    var docNo = String(data.doc_no || "").trim();
    var notes = String(data.notes || "").trim();
    var items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีรายการสินค้า" })));
    }

    var catRows = _fetchCatalogRows_();
    _resolveItemsAgainstCatalog_(items, catRows);

    var purchaseItems = [];
    var changedNames = [];
    var totalCost = 0;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qtyBox = Number(it.qty_box) || 0;
      var qtyPack = Number(it.qty_pack) || 0;
      if (qtyBox <= 0 && qtyPack <= 0) continue;
      var row = _findCatalogRow_(catRows, it.name);
      if (!row) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + it.name })));
      }
      var costBox = (it.cost_box === undefined || it.cost_box === "" || it.cost_box === null) ? (Number(row.cost_box) || 0) : Number(it.cost_box);
      var costPack = (it.cost_pack === undefined || it.cost_pack === "" || it.cost_pack === null) ? (Number(row.cost_p) || 0) : Number(it.cost_pack);
      var subtotal = qtyBox * costBox + qtyPack * costPack;

      // อัปเดตเฉพาะต้นทุน (ราคาที่ตกลงซื้อ) ที่นี่ — ไม่แตะ qty_box/qty_pack
      // จนกว่าจะรับของจริงผ่าน handleReceivePurchase
      if (it.cost_box !== undefined && it.cost_box !== "" && it.cost_box !== null) { row.cost_box = costBox; changedNames.push(row.name); }
      if (it.cost_pack !== undefined && it.cost_pack !== "" && it.cost_pack !== null) { row.cost_p = costPack; changedNames.push(row.name); }

      purchaseItems.push({ name: row.name, id: row.id || null, qty_box: qtyBox, qty_pack: qtyPack, cost_box: costBox, cost_pack: costPack, subtotal: subtotal });
      totalCost += subtotal;
    }
    if (purchaseItems.length === 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีรายการที่ใส่จำนวนไว้" })));
    }

    if (changedNames.length) {
      _clearCatalogCache_();
      _pushCatalogRows_(catRows, changedNames);
    }

    var purchaseId = _genPurchaseId();
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    // ไม่ระบุ amount_paid มา = ถือว่าจ่ายเต็มจำนวน (กรณีปกติส่วนใหญ่) — ใส่มาเฉพาะ
    // ตอนจ่ายมัดจำ/ยังไม่จ่ายเลย
    var amountPaid = (data.amount_paid === undefined || data.amount_paid === "" || data.amount_paid === null)
      ? totalCost
      : Math.max(0, Math.min(Number(data.amount_paid) || 0, totalCost));

    var purchaseObj = {
      purchase_id: purchaseId, timestamp: now, supplier: supplier || null, doc_no: docNo || null,
      items_json: purchaseItems, total_cost: totalCost, amount_paid: amountPaid,
      status: "รอสินค้า", received_at: null,
      staff_name: staffName || null, notes: notes || null,
    };
    writeSupabaseRow_("purchases", purchaseObj, SUPABASE_PURCHASES_HEADER, "purchase_id", lock);

    var payNote = amountPaid < totalCost ? (" (จ่ายแล้ว ฿" + amountPaid + " จาก ฿" + totalCost + ")") : "";
    _logStaffAction_(staffName, null, "record_purchase", purchaseId, "ผู้ขาย: " + (supplier || "-") + " | ยอดรวม: ฿" + totalCost + payNote);

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, purchase_id: purchaseId, total_cost: totalCost, amount_paid: amountPaid })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── รับของเข้าคลังกลางจริง สำหรับใบซื้อที่บันทึกไว้ก่อนหน้า ──────────────────
// ตอนนี้เองที่ catalog.qty_box/qty_pack ถึงจะเพิ่มขึ้นจริง — แยกจาก
// handleRecordPurchase โดยตั้งใจ (ดู comment ด้านบน) idempotent: เรียกซ้ำกับ
// ใบที่ "รับแล้ว" ไปแล้วไม่ทำอะไรเพิ่ม (กันกดซ้ำเพิ่มสต็อกซ้ำ)
// data: { purchase_id, staff_name, release_online_limit }
// release_online_limit (optional): สำหรับสินค้าที่เปิดขายพรีออเดอร์ไว้ก่อนของมา
// (ตั้ง limit_box ไว้ต่ำกว่าที่จะได้จริง เพราะตอนนั้น qty_box=0) — พอของมาจริง
// ยก limit_box/limit_pack ขึ้นให้เท่ากับ qty_box/qty_pack ใหม่ (เฉพาะกรณีเดิม
// ต่ำกว่าเท่านั้น ไม่มีวันลดลง) ทำให้ขายออนไลน์ + เบิกไปสาขา ใช้สต็อกก้อนเดียวกัน
// เต็มที่ ไม่ติดเพดานเก่าที่ตั้งไว้ตอนพรีออเดอร์อีกต่อไป
function handleReceivePurchase(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var purchaseId = String(data.purchase_id || "").trim();
    var staffName = String(data.staff_name || "").trim();
    var releaseLimit = !!data.release_online_limit;
    if (!purchaseId) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing purchase_id" })));
    }
    var rows = supabaseSelect_("purchases", "select=id,status,supplier,items_json&purchase_id=eq." + encodeURIComponent(purchaseId) + "&limit=1");
    var row = rows[0];
    if (!row) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบใบซื้อ: " + purchaseId })));
    }
    if (String(row.status) === "รับแล้ว") {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
    }

    var items = Array.isArray(row.items_json) ? row.items_json : [];
    var catRows = _fetchCatalogRows_();
    var changedNames = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var qtyBox = Number(it.qty_box) || 0;
      var qtyPack = Number(it.qty_pack) || 0;
      if (qtyBox <= 0 && qtyPack <= 0) continue;
      var catRow = it.id ? _findCatalogRowById_(catRows, it.id) : _findCatalogRow_(catRows, it.name);
      if (!catRow) continue; // สินค้าถูกลบไปแล้วตั้งแต่สั่งซื้อ — ข้ามรายการนี้ ไม่ทำทั้งคำขอพัง
      catRow.qty_box = (Number(catRow.qty_box) || 0) + qtyBox;
      catRow.qty_pack = (Number(catRow.qty_pack) || 0) + qtyPack;
      if (releaseLimit) {
        if (catRow.limit_box !== null && catRow.limit_box !== undefined && catRow.limit_box !== "" && Number(catRow.limit_box) < catRow.qty_box) {
          catRow.limit_box = catRow.qty_box;
        }
        if (catRow.limit_pack !== null && catRow.limit_pack !== undefined && catRow.limit_pack !== "" && Number(catRow.limit_pack) < catRow.qty_pack) {
          catRow.limit_pack = catRow.qty_pack;
        }
        // ของถึงจริงแล้ว + ปลดล็อกยอดขายในตาเดียวกัน — ถือเป็นช่วงเวลาที่พนักงาน
        // ตั้งใจประกาศว่าสินค้านี้ "พร้อมส่ง" แล้ว ไม่ต้องไปเปิดหน้าสินค้าแยกอีกที
        if (catRow.status === "preorder") catRow.status = "ready";
      }
      changedNames.push(catRow.name);
    }
    if (changedNames.length) {
      _clearCatalogCache_();
      _pushCatalogRows_(catRows, changedNames);
    }

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var patchRes = patchSupabase_("purchases", "id=eq." + row.id, { status: "รับแล้ว", received_at: now });
    if (!patchRes.ok) throw new Error("Supabase purchases receive failed: " + patchRes.text);
    lock.releaseLock();

    _logStaffAction_(staffName, null, "receive_purchase", purchaseId, "รับของเข้าคลังกลาง — ผู้ขาย: " + (row.supplier || "-"));

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── บันทึกจ่ายเงินเพิ่มสำหรับรายการซื้อที่มัดจำ/ค้างไว้ ──────────────────────
// data: { purchase_id, add_amount, staff_name }
function handleRecordPurchasePayment(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var purchaseId = String(data.purchase_id || "").trim();
    var addAmount = Number(data.add_amount) || 0;
    var staffName = String(data.staff_name || "").trim();
    if (!purchaseId || addAmount <= 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ (purchase_id, add_amount)" })));
    }
    var rows = supabaseSelect_("purchases", "select=id,total_cost,amount_paid&purchase_id=eq." + encodeURIComponent(purchaseId) + "&limit=1");
    var row = rows[0];
    if (!row) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบรายการซื้อ: " + purchaseId })));
    }
    var totalCost = Number(row.total_cost) || 0;
    var newPaid = Math.min(totalCost, (Number(row.amount_paid) || 0) + addAmount);
    var patchRes = patchSupabase_("purchases", "id=eq." + row.id, { amount_paid: newPaid });
    if (!patchRes.ok) throw new Error("Supabase purchases payment update failed: " + patchRes.text);
    lock.releaseLock();

    _logStaffAction_(staffName, null, "purchase_payment", purchaseId, "จ่ายเพิ่ม ฿" + addAmount + " (รวมจ่ายแล้ว ฿" + newPaid + " จาก ฿" + totalCost + ")");

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, amount_paid: newPaid })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เพิ่มสินค้าใหม่ใน catalog ──
// data: { name, category, price_box, price_pack, cost_box, cost_pack, barcode, initial_box, initial_pack, status, staff_name }
// status: "preorder" | "ready" — ค่าเริ่มต้น "preorder" ถ้าไม่ส่งมา เพราะสินค้า
// ใหม่ที่สร้างผ่านหน้า "รับสินค้าเข้าคลัง" (โหมด "+ เพิ่มสินค้าใหม่") จะเริ่มด้วย
// qty_box/pack = 0 เสมอ (ของจริงเข้าทีหลังตอนกด "รับของเข้าคลัง") — ตั้ง "ready"
// ไว้ตั้งแต่ตอนที่ยังไม่มีสต็อกจะหลุด safety check (stock=0 ข้ามการตรวจสต็อกไป
// เฉยๆ) — active ได้จาก status เสมอ กันสองฟิลด์นี้หลุด sync กัน (ดู comment
// เดียวกันใน handleUpdateProduct)
function handleAddProduct(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var staffName = String(data.staff_name || "").trim();
    var existing = getSupabaseRow_("catalog", "name", data.name);
    if (existing) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "สินค้าชื่อนี้มีอยู่แล้ว" })));
    }

    var limBox = (data.limit_box === "" || data.limit_box === undefined || data.limit_box === null) ? null : Number(data.limit_box);
    var limPack = (data.limit_pack === "" || data.limit_pack === undefined || data.limit_pack === null) ? null : Number(data.limit_pack);
    var newStatus = data.status === "ready" ? "ready" : "preorder";

    // Next sequential product code (P0001, P0002, ...). The id=not.is.null
    // filter matters — Postgres sorts NULL first on DESC, so without it this
    // would misread as "no ids yet" during the one-time backfill window.
    var idRows = supabaseSelect_("catalog", "select=id&id=not.is.null&order=id.desc&limit=1");
    var lastN = (idRows[0] && /^P(\d+)$/.test(idRows[0].id)) ? parseInt(idRows[0].id.slice(1), 10) : 0;
    var newId = "P" + String(lastN + 1).padStart(4, "0");

    var newRow = {
      name: data.name, id: newId, category: data.category || "", slug: data.slug || "",
      cost_box: Number(data.cost_box) || 0, cost_p: Number(data.cost_pack) || 0,
      price_box: Number(data.price_box) || 0, price_pack: Number(data.price_pack) || 0,
      qty_box: Number(data.initial_box) || 0, qty_pack: Number(data.initial_pack) || 0,
      limit_box: limBox, limit_pack: limPack, active: "TRUE", status: newStatus,
      image_url: data.image_url || "", barcode: data.barcode || "", notice: "",
      packs_per_box: (data.packs_per_box === "" || data.packs_per_box === undefined || data.packs_per_box === null) ? null : Number(data.packs_per_box),
    };
    _clearCatalogCache_();
    writeSupabaseRow_("catalog", newRow, SUPABASE_CATALOG_HEADER, "name", lock);
    // target_id = รหัสสินค้า (id), ไม่ใช่ชื่อ — ดู comment เดียวกันใน handleAddStock
    _logStaffAction_(staffName, null, "add_product", newId, "ชื่อ: " + newRow.name);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, id: newId, name: newRow.name })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// `catalog` has no edited_by/history column (adding one is a bigger schema
// decision, out of scope here) — so price/cost/limit/active changes are
// logged to the group_staff LINE chat instead, giving at least a
// searchable trail of who changed what and by how much. staff_name is
// optional (Streamlit doesn't have per-user accounts yet), so an
// unattributed edit still goes through — just logged as "ไม่ระบุชื่อ".
function handleUpdateProduct(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // id-first: Streamlit ส่ง data.id มาด้วยตอนนี้ (แถวที่เลือกไว้ตอนเปิดฟอร์ม) —
    // ถ้ามีคนอื่น rename สินค้านี้ไปแล้วระหว่างที่ฟอร์มเปิดค้างอยู่ data.name จะ
    // เก่า แต่ id ไม่เปลี่ยน จึงยังหาแถวที่ถูกต้องเจอ (ไม่ fallback ผิดสินค้า)
    var row = _resolveProductRow_(data.name, data.id);
    if (!row) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + data.name }))); }
    var currentName = row.name;

    var staffName = String(data.staff_name || "").trim();
    var changeLog = [];
    var logNumField = function(field, label, newVal) {
      var oldVal = Number(row[field]) || 0;
      if (newVal !== oldVal) changeLog.push(label + ": " + oldVal + " → " + newVal);
    };

    var newName = String(data.new_name || "").trim();
    var renameLog = "";
    if (newName && newName !== currentName) {
      var dup = getSupabaseRow_("catalog", "name", newName);
      if (dup) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "มีสินค้าชื่อนี้อยู่แล้ว" }))); }
      var renameRes = _renameProductRpc_(currentName, newName);
      if (!renameRes.ok) { lock.releaseLock(); throw new Error("เปลี่ยนชื่อสินค้าไม่สำเร็จ: " + renameRes.text); }
      _renameHistoricalItemsJson_("shipments", "id", currentName, newName);
      _renameHistoricalItemsJson_("orders", "order_id", currentName, newName);
      _renameHistoricalItemsJson_("walkin_sales", "sale_id", currentName, newName);
      // withdrawals/stock_returns เป็นตาราง flat (name เป็น column ตรงๆ ไม่ใช่
      // items_json array) — patch ด้วย filter ตรงๆ ทีเดียวได้เลย ไม่ต้องวนอ่าน/
      // เขียนทีละแถวแบบ items_json ด้านบน
      patchSupabase_("withdrawals", "name=eq." + encodeURIComponent(currentName), { name: newName });
      patchSupabase_("stock_returns", "name=eq." + encodeURIComponent(currentName), { name: newName });
      // เก็บแยกจาก changeLog เดิม — log เป็น action ของตัวเอง (rename_product)
      // แทนที่จะรวมกับ update_product ทั่วไป จะได้เด่นชัดในประวัติสินค้า
      renameLog = currentName + " → " + newName;
      row.name = newName;
    }

    if (data.category !== undefined) row.category = data.category;
    if (data.cost_box !== undefined) { logNumField("cost_box", "ต้นทุน/กล่อง", Number(data.cost_box) || 0); row.cost_box = Number(data.cost_box) || 0; }
    if (data.cost_pack !== undefined) { logNumField("cost_p", "ต้นทุน/ซอง", Number(data.cost_pack) || 0); row.cost_p = Number(data.cost_pack) || 0; }
    if (data.price_box !== undefined) { logNumField("price_box", "ราคา/กล่อง", Number(data.price_box) || 0); row.price_box = Number(data.price_box) || 0; }
    if (data.price_pack !== undefined) { logNumField("price_pack", "ราคา/ซอง", Number(data.price_pack) || 0); row.price_pack = Number(data.price_pack) || 0; }
    if (data.limit_box !== undefined) row.limit_box = data.limit_box === "" ? null : Number(data.limit_box);
    if (data.limit_pack !== undefined) row.limit_pack = data.limit_pack === "" ? null : Number(data.limit_pack);
    if (data.packs_per_box !== undefined) row.packs_per_box = data.packs_per_box === "" ? null : Number(data.packs_per_box);
    // status ("preorder"/"ready"/"inactive") คือฟิลด์เดียวที่พนักงานตั้งเองตอนนี้
    // (แทนที่ checkbox เปิดขาย/ปิดขายเดิม) — active ("TRUE"/"FALSE") ยังอยู่เพราะ
    // มีจุดอื่นอ่านอยู่ (เช่น doGet's ตัวกรองแคตตาล็อกลูกค้า) แต่ derive มาจาก
    // status เสมอในคำขอเดียวกัน กันสองฟิลด์นี้หลุด sync กัน
    var statusLabels = { preorder: "พรีออเดอร์", ready: "พร้อมส่ง", inactive: "ไม่ขายแล้ว" };
    if (data.status !== undefined && statusLabels[data.status]) {
      if (row.status !== data.status) changeLog.push("สถานะ: " + statusLabels[data.status]);
      row.status = data.status;
      row.active = data.status === "inactive" ? "FALSE" : "TRUE";
    } else if (data.active !== undefined) {
      // legacy path — เผื่อ client เก่าที่ยังไม่ได้อัปเดตยังส่งแค่ active มาตรงๆ
      var newActive = data.active ? "TRUE" : "FALSE";
      if (String(row.active).toUpperCase() !== newActive) changeLog.push("สถานะ: " + (data.active ? "เปิดขาย" : "ปิดขาย"));
      row.active = newActive;
    }
    if (data.image_url !== undefined) row.image_url = data.image_url || "";
    if (data.barcode !== undefined) row.barcode = data.barcode || "";
    if (data.notice !== undefined) row.notice = data.notice || "";
    if (data.slug !== undefined) row.slug = data.slug || "";
    _clearCatalogCache_();
    writeSupabaseRow_("catalog", row, SUPABASE_CATALOG_HEADER, "name", lock);

    // target_id = รหัสสินค้า (id) เสมอ — คงที่แม้ชื่อเพิ่งเปลี่ยนไปข้างบน ทำให้
    // ประวัติของสินค้าเดียวกัน (ทั้ง rename และแก้ไขฟิลด์อื่น) รวมกันได้ถูกต้อง
    // แม้ผ่านการเปลี่ยนชื่อหลายรอบ ไม่หลุดหายไปหาด้วยชื่อเก่า
    var logTargetId = row.id || row.name;
    if (renameLog) {
      _logStaffAction_(staffName, null, "rename_product", logTargetId, renameLog);
    }
    if (changeLog.length > 0) {
      _logStaffAction_(staffName, null, "update_product", logTargetId, changeLog.join("; "));
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ลบสินค้าออกจากแคตตาล็อกถาวร ─────────────────────────────────────────────
// data: { name, staff_name }
// บล็อกถ้ายังมีสต็อกเหลือ (คลังกลางหรือสาขาใดก็ตาม) กันสต็อกที่ยังมีมูลค่าจริง
// หายไปเงียบๆ — ต้องเคลียร์ยอดให้เป็น 0 ก่อนถึงจะลบได้
function handleDeleteProduct(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var name = String(data.name || "").trim();
    var row = _resolveProductRow_(name, data.id);
    if (!row) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + name }))); }
    name = row.name; // ชื่อปัจจุบันจริง เผื่อ dialog ค้างไว้ข้ามช่วง rename

    var centralQty = (Number(row.qty_box) || 0) + (Number(row.qty_pack) || 0);
    if (centralQty > 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ยังมีสต็อกคลังกลางเหลือ (" + centralQty + ") ต้องเคลียร์ให้เป็น 0 ก่อนลบ" })));
    }

    var branchRows = _fetchStockBranchRows_(null).filter(function (r) { return String(r.name).trim() === name; });
    var branchQty = branchRows.reduce(function (sum, r) { return sum + (Number(r.qty_box) || 0) + (Number(r.qty_pack) || 0); }, 0);
    if (branchQty > 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ยังมีสต็อกค้างที่สาขา (รวม " + branchQty + ") ต้องเคลียร์ให้เป็น 0 ก่อนลบ" })));
    }

    var delRes = deleteSupabase_("catalog", "name=eq." + encodeURIComponent(name));
    if (!delRes.ok) { lock.releaseLock(); throw new Error("ลบสินค้าไม่สำเร็จ: " + delRes.text); }

    // แถว stock_branch ที่เหลือ (ยอด 0 ทุกสาขาอยู่แล้ว) ไม่มีประโยชน์ต่อ — ลบทิ้งด้วยกัน
    if (branchRows.length) deleteSupabase_("stock_branch", "name=eq." + encodeURIComponent(name));

    _clearCatalogCache_();
    _logStaffAction_(String(data.staff_name || "").trim(), null, "delete_product", row.id || name, "ชื่อ: " + name);
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
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
    // resolve id-first ก่อนทำอะไรทั้งหมด แล้วใช้ชื่อปัจจุบันจากผลลัพธ์แทน `name`
    // ดิบที่ client ส่งมา — ปิดช่องโหว่ฟอร์มค้างไว้ข้ามช่วง rename เหมือนจุดอื่นๆ
    var wCatRow = _resolveProductRow_(name, data.id);
    if (wCatRow) name = wCatRow.name;

    var bsRow = _findStockBranchRow_(_fetchStockBranchRows_(branch), name, branch);
    if (!bsRow) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch })));
    }
    var wField = type === "box" ? "qty_box" : "qty_pack";
    var wHave = Number(bsRow[wField]) || 0;
    if (qty > wHave) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: name + " สต็อกสาขาไม่พอ (เหลือ " + wHave + ")" })));
    }
    bsRow[wField] = wHave - qty;
    _writeStockBranchRow_(bsRow);

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var wObj = { timestamp: now, branch: branch, name: name, type: type, qty: qty, reason: reason };
    var wRes = pushToSupabase_("withdrawals", wObj);
    if (!wRes.ok) throw new Error("Supabase withdrawals write failed: " + wRes.text);
    lock.releaseLock();

    var groupStaffWithdraw = _getConfigValue(null, "group_staff_live");
    if (groupStaffWithdraw && staffName) {
      var unitLabel = type === "box" ? "กล่อง" : "ซอง";
      _notifyStaffGroup_(groupStaffWithdraw, "📤 " + staffName + " เบิก " + name + " x" + qty + " " + unitLabel + " จากสาขา " + branch +
        (reason ? "\nเหตุผล: " + reason : ""));
    }

    _logStaffAction_(staffName, branch, "withdraw_stock", (wCatRow && wCatRow.id) || name, qty + (type === "box" ? " กล่อง" : " ซอง") + (reason ? " — " + reason : ""));

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ปรับยอดนับสต็อกสาขาโดยตรง (นับจริงไม่ตรงกับระบบ) ──────────────────────
// ต่างจาก handleWithdrawStock ตรงที่ปรับได้ทั้งขึ้น/ลง (ไม่ได้แปลว่าของ "เบิก
// ออกไปจริง" เสมอไป — อาจเป็นแก้ยอดนับผิด/นับเจอของเพิ่ม) เหมือน handleAddStock
// ฝั่งคลังกลาง แต่สโคปเป็นรายสาขา (stock_branch) ไม่ใช่ catalog
// data: { branch, name, id, add_box, add_pack, reason, staff_name, code }
function handleAdjustBranchStock(data) {
  var branch = String(data.branch || "").trim();
  var staffName = String(data.staff_name || "").trim();
  var addBox = Number(data.add_box) || 0;
  var addPack = Number(data.add_pack) || 0;
  if (!branch || (addBox === 0 && addPack === 0)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ (branch, จำนวนที่จะปรับ)" })));
  }
  if (!_branchAuthorized(data.code, branch)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var catRow = _resolveProductRow_(data.name, data.id);
    var name = catRow ? catRow.name : String(data.name || "").trim();

    var bsRow = _findStockBranchRow_(_fetchStockBranchRows_(branch), name, branch);
    if (!bsRow) {
      bsRow = { name: name, category: (catRow && catRow.category) || "", branch: branch, qty_box: 0, qty_pack: 0 };
    }
    var newBox = Math.max(0, (Number(bsRow.qty_box) || 0) + addBox);
    var newPack = Math.max(0, (Number(bsRow.qty_pack) || 0) + addPack);
    bsRow.qty_box = newBox;
    bsRow.qty_pack = newPack;
    _writeStockBranchRow_(bsRow);
    lock.releaseLock();

    var reason = String(data.reason || "").trim();
    var adjDetail = ((addBox ? (addBox > 0 ? "+" : "") + addBox + " กล่อง " : "") +
      (addPack ? (addPack > 0 ? "+" : "") + addPack + " ซอง" : "")).trim();
    var adjLog = adjDetail + (reason ? " — " + reason : "");

    _logStaffAction_(staffName, branch, "adjust_branch_stock", (catRow && catRow.id) || name, adjLog || null);

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, qty_box: newBox, qty_pack: newPack })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── แปลงกล่อง → ซอง: เบิกกล่องแยกเป็นซองแทน ──────────────────────────────────
// อาศัย catalog.packs_per_box (ตั้งค่าต่อสินค้าที่หน้าแก้ไขสินค้า) เป็นอัตราส่วน
// คงที่ — คำนวณจำนวนซองที่ได้อัตโนมัติจาก qty_box x อัตราส่วนนี้ ไม่ต้องกรอกเอง
// data: { name, id, branch (ว่าง/ไม่ส่ง = คลังกลาง), qty_box, staff_name, code }
function handleConvertBoxToPack(data) {
  var branch = String(data.branch || "").trim();
  var qtyBox = Number(data.qty_box) || 0;
  var staffName = String(data.staff_name || "").trim();
  if (qtyBox <= 0) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ใส่จำนวนกล่องที่จะแปลง" })));
  }
  if (branch && !_branchAuthorized(data.code, branch)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var catRow = _resolveProductRow_(data.name, data.id);
    if (!catRow) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + data.name })));
    }
    var perBox = Number(catRow.packs_per_box) || 0;
    if (perBox <= 0) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "สินค้านี้ยังไม่ได้ตั้งค่า \"จำนวนซองต่อกล่อง\" — ตั้งค่าที่หน้าแก้ไขสินค้าก่อน" })));
    }
    var qtyPack = qtyBox * perBox;
    var name = catRow.name;

    if (branch) {
      var bsRow = _findStockBranchRow_(_fetchStockBranchRows_(branch), name, branch);
      if (!bsRow) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch })));
      }
      var haveBox = Number(bsRow.qty_box) || 0;
      if (qtyBox > haveBox) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: name + " สต็อกกล่องที่สาขาไม่พอ (เหลือ " + haveBox + ")" })));
      }
      bsRow.qty_box = haveBox - qtyBox;
      bsRow.qty_pack = (Number(bsRow.qty_pack) || 0) + qtyPack;
      _writeStockBranchRow_(bsRow);
    } else {
      var haveBoxC = Number(catRow.qty_box) || 0;
      if (qtyBox > haveBoxC) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: name + " สต็อกกล่องคลังกลางไม่พอ (เหลือ " + haveBoxC + ")" })));
      }
      catRow.qty_box = haveBoxC - qtyBox;
      catRow.qty_pack = (Number(catRow.qty_pack) || 0) + qtyPack;
      _clearCatalogCache_();
      writeSupabaseRow_("catalog", catRow, SUPABASE_CATALOG_HEADER, "name");
    }
    lock.releaseLock();

    var groupStaffConvert = _getConfigValue(null, "group_staff_live");
    if (groupStaffConvert && staffName) {
      _notifyStaffGroup_(groupStaffConvert, "🔁 " + staffName + " แกะ " + name + " " + qtyBox + " กล่อง → " + qtyPack + " ซอง" +
        (branch ? " ที่สาขา " + branch : " (คลังกลาง)"));
    }

    _logStaffAction_(staffName, branch || null, "convert_box_to_pack", catRow.id || name,
      qtyBox + " กล่อง → " + qtyPack + " ซอง (1 กล่อง = " + perBox + " ซอง)" + (branch ? " ที่สาขา " + branch : " (คลังกลาง)"));

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, packs_added: qtyPack })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เบิกสินค้าจากคลังกลาง (เช่น เอาไปขายออนไลน์เอง นอกช่องทางร้าน) ───────────
// ต่างจาก handleWithdrawStock ตรงที่หักจาก catalog.qty_box/pack (สต็อกกลาง)
// ไม่ใช่ stock_branch — ไม่มี branch ให้ระบุ/ตรวจสิทธิ์ เหมือน handleAddStock
// รับ qty_box + qty_pack พร้อมกัน (เหมือน handleReturnStock) แทนที่จะแยก
// type/qty ทีละหน่วย — เบิกทั้งกล่องและซองของสินค้าเดียวกันได้ในครั้งเดียว
// data: { name, qty_box, qty_pack, reason, staff_name }
function handleWithdrawCentralStock(data) {
  var name    = String(data.name || "").trim();
  var qtyBox  = Number(data.qty_box  || 0);
  var qtyPack = Number(data.qty_pack || 0);
  var reason  = String(data.reason || "").trim();
  var staffName = String(data.staff_name || "").trim();

  if (!name || (qtyBox <= 0 && qtyPack <= 0)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ (name, qty)" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var row = _resolveProductRow_(name, data.id);
    if (!row) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + name })));
    }
    name = row.name; // ชื่อปัจจุบันจริง เผื่อ dialog ค้างไว้ข้ามช่วง rename
    var wcHaveBox = Number(row.qty_box) || 0;
    var wcHavePack = Number(row.qty_pack) || 0;
    if (qtyBox > wcHaveBox || qtyPack > wcHavePack) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: name + " สต็อกคลังกลางไม่พอ (เหลือ กล่อง:" + wcHaveBox + " ซอง:" + wcHavePack + ")" })));
    }
    if (qtyBox  > 0) row.qty_box  = wcHaveBox - qtyBox;
    if (qtyPack > 0) row.qty_pack = wcHavePack - qtyPack;
    _clearCatalogCache_();
    writeSupabaseRow_("catalog", row, SUPABASE_CATALOG_HEADER, "name", lock);

    var wcParts = [];
    if (qtyBox > 0) wcParts.push(qtyBox + " กล่อง");
    if (qtyPack > 0) wcParts.push(qtyPack + " ซอง");
    var wcQtyText = wcParts.join(" ");

    var groupStaffWithdrawCentral = _getConfigValue(null, "group_staff_live");
    if (groupStaffWithdrawCentral && staffName) {
      _notifyStaffGroup_(groupStaffWithdrawCentral, "📤 " + staffName + " เบิก " + name + " " + wcQtyText + " จากคลังกลาง" +
        (reason ? "\nเหตุผล: " + reason : ""));
    }

    _logStaffAction_(staffName, null, "withdraw_central_stock", row.id || name, wcQtyText + (reason ? " — " + reason : ""));

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── คืนสต็อกจากสาขากลับคลังกลาง ──────────────────────────────────────────
// data: { branch, name, qty_box, qty_pack, staff_name }
function handleReturnStock(data) {
  var branch  = String(data.branch   || "").trim();
  var name    = String(data.name     || "").trim();
  var qtyBox  = Number(data.qty_box  || 0);
  var qtyPack = Number(data.qty_pack || 0);
  var staffName = String(data.staff_name || "").trim();

  if (!branch || !name || (qtyBox <= 0 && qtyPack <= 0)) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // resolve id-first ก่อน — ใช้ชื่อปัจจุบันจากผลลัพธ์ตลอดฟังก์ชัน เผื่อฟอร์ม
    // ค้างไว้ข้ามช่วง rename (เหมือน handleWithdrawStock/handleWithdrawCentralStock)
    var catRow = _resolveProductRow_(name, data.id);
    if (catRow) name = catRow.name;

    // ลดสต็อกสาขา (Supabase-primary)
    var bsRow = _findStockBranchRow_(_fetchStockBranchRows_(branch), name, branch);
    if (!bsRow) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch }))); }
    var haveBox = Number(bsRow.qty_box) || 0;
    var havePack = Number(bsRow.qty_pack) || 0;
    if (qtyBox > haveBox || qtyPack > havePack) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: name + " สต็อกสาขาไม่พอ (เหลือ Box:" + haveBox + " Pack:" + havePack + ")" })));
    }
    if (qtyBox  > 0) bsRow.qty_box  = haveBox - qtyBox;
    if (qtyPack > 0) bsRow.qty_pack = havePack - qtyPack;
    _writeStockBranchRow_(bsRow);

    // เพิ่มสต็อกกลาง (catalog, Supabase-primary)
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
    _clearCatalogCache_();
    lock.releaseLock();
    _logStaffAction_(staffName, branch, "return_stock", (catRow && catRow.id) || name, "Box:" + qtyBox + " Pack:" + qtyPack);

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

    // ปิดช่องโหว่ staff ค้างตะกร้าขายหน้าร้านไว้ข้ามช่วงที่มีคน rename สินค้า —
    // เหมือน doPost ด้านบน (ดู _resolveItemsAgainstCatalog_)
    var catRowsForWalkin = _fetchCatalogRows_();
    _resolveItemsAgainstCatalog_(items, catRowsForWalkin);

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
    // การขาย/รับของพร้อมกันได้)
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
    }

    // พรีออเดอร์ไม่มีการเช็ค stock เลย (checkCatalogLimits) — limit_box/pack จึง
    // เป็นตัวกันยอดขายเกินตัวเดียวที่มีอยู่จริง ต้องหักตอนขายหน้าร้านด้วย ไม่งั้น
    // ของพรีออเดอร์ที่ทยอยเข้าสาขาแล้วขายหน้าร้านไปจะไม่ถูกนับ ทำให้ออนไลน์ยังขาย
    // ได้เกินจำนวนที่ตั้งไว้จริง (สถานะ "ready" ไม่ทำ — limit ของสถานะนั้นเป็นเพดาน
    // แยกสำหรับออนไลน์โดยเจตนา ไม่ผูกกับสต็อกจริงที่กันเกินขายอยู่แล้ว)
    var preorderWalkinItems = items.filter(function(it) {
      var row = _findCatalogRow_(catRowsForWalkin, it.name);
      return !!(row && row.status === "preorder");
    });
    if (preorderWalkinItems.length > 0) {
      deductCatalogLimits(preorderWalkinItems, catRowsForWalkin);
    }

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'");
    var saleId = _genWalkinSaleId();
    var staffName = String(data.staff_name || "").trim();
    var saleObj = {
      sale_id: saleId, timestamp: now, branch: branch,
      items_json: items.map(function(it) { return { name: it.name, type: it.type, qty: Number(it.qty) || 0, price: Number(it.price) || 0 }; }),
      total: total, payment_method: data.payment_method || "cash", bank: data.bank || null,
      staff_name: staffName || null,
    };
    var saleRes = pushToSupabase_("walkin_sales", saleObj);
    if (!saleRes.ok) throw new Error("Supabase walkin_sales write failed: " + saleRes.text);

    lock.releaseLock();

    var groupStaffWalkin = _getConfigValue(null, "group_staff_live");
    if (groupStaffWalkin && staffName) {
      var payLabel = saleObj.payment_method === "cash" ? "💵 เงินสด" : ("📱 โอน" + (saleObj.bank ? " " + saleObj.bank : ""));
      var walkinItemsText = items.map(function(it) {
        var u = it.type === "box" ? "กล่อง" : "ซอง";
        return "  - " + it.name + " (" + u + ") x" + it.qty;
      }).join("\n");
      _notifyStaffGroup_(groupStaffWalkin, "🛒 " + staffName + " ขายหน้าร้านที่สาขา " + branch + " ฿" + total + " (" + payLabel + ")\n\n" + walkinItemsText);
    }

    _logStaffAction_(staffName, branch, "walkin_sale", saleId, "฿" + total);

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, sale_id: saleId, total: total })));
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ยกเลิกการขายหน้าร้าน: คืนสต็อกสาขา + ลบรายการขาย ──
// data: { sale_id, staff_name, code }
function handleCancelWalkinSale(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var saleId = String(data.sale_id || "").trim();
    var staffName = String(data.staff_name || "").trim();
    if (!saleId) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing sale_id" }))); }

    var rows = supabaseSelect_("walkin_sales", "select=*&sale_id=eq." + encodeURIComponent(saleId) + "&limit=1");
    var sale = rows[0];
    if (!sale) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบรายการขาย" }))); }

    var branch = String(sale.branch || "");
    if (!_branchAuthorized(data.code, branch)) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" }))); }
    var items = Array.isArray(sale.items_json) ? sale.items_json : [];

    // คืนสต็อกสาขาที่ถูกหักไปตอนขาย
    var bsRows = _fetchStockBranchRows_(branch);
    items.forEach(function(it) {
      var bsRow = _findStockBranchRow_(bsRows, it.name, branch);
      if (!bsRow) return;
      var field = it.type === "box" ? "qty_box" : "qty_pack";
      bsRow[field] = (Number(bsRow[field]) || 0) + (it.qty || 1);
      _writeStockBranchRow_(bsRow);
    });

    var delRes = deleteSupabase_("walkin_sales", "sale_id=eq." + encodeURIComponent(saleId));
    if (!delRes.ok) throw new Error("Supabase walkin_sales delete failed: " + delRes.text);

    lock.releaseLock();

    var itemsText = items.map(function(it) { return it.name + " x" + it.qty; }).join(", ");
    var groupStaffCancelWs = _getConfigValue(null, "group_staff_live");
    if (groupStaffCancelWs && staffName) {
      _notifyStaffGroup_(groupStaffCancelWs, "🗑️ " + staffName + " ยกเลิกรายการขายหน้าร้าน " + saleId + " ที่สาขา " + branch + " ฿" + (sale.total || 0) + " (คืนสต็อกแล้ว)\n" + itemsText);
    }
    _logStaffAction_(staffName, branch, "cancel_walkin_sale", saleId, "฿" + (sale.total || 0) + " — " + itemsText);

    // แยก log อีกชั้นหนึ่งต่อรายการสินค้า (target_id = รหัสสินค้า) — ต่างจาก log
    // ด้านบนที่ target_id เป็น sale_id (ผูกกับใบขาย ไม่ผูกกับสินค้าตัวใดตัวหนึ่ง)
    // ทำให้ tools/screens/products.py's ประวัติสินค้าต่อชิ้นดึงมาแสดงได้ด้วย
    // (เดิมยอดขายหน้าร้านที่ถูกยกเลิกไม่โผล่ในประวัติสินค้าเลย เพราะแถวใน
    // walkin_sales ถูกลบไปแล้วตอนยกเลิก ไม่มีอะไรให้ items_json สแกนเจอ)
    var cwsCatRows = items.length > 0 ? _fetchCatalogRows_() : [];
    items.forEach(function(it) {
      var cwsRow = _findCatalogRow_(cwsCatRows, it.name);
      var cwsUnit = it.type === "box" ? "กล่อง" : "ซอง";
      _logStaffAction_(staffName, branch, "cancel_walkin_sale_item", (cwsRow && cwsRow.id) || it.name,
        (it.qty || 0) + " " + cwsUnit + " x ฿" + (it.price || 0) + " — ยกเลิกจากการขาย " + saleId);
    });

    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch (_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function clearCache() {
  _clearCatalogCache_();
}


