// ──────────────────────────────────────────────────────────────────────────────
// Card Game Order System — Google Apps Script Backend
// Deploy as Web App: Execute as "Me", Who has access: "Anyone"
// ──────────────────────────────────────────────────────────────────────────────

function warmup() {
  // keepalive — run via time-based trigger every 5 min to prevent cold start
  SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty("SHEET_ID"));
}

const PROPS         = PropertiesService.getScriptProperties();
const LINE_TOKEN    = PROPS.getProperty("LINE_TOKEN");
const SHEET_ID      = PROPS.getProperty("SHEET_ID");
const SCRIPT_SECRET = PROPS.getProperty("SCRIPT_SECRET") || "";

const TAB_ORDERS  = "orders";
const TAB_CATALOG = "_catalog";
const TAB_CONFIG  = "_config";
const TAB_STOCK_BRANCH = "stock_branch";
const TAB_SHIPMENTS    = "shipments";
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

function _cors(output) {
  return output.setMimeType(ContentService.MimeType.JSON);
}

// GET: โหลด catalog หรือ ลูกค้ากดยืนยันรับของ
function doGet(e) {
  try {
    var action = (e && e.parameter && e.parameter.action) || "";

    if (action !== "confirm" && SCRIPT_SECRET && (e.parameter._s || "") !== SCRIPT_SECRET) {
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

    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var catWs = ss.getSheetByName(TAB_CATALOG);
    var cfgWs = ss.getSheetByName(TAB_CONFIG);

    var catRows = catWs ? catWs.getDataRange().getValues() : [];
    var catalog = [];
    for (var i = 1; i < catRows.length; i++) {
      var name = catRows[i][0], category = catRows[i][1], price_box = catRows[i][5];
      var price_pack = catRows[i][6], active = catRows[i][11], image_url = catRows[i][12];
      if (!name) continue;
      if (active === false || active === "FALSE" || active === 0) continue;
      var slug = catRows[i][2] || "";
      var limit_box  = catRows[i][9];
      var limit_pack = catRows[i][10];
      var barcode    = catRows[i][13] || "";
      var notice     = catRows[i][14] || "";
      var qty_box    = catRows[i][7];
      var qty_pack   = catRows[i][8];
      catalog.push({
        name:       String(name),
        category:   String(category || ""),
        price_box:  Number(price_box)  || 0,
        price_pack: Number(price_pack) || 0,
        imageUrl:   _driveUrl(String(image_url || "")),
        slug:       String(slug),
        limit_box:  (limit_box === "" || limit_box === undefined || limit_box === null) ? -1 : Number(limit_box),
        limit_pack: (limit_pack === "" || limit_pack === undefined || limit_pack === null) ? -1 : Number(limit_pack),
        barcode:    String(barcode),
        notice:     String(notice),
        qty_box:    Number(qty_box)  || 0,
        qty_pack:   Number(qty_pack) || 0,
      });
    }

    var cfgRows = cfgWs ? cfgWs.getDataRange().getValues() : [];
    var config  = {};
    for (var j = 1; j < cfgRows.length; j++) {
      if (cfgRows[j][0]) config[String(cfgRows[j][0])] = String(cfgRows[j][1] || "");
    }

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
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (!Array.isArray(data.events) && SCRIPT_SECRET && (e.parameter._s || "") !== SCRIPT_SECRET) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unauthorized" })));
    }

    if (data._action === "sendConfirmLink") {
      return handleSendConfirmLink(data);
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

    if (data._action === "uploadProductImage") {
      return handleUploadProductImage(data);
    }

    if (data._action === "confirmSlip") {
      return handleConfirmSlip(data);
    }

    if (data._action === "wakagymRegister") {
      return handleWakagymRegister(data);
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
          var cfgWs = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_CONFIG);
          if (cfgWs) {
            cfgWs.appendRow(["group_staff", src.groupId]);
            _linePush(src.groupId, "ตั้งค่ากลุ่ม staff สำเร็จ!\nGroup ID: " + src.groupId);
          }
        }
        if (src.userId && msgText.trim() === "!waka-finance") {
          var cfgWs2 = SpreadsheetApp.openById(SHEET_ID).getSheetByName(TAB_CONFIG);
          if (cfgWs2) {
            var rows2 = cfgWs2.getDataRange().getValues();
            var found2 = false;
            for (var fi = 1; fi < rows2.length; fi++) {
              if (String(rows2[fi][0]) === "finance_line_id") {
                cfgWs2.getRange(fi + 1, 2).setValue(src.userId);
                found2 = true;
                break;
              }
            }
            if (!found2) cfgWs2.appendRow(["finance_line_id", src.userId]);
            _linePush(src.userId, "ตั้งค่าบัญชีสำเร็จ ✅\nระบบจะแจ้งเตือนเมื่อมีสลิปมีปัญหา\n\nUser ID: " + src.userId);
          }
        }
      }
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
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

    // ── ตรวจ limit + หักสต็อก — อ่าน _catalog ครั้งเดียว ส่งต่อทั้ง 3 ฟังก์ชัน ──
    var catWsForOrder = null, catRowsForOrder = null;
    if (data.items && data.items.length > 0) {
      catWsForOrder = ss.getSheetByName(TAB_CATALOG);
      catRowsForOrder = catWsForOrder ? catWsForOrder.getDataRange().getValues() : null;
      var limitCheck = checkCatalogLimits(ss, data.items, catRowsForOrder);
      if (limitCheck.error) {
        try { lock.releaseLock(); } catch(_) {}
        return _cors(ContentService.createTextOutput(JSON.stringify({ success: false, error: limitCheck.error })));
      }
      // ทำเครื่องหมาย preorder items — limit มีค่าแต่ stock = 0
      // ใช้ตอน cancel เพื่อข้ามการคืน qty_box/pack (ไม่เคยหักจริง)
      for (var pi = 0; pi < data.items.length; pi++) {
        var pIt = data.items[pi];
        for (var pr = 1; pr < catRowsForOrder.length; pr++) {
          if (String(catRowsForOrder[pr][0]).trim() !== String(pIt.name).trim()) continue;
          var pLimitCol = pIt.type === "box" ? 9 : 10;
          var pStockCol = pIt.type === "box" ? 7 : 8;
          var pLimit = catRowsForOrder[pr][pLimitCol];
          var pHasLimit = !(pLimit === "" || pLimit === undefined || pLimit === null);
          if (pHasLimit && (Number(catRowsForOrder[pr][pStockCol]) || 0) === 0) {
            pIt._preorder = true;
          }
          break;
        }
      }
    }

    writeOrder(ss, {
      orderId,
      timestamp:   Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd'T'HH:mm:ss'+07:00'"),
      lineUserId:  data.lineUserId  || "",
      displayName: data.displayName || "",
      itemsJson:   JSON.stringify(data.items || []),
      total:       data.total       || 0,
      branch:      data.branch      || "",
      realName:    data.realName    || "",
      phone:       data.phone       || "",
      address:     data.address     || "",
      slipStatus,
      slipUrl,
      slipAmount,
      slipTxnId,
      notes:       slipNote,
    });

    if (data.items && data.items.length > 0) {
      // ส่ง rows เดิมให้แชร์กัน — deductCatalogLimits อัปเดต rows ใน memory แล้ว return คืน
      var updatedRows = deductCatalogLimits(ss, data.items, catWsForOrder, catRowsForOrder);
      deductStock(ss, data.items, catWsForOrder, updatedRows || catRowsForOrder);
    }

    // อัปโหลดสลิปหลัง write order — ค้นหา row ด้วย orderId แทน lastRow เพื่อป้องกัน race condition
    if (data.slipBase64 && !slipUrl) {
      try {
        slipUrl = saveSlipToDrive(data.slipBase64, orderId);
        if (slipUrl) {
          var owsUpd = ss.getSheetByName(TAB_ORDERS);
          var hdrUpd = owsUpd.getRange(1, 1, 1, owsUpd.getLastColumn()).getValues()[0];
          var slipUrlCol = hdrUpd.indexOf("slip_url");
          if (slipUrlCol >= 0) {
            var allRows = owsUpd.getDataRange().getValues();
            for (var rr = allRows.length - 1; rr >= 1; rr--) {
              if (String(allRows[rr][0]) === orderId) {
                owsUpd.getRange(rr + 1, slipUrlCol + 1).setValue(slipUrl);
                break;
              }
            }
          }
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

// ── Catalog: ตรวจ limit + หักสต็อก ──────────────────────────────────────────
// รับ rows ที่อ่านล่วงหน้าได้ เพื่อลด Sheets API call จาก 3 → 1

// checkCatalogLimits: ตรวจ limit_box (J) / limit_pack (K) และ actual stock (H/I)
function checkCatalogLimits(ss, items, _rows) {
  var ws = ss.getSheetByName(TAB_CATALOG);
  if (!ws) return { ok: true };
  var rows = _rows || ws.getDataRange().getValues();
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() !== String(item.name).trim()) continue;
      var limitCol = item.type === "box" ? 9 : 10;
      var stockCol = item.type === "box" ? 7 : 8;
      var limit = rows[r][limitCol];
      if (!(limit === "" || limit === undefined || limit === null)) {
        limit = Number(limit);
        if (item.qty > limit) {
          var unitLabel = item.type === "box" ? "กล่อง" : "ซอง";
          if (limit <= 0) return { error: item.name + " (" + unitLabel + ") สินค้าหมดแล้ว" };
          return { error: item.name + " (" + unitLabel + ") เหลือเพียง " + limit + " " + unitLabel };
        }
      }
      // ตรวจ actual stock — แจ้งเตือนถ้าสต็อกกลางไม่พอ
      var stock = Number(rows[r][stockCol]) || 0;
      if (stock > 0 && item.qty > stock) {
        var ul = item.type === "box" ? "กล่อง" : "ซอง";
        return { error: item.name + " (" + ul + ") สต็อกกลางไม่พอ (เหลือ " + stock + ")" };
      }
      break;
    }
  }
  return { ok: true };
}

// deductCatalogLimits: หัก limit_box/pack — รับ ws+rows เพื่อแชร์การอ่าน
function deductCatalogLimits(ss, items, _ws, _rows) {
  var ws = _ws || ss.getSheetByName(TAB_CATALOG);
  if (!ws) return _rows;
  var range = ws.getDataRange();
  var rows = _rows || range.getValues();
  var changed = false;
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() !== String(item.name).trim()) continue;
      var colIdx = item.type === "box" ? 9 : 10;
      var limit = rows[r][colIdx];
      if (limit === "" || limit === undefined || limit === null) break;
      rows[r][colIdx] = Math.max(0, Number(limit) - (item.qty || 1));
      changed = true;
      break;
    }
  }
  if (changed) {
    range.setValues(rows);
    CacheService.getScriptCache().remove("catalog_config");
  }
  return rows;
}

// deductStock: หัก qty_box/pack (H/I) — รับ ws+rows เพื่อแชร์การอ่าน
function deductStock(ss, items, _ws, _rows) {
  var ws = _ws || ss.getSheetByName(TAB_CATALOG);
  if (!ws) return;
  var range = ws.getDataRange();
  var rows = _rows || range.getValues();
  var changed = false;
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() !== String(item.name).trim()) continue;
      if (item.type === "box") {
        rows[r][7] = Math.max(0, (Number(rows[r][7]) || 0) - (item.qty || 1));
      } else {
        rows[r][8] = Math.max(0, (Number(rows[r][8]) || 0) - (item.qty || 1));
      }
      changed = true;
      break;
    }
  }
  if (changed) range.setValues(rows);
}

function restoreStock(ss, items) {
  var ws = ss.getSheetByName(TAB_CATALOG);
  if (!ws) return;
  var range = ws.getDataRange();
  var rows = range.getValues();
  var changed = false;
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    // _preorder = true หมายความว่าตอนสั่งซื้อ qty_box/pack เป็น 0 → deductStock ไม่ได้หักจริง
    // จึงไม่คืน qty กลับ (ป้องกัน ghost stock)
    if (item._preorder) continue;
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() !== String(item.name).trim()) continue;
      if (item.type === "box") {
        rows[r][7] = (Number(rows[r][7]) || 0) + (item.qty || 1);
      } else {
        rows[r][8] = (Number(rows[r][8]) || 0) + (item.qty || 1);
      }
      changed = true;
      break;
    }
  }
  if (changed) range.setValues(rows);
}

function restoreCatalogLimits(ss, items) {
  var ws = ss.getSheetByName(TAB_CATALOG);
  if (!ws) return;
  var range = ws.getDataRange();
  var rows = range.getValues();
  var changed = false;
  for (var idx = 0; idx < items.length; idx++) {
    var item = items[idx];
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() !== String(item.name).trim()) continue;
      var colIdx = item.type === "box" ? 9 : 10;
      var limit = rows[r][colIdx];
      if (limit === "" || limit === undefined || limit === null) break;
      rows[r][colIdx] = (Number(limit) || 0) + (item.qty || 1);
      changed = true;
      break;
    }
  }
  if (changed) {
    range.setValues(rows);
    CacheService.getScriptCache().remove("catalog_config");
  }
}

function _clearDashCache() {
  try { CacheService.getScriptCache().remove("dashboard_v1"); } catch(_) {}
}

function writeOrder(ss, d) {
  let ws = ss.getSheetByName(TAB_ORDERS);
  if (!ws) {
    ws = ss.insertSheet(TAB_ORDERS);
    ws.appendRow([
      "order_id","timestamp","line_user_id","display_name",
      "items_json","total","branch","real_name","phone","address",
      "slip_status","slip_url","slip_amount","slip_txn_id","notes",
      "fulfillment","fulfilled_at","staff_confirmed_at","customer_confirmed_at",
    ]);
  }
  ws.appendRow([
    d.orderId, d.timestamp, d.lineUserId, _sanitize(d.displayName),
    d.itemsJson, d.total, d.branch, _sanitize(d.realName), _sanitize(d.phone), _sanitize(d.address),
    d.slipStatus, d.slipUrl, d.slipAmount, d.slipTxnId, d.notes,
  ]);
  _clearDashCache();
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

function _getConfigValue(cfgWs, key) {
  if (!cfgWs) return null;
  const rows = cfgWs.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === key && rows[i][1]) return String(rows[i][1]);
  }
  return null;
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
  }
  return ws;
}

function _getActiveEvent(ss, branch) {
  var evWs = ss.getSheetByName(TAB_WAKAGYM_EVENTS);
  if (!evWs) return null;
  var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
  var rows = evWs.getDataRange().getValues();
  var hdr = rows[0];
  var col = function(n) { return hdr.indexOf(n); };
  for (var i = rows.length - 1; i >= 1; i--) {
    var d = String(rows[i][col("date")]);
    if (d.length > 10) d = d.substring(0, 10);
    if (d === today && String(rows[i][col("status")]) === "open") {
      if (!branch || String(rows[i][col("branch")]) === branch) {
        return {
          event_id: String(rows[i][col("event_id")]),
          date: today,
          branch: String(rows[i][col("branch")] || ""),
          tier: String(rows[i][col("tier")] || "L"),
          entry_fee: Number(rows[i][col("entry_fee")]) || 200,
          status: "open",
          row_num: i + 1,
        };
      }
    }
  }
  return null;
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

    var regWs = _ensureTab(ss, TAB_WAKAGYM_REG, [
      "reg_id", "timestamp", "event_date", "group_id", "event_id", "line_user_id", "display_name",
      "real_name", "player_name", "phone", "slip_url", "slip_status", "payment_method",
      "bank", "placement", "wins_3match", "tokens_earned", "promo_packs", "rewards_given", "note"
    ]);

    var statsWs = _ensureTab(ss, TAB_PLAYER_STATS, [
      "player_name", "display_name", "real_name", "line_user_id", "total_plays",
      "total_tokens", "boxes_earned", "boxes_given", "last_play_date"
    ]);
    var statsRows = statsWs.getDataRange().getValues();
    var sHdr = statsRows[0];
    var sCol = function(name) { return sHdr.indexOf(name); };

    var players = data.players || [];
    if (players.length === 0) {
      players = [{ realName: data.realName || "", playerName: data.playerName || data.realName || "" }];
    }

    var results = [];
    for (var p = 0; p < players.length; p++) {
      var pl = players[p];
      var regId = p === 0 ? groupId : _genWakagymRegId();
      var pName = String(pl.playerName || pl.realName || "").trim();
      var rName = String(pl.realName || "").trim();

      regWs.appendRow([
        regId, now, today, groupId, eventId,
        data.lineUserId || "", data.displayName || "",
        rName, pName, data.phone || "", slipUrl, slipStatus, payMethod,
        data.bank || "", "", "", "", "", "", ""
      ]);

      var foundRow = -1;
      for (var i = 1; i < statsRows.length; i++) {
        if (String(statsRows[i][sCol("player_name")]).trim() === pName) {
          foundRow = i + 1;
          break;
        }
      }

      var totalTokens = 0;
      if (foundRow > 0) {
        var tp = Number(statsRows[foundRow - 1][sCol("total_plays")]) || 0;
        totalTokens = Number(statsRows[foundRow - 1][sCol("total_tokens")]) || 0;
        tp++;
        statsWs.getRange(foundRow, sCol("real_name") + 1).setValue(rName);
        statsWs.getRange(foundRow, sCol("line_user_id") + 1).setValue(data.lineUserId || "");
        statsWs.getRange(foundRow, sCol("total_plays") + 1).setValue(tp);
        statsWs.getRange(foundRow, sCol("last_play_date") + 1).setValue(today);
      } else {
        totalTokens = 0;
        statsWs.appendRow([pName, data.displayName || "", rName, data.lineUserId || "", 1, 0, 0, 0, today]);
        statsRows.push([pName, data.displayName || "", rName, data.lineUserId || "", 1, 0, 0, 0, today]);
      }

      results.push({ regId: regId, playerName: pName, totalTokens: totalTokens });
    }

    lock.releaseLock();

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

function handleStaffPage(orderId, action) {
  if (!orderId) return HtmlService.createHtmlOutput("<h2>ไม่พบออเดอร์</h2>");
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ws = ss.getSheetByName(TAB_ORDERS);
  var rows = ws.getDataRange().getValues();
  var hdr = rows[0];
  var col = function(name) { return hdr.indexOf(name); };
  var gasUrl = ScriptApp.getService().getUrl();

  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][col("order_id")]) !== orderId) continue;
    var r = rows[i];
    var ff = r[col("fulfillment")] || "รอเตรียม";
    var branch = r[col("branch")] || "";
    var isDelivery = branch === "จัดส่ง";
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");

    if (action === "shipping") {
      if (col("fulfillment") >= 0) ws.getRange(i+1, col("fulfillment")+1).setValue("กำลังจัดส่งไปสาขา");
      if (col("fulfilled_at") >= 0) ws.getRange(i+1, col("fulfilled_at")+1).setValue(now);
      ff = "กำลังจัดส่งไปสาขา";
      _clearDashCache();
    } else if (action === "ready") {
      if (col("fulfillment") >= 0) ws.getRange(i+1, col("fulfillment")+1).setValue("พร้อมรับ");
      if (col("fulfilled_at") >= 0) ws.getRange(i+1, col("fulfilled_at")+1).setValue(now);
      ff = "พร้อมรับ";
      _clearDashCache();
      var uid2 = r[col("line_user_id")];
      if (uid2) {
        var trackUrl2 = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;
        _linePush(uid2, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + orderId + "\n\nดูสถานะ:\n" + trackUrl2);
      }
    } else if (action === "handover") {
      var ffValue = isDelivery ? "จัดส่งแล้ว" : "สาขายืนยัน";
      if (col("fulfillment") >= 0) ws.getRange(i+1, col("fulfillment")+1).setValue(ffValue);
      if (col("staff_confirmed_at") >= 0) ws.getRange(i+1, col("staff_confirmed_at")+1).setValue(now);
      ff = ffValue;
      _clearDashCache();
      var uid3 = r[col("line_user_id")];
      if (uid3) {
        var trackUrl3 = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;
        _linePush(uid3, "สาขาส่งมอบสินค้าแล้ว กรุณากดยืนยันรับของ\n\nออเดอร์: #" + orderId + "\n\nกดยืนยัน:\n" + trackUrl3);
      }
    }

    var items = [];
    try { items = JSON.parse(r[col("items_json")] || "[]"); } catch(e) {}
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
      + '<div><b>ลูกค้า:</b> ' + (r[col("display_name")] || "") + ' (' + (r[col("real_name")] || "") + ')</div>'
      + '<div><b>โทร:</b> ' + (r[col("phone")] || "") + '</div>'
      + '<div><b>' + (isDelivery ? '🚚 จัดส่งพัสดุ' : '📦 รับที่สาขา: ' + branch) + '</b></div>'
      + (isDelivery && r[col("address")] ? '<div><b>ที่อยู่:</b> ' + r[col("address")] + '</div>' : '')
      + '</div>'
      + '<div style="background:#fff;border:1px solid #eee;border-radius:10px;padding:14px;margin:12px 0">'
      + '<div style="font-weight:bold;margin-bottom:8px">🎴 รายการ</div>' + itemsHtml
      + '<div style="margin-top:8px;font-weight:bold;color:#06c755">ยอดรวม: ' + r[col("total")] + ' บาท</div>'
      + '</div>'
      + '<div style="text-align:center;margin:12px 0;color:#888">สถานะ: <b>' + ff + '</b></div>'
      + buttonsHtml
      + '</div>';

    return HtmlService.createHtmlOutput(html);
  }
  return HtmlService.createHtmlOutput("<h2>ไม่พบออเดอร์ #" + orderId + "</h2>");
}

function handleApi(params) {
  var action = params.do || "";
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var ws = ss.getSheetByName(TAB_ORDERS);
  if (!ws) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no orders tab" })));
  var rows = ws.getDataRange().getValues();
  var hdr = rows[0];

  if (action === "search") {
    var q = String(params.q || "").toLowerCase().trim();
    if (!q) return _cors(ContentService.createTextOutput(JSON.stringify({ orders: [] })));
    var results = [];
    for (var i = 1; i < rows.length; i++) {
      var row = {};
      for (var c = 0; c < hdr.length; c++) {
        row[hdr[c]] = rows[i][c] != null ? String(rows[i][c]) : "";
      }
      var match = row.order_id.toLowerCase().indexOf(q) >= 0
        || row.real_name.toLowerCase().indexOf(q) >= 0
        || row.display_name.toLowerCase().indexOf(q) >= 0
        || row.phone.indexOf(q) >= 0;
      if (match) results.push(row);
    }
    results.reverse();
    return _cors(ContentService.createTextOutput(JSON.stringify({ orders: results.slice(0, 20) })));
  }

  if (action === "update") {
    var orderId = params.order || "";
    var newStatus = params.status || "";
    if (!orderId || !newStatus) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing params" })));

    var col = function(name) { return hdr.indexOf(name); };
    var gasUrl = ScriptApp.getService().getUrl();
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");

    for (var j = 1; j < rows.length; j++) {
      if (String(rows[j][col("order_id")]) !== orderId) continue;
      var branch = rows[j][col("branch")] || "";
      var isDelivery = branch === "จัดส่ง";
      var uid = rows[j][col("line_user_id")] || "";
      var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + orderId;

      if (newStatus === "shipping") {
        if (col("fulfillment") >= 0) ws.getRange(j+1, col("fulfillment")+1).setValue("กำลังจัดส่งไปสาขา");
        if (col("fulfilled_at") >= 0) ws.getRange(j+1, col("fulfilled_at")+1).setValue(now);
      } else if (newStatus === "ready") {
        if (col("fulfillment") >= 0) ws.getRange(j+1, col("fulfillment")+1).setValue("พร้อมรับ");
        if (col("fulfilled_at") >= 0) ws.getRange(j+1, col("fulfilled_at")+1).setValue(now);
        if (uid) _linePush(uid, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + orderId + "\n\nดูสถานะ:\n" + trackUrl);
      } else if (newStatus === "handover") {
        var ffVal = isDelivery ? "จัดส่งแล้ว" : "สาขายืนยัน";
        if (col("fulfillment") >= 0) ws.getRange(j+1, col("fulfillment")+1).setValue(ffVal);
        if (col("staff_confirmed_at") >= 0) ws.getRange(j+1, col("staff_confirmed_at")+1).setValue(now);
        if (uid) _linePush(uid, "สาขาส่งมอบสินค้าแล้ว กรุณากดยืนยันรับของ\n\nออเดอร์: #" + orderId + "\n\nกดยืนยัน:\n" + trackUrl);
      }
      _clearDashCache();
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, status: newStatus, time: now })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
  }

  if (action === "order_status") {
    var orderId = params.order || "";
    if (!orderId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing order" })));
    var col = function(name) { return hdr.indexOf(name); };
    for (var k = 1; k < rows.length; k++) {
      if (String(rows[k][col("order_id")]) !== orderId) continue;
      var r = rows[k];
      return _cors(ContentService.createTextOutput(JSON.stringify({
        order_id: orderId,
        branch: r[col("branch")] || "",
        slip_status: r[col("slip_status")] || "",
        fulfillment: r[col("fulfillment")] || "",
        staff_confirmed_at: r[col("staff_confirmed_at")] || "",
        customer_confirmed_at: r[col("customer_confirmed_at")] || "",
        timestamp: r[col("timestamp")] || "",
        total: r[col("total")] || 0,
      })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
  }

  if (action === "customer_confirm") {
    var orderId = params.order || "";
    if (!orderId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing order" })));
    var col = function(name) { return hdr.indexOf(name); };
    for (var m = 1; m < rows.length; m++) {
      if (String(rows[m][col("order_id")]) !== orderId) continue;
      var staffAt = rows[m][col("staff_confirmed_at")] || "";
      var custAt = rows[m][col("customer_confirmed_at")] || "";
      var ff = String(rows[m][col("fulfillment")] || "");
      if (custAt && ff === "รับแล้ว") return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
      if (!staffAt) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "staff ยังไม่ส่งมอบ" })));
      // ถ้าออเดอร์ยังมีสินค้าค้างอยู่ → บอกลูกค้าแต่ไม่ปิด order
      if (ff === "รับบางส่วนแล้ว") {
        return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, partial: true, msg: "รับของบางส่วนเรียบร้อยแล้ว สินค้าที่เหลือจะแจ้งให้ทราบเมื่อพร้อม" })));
      }
      var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
      if (col("customer_confirmed_at") >= 0) ws.getRange(m + 1, col("customer_confirmed_at") + 1).setValue(now);
      if (col("fulfillment") >= 0) ws.getRange(m + 1, col("fulfillment") + 1).setValue("รับแล้ว");
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
  }

  // ── ออเดอร์ของสาขา ──
  if (action === "branch_orders") {
    var branchFilter = params.branch || "";
    if (!branchFilter) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing branch" })));
    var col = function(name) { return hdr.indexOf(name); };
    var orders = [];
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][col("branch")] || "") !== branchFilter) continue;
      var slip = String(rows[i][col("slip_status")] || "");
      if (slip !== "ยืนยัน") continue;
      orders.push({
        order_id: String(rows[i][col("order_id")] || ""),
        real_name: String(rows[i][col("real_name")] || ""),
        display_name: String(rows[i][col("display_name")] || ""),
        phone: String(rows[i][col("phone")] || ""),
        items_json: String(rows[i][col("items_json")] || "[]"),
        total: String(rows[i][col("total")] || "0"),
        fulfillment: String(rows[i][col("fulfillment")] || ""),
        staff_confirmed_at: String(rows[i][col("staff_confirmed_at")] || ""),
        customer_confirmed_at: String(rows[i][col("customer_confirmed_at")] || ""),
        timestamp: String(rows[i][col("timestamp")] || ""),
      });
    }
    orders.reverse();
    return _cors(ContentService.createTextOutput(JSON.stringify({ orders: orders })));
  }

  // ── สรุปออเดอร์แต่ละสาขา (รวมเป็นรายสินค้า) ──
  if (action === "branch_summary") {
    var col = function(name) { return hdr.indexOf(name); };
    var summary = {};
    for (var i = 1; i < rows.length; i++) {
      var branch = rows[i][col("branch")] || "";
      var slip = rows[i][col("slip_status")] || "";
      var ff = rows[i][col("fulfillment")] || "";
      if (slip !== "ยืนยัน") continue;
      if (["กำลังจัดส่งไปสาขา","พร้อมรับ","สาขายืนยัน","รับแล้ว","จัดส่งแล้ว"].indexOf(ff) >= 0) continue;
      var items = [];
      try { items = JSON.parse(rows[i][col("items_json")] || "[]"); } catch(e) {}
      if (!summary[branch]) summary[branch] = {};
      for (var x = 0; x < items.length; x++) {
        var key = items[x].name;
        if (!summary[branch][key]) summary[branch][key] = { name: key, qty_box: 0, qty_pack: 0, order_count: 0 };
        if (items[x].type === "box") summary[branch][key].qty_box += (items[x].qty || 1);
        else summary[branch][key].qty_pack += (items[x].qty || 1);
        summary[branch][key].order_count++;
      }
    }
    var result = {};
    for (var b in summary) {
      result[b] = [];
      for (var k in summary[b]) result[b].push(summary[b][k]);
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ branches: result })));
  }

  // ── สต็อกกลาง ──
  if (action === "central_stock") {
    var csWs = ss.getSheetByName(TAB_CATALOG);
    if (!csWs) return _cors(ContentService.createTextOutput(JSON.stringify({ stock: [] })));
    var sRows = csWs.getDataRange().getValues();
    var stock = [];
    for (var i = 1; i < sRows.length; i++) {
      if (!sRows[i][0]) continue;
      stock.push({ name: String(sRows[i][0]), category: String(sRows[i][1] || ""), qty_box: Number(sRows[i][7]) || 0, qty_pack: Number(sRows[i][8]) || 0 });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ stock: stock })));
  }

  // ── สต็อกสาขา ──
  if (action === "branch_stock") {
    var branchFilter = params.branch || "";
    var bsWs = ss.getSheetByName(TAB_STOCK_BRANCH);
    if (!bsWs) return _cors(ContentService.createTextOutput(JSON.stringify({ stock: [] })));
    var bsRows = bsWs.getDataRange().getValues();
    var bStock = [];
    for (var i = 1; i < bsRows.length; i++) {
      if (!bsRows[i][0]) continue;
      if (branchFilter && String(bsRows[i][2]) !== branchFilter) continue;
      bStock.push({ name: String(bsRows[i][0]), category: String(bsRows[i][1] || ""), branch: String(bsRows[i][2] || ""), qty_box: Number(bsRows[i][3]) || 0, qty_pack: Number(bsRows[i][4]) || 0 });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ stock: bStock })));
  }

  // ── รายการ shipments ──
  if (action === "shipments") {
    var shWs = ss.getSheetByName(TAB_SHIPMENTS);
    if (!shWs) return _cors(ContentService.createTextOutput(JSON.stringify({ shipments: [] })));
    var shRows = shWs.getDataRange().getValues();
    var shList = [];
    for (var i = 1; i < shRows.length; i++) {
      shList.push({
        shipment_id: String(shRows[i][0] || ""),
        timestamp: String(shRows[i][1] || ""),
        to_branch: String(shRows[i][2] || ""),
        status: String(shRows[i][3] || ""),
        items_json: String(shRows[i][4] || "[]"),
        received_at: String(shRows[i][5] || ""),
        notes: String(shRows[i][6] || ""),
      });
    }
    shList.reverse();
    return _cors(ContentService.createTextOutput(JSON.stringify({ shipments: shList })));
  }

  // ── รายงานยอดขาย ──
  if (action === "report") {
    var col = function(name) { return hdr.indexOf(name); };

    // อ่าน cost จาก _catalog
    var catWs = ss.getSheetByName(TAB_CATALOG);
    var costMap = {};
    if (catWs) {
      var catRows = catWs.getDataRange().getValues();
      for (var ci = 1; ci < catRows.length; ci++) {
        if (!catRows[ci][0]) continue;
        costMap[String(catRows[ci][0])] = {
          cost_box: Number(catRows[ci][3]) || 0,
          cost_pack: Number(catRows[ci][4]) || 0,
          price_box: Number(catRows[ci][5]) || 0,
          price_pack: Number(catRows[ci][6]) || 0,
        };
      }
    }

    var byBranch = {};
    var byProduct = {};
    var byDate = {};
    var totalRevenue = 0, totalCost = 0;

    for (var i = 1; i < rows.length; i++) {
      var slip = rows[i][col("slip_status")] || "";
      if (slip !== "ยืนยัน") continue;

      var branch = rows[i][col("branch")] || "ไม่ระบุ";
      var ts = String(rows[i][col("timestamp")] || "");
      var dateKey = ts.substring(0, 10);
      var items = [];
      try { items = JSON.parse(rows[i][col("items_json")] || "[]"); } catch(e) {}

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
    }

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
    var catWs = ss.getSheetByName(TAB_CATALOG);
    if (!catWs) return _cors(ContentService.createTextOutput(JSON.stringify({ found: false })));
    var catRows = catWs.getDataRange().getValues();
    for (var i = 1; i < catRows.length; i++) {
      if (String(catRows[i][13] || "").trim() === barcode) {
        return _cors(ContentService.createTextOutput(JSON.stringify({
          found: true,
          product: {
            name: String(catRows[i][0]), category: String(catRows[i][1] || ""),
            price_box: Number(catRows[i][5]) || 0, price_pack: Number(catRows[i][6]) || 0,
            cost_box: Number(catRows[i][3]) || 0, cost_pack: Number(catRows[i][4]) || 0,
            barcode: barcode, stock_box: Number(catRows[i][7]) || 0, stock_pack: Number(catRows[i][8]) || 0,
          }
        })));
      }
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ found: false })));
  }

  // ── รายการสินค้าทั้งหมด (สำหรับหน้ารับสต็อก) ──
  if (action === "product_list") {
    var catWs = ss.getSheetByName(TAB_CATALOG);
    if (!catWs) return _cors(ContentService.createTextOutput(JSON.stringify({ products: [] })));
    var catRows = catWs.getDataRange().getValues();
    var products = [];
    for (var i = 1; i < catRows.length; i++) {
      if (!catRows[i][0]) continue;
      var n = String(catRows[i][0]).trim();
      products.push({
        name: n, category: String(catRows[i][1] || ""),
        price_box: Number(catRows[i][5]) || 0, price_pack: Number(catRows[i][6]) || 0,
        cost_box: Number(catRows[i][3]) || 0, cost_pack: Number(catRows[i][4]) || 0,
        barcode: String(catRows[i][13] || ""),
        limit_box: (catRows[i][9] === "" || catRows[i][9] === undefined || catRows[i][9] === null) ? -1 : Number(catRows[i][9]),
        limit_pack: (catRows[i][10] === "" || catRows[i][10] === undefined || catRows[i][10] === null) ? -1 : Number(catRows[i][10]),
        stock_box: Number(catRows[i][7]) || 0, stock_pack: Number(catRows[i][8]) || 0,
      });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ products: products })));
  }

  // ── Admin Catalog (ทุกสินค้า รวม inactive) ──
  if (action === "catalog_admin") {
    var catWs = ss.getSheetByName(TAB_CATALOG);
    if (!catWs) return _cors(ContentService.createTextOutput(JSON.stringify({ products: [] })));
    var catRows = catWs.getDataRange().getValues();
    var products = [];
    for (var i = 1; i < catRows.length; i++) {
      if (!catRows[i][0]) continue;
      var isActive = !(catRows[i][11] === false || String(catRows[i][11]).toUpperCase() === "FALSE" || catRows[i][11] === 0);
      products.push({
        name: String(catRows[i][0] || "").trim(),
        category: String(catRows[i][1] || ""),
        cost_box: Number(catRows[i][3]) || 0, cost_pack: Number(catRows[i][4]) || 0,
        price_box: Number(catRows[i][5]) || 0, price_pack: Number(catRows[i][6]) || 0,
        qty_box: Number(catRows[i][7]) || 0, qty_pack: Number(catRows[i][8]) || 0,
        limit_box: (catRows[i][9] === "" || catRows[i][9] === undefined || catRows[i][9] === null) ? -1 : Number(catRows[i][9]),
        limit_pack: (catRows[i][10] === "" || catRows[i][10] === undefined || catRows[i][10] === null) ? -1 : Number(catRows[i][10]),
        active: isActive,
        notice: String(catRows[i][14] || "")
      });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ products: products })));
  }

  // ── Dashboard KPI ──
  if (action === "dashboard") {
    var dashCache = CacheService.getScriptCache();
    var cached = dashCache.get("dashboard_v1");
    if (cached) return _cors(ContentService.createTextOutput(cached));

    var col = function(name) { return hdr.indexOf(name); };
    var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var ordersToday = 0, revenueToday = 0, pendingCount = 0;
    var recentOrders = [];
    for (var i = rows.length - 1; i >= 1; i--) {
      var ts = String(rows[i][col("timestamp")] || "");
      var slip = String(rows[i][col("slip_status")] || "");
      if (ts.substring(0, 10) === today) {
        ordersToday++;
        if (slip === "ยืนยัน") revenueToday += Number(rows[i][col("total")]) || 0;
      }
      if (["รอตรวจ","รอตรวจเพิ่ม","ยอดไม่ตรง","สลิปซ้ำ","บัญชีไม่ตรง","สงสัยปลอม"].indexOf(slip) >= 0) pendingCount++;
      if (recentOrders.length < 10) {
        recentOrders.push({
          order_id: String(rows[i][col("order_id")] || ""),
          real_name: String(rows[i][col("real_name")] || ""),
          display_name: String(rows[i][col("display_name")] || ""),
          phone: String(rows[i][col("phone")] || ""),
          items_json: String(rows[i][col("items_json")] || "[]"),
          total: Number(rows[i][col("total")]) || 0,
          slip_status: slip,
          fulfillment: String(rows[i][col("fulfillment")] || ""),
          branch: String(rows[i][col("branch")] || ""),
          address: String(rows[i][col("address")] || ""),
          timestamp: ts,
        });
      }
    }
    var dashJson = JSON.stringify({
      orders_today: ordersToday, revenue_today: revenueToday,
      pending_count: pendingCount, recent_orders: recentOrders,
    });
    dashCache.put("dashboard_v1", dashJson, 30);
    return _cors(ContentService.createTextOutput(dashJson));
  }

  // ── ยกเลิกออเดอร์ (admin) ──
  if (action === "cancel_order") {
    var orderId = params.order || "";
    if (!orderId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing order" })));
    var col = function(name) { return hdr.indexOf(name); };
    var cancelReason = String(params.reason || "");
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][col("order_id")]) !== orderId) continue;
      var ff = String(rows[i][col("fulfillment")] || "");
      if (ff === "รับแล้ว" || ff === "ยกเลิก") {
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่สามารถยกเลิกออเดอร์นี้ได้" })));
      }
      var items = [];
      try { items = JSON.parse(String(rows[i][col("items_json")] || "[]")); } catch(_) {}
      // คืนเฉพาะ item ที่ยังไม่ได้ส่งมอบลูกค้า (ป้องกัน double restore)
      var itemsToRestore = items.filter(function(it) { return !it.handed_at; });
      if (itemsToRestore.length > 0) {
        restoreStock(ss, itemsToRestore);
        restoreCatalogLimits(ss, itemsToRestore);
      }
      ws.getRange(i + 1, col("fulfillment") + 1).setValue("ยกเลิก");
      var uid = String(rows[i][col("line_user_id")] || "");
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
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
  }

  // ── รายการจัดส่งพัสดุ ──
  if (action === "delivery_orders") {
    var col = function(name) { return hdr.indexOf(name); };
    var deliveries = [];
    for (var i = rows.length - 1; i >= 1; i--) {
      var branch = String(rows[i][col("branch")] || "");
      if (branch !== "จัดส่ง") continue;
      var ff = String(rows[i][col("fulfillment")] || "");
      if (ff === "จัดส่งแล้ว" || ff === "รับแล้ว") continue;
      deliveries.push({
        order_id:    String(rows[i][col("order_id")]    || ""),
        real_name:   String(rows[i][col("real_name")]   || ""),
        display_name:String(rows[i][col("display_name")]|| ""),
        phone:       String(rows[i][col("phone")]       || ""),
        address:     String(rows[i][col("address")]     || ""),
        items_json:  String(rows[i][col("items_json")]  || "[]"),
        total:       Number(rows[i][col("total")])      || 0,
        slip_status: String(rows[i][col("slip_status")] || ""),
        fulfillment: ff,
        timestamp:   String(rows[i][col("timestamp")]   || ""),
      });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ deliveries: deliveries })));
  }

  // ── รายการเบิกสินค้า ──
  if (action === "withdrawals") {
    var wWs = ss.getSheetByName("withdrawals");
    if (!wWs) return _cors(ContentService.createTextOutput(JSON.stringify({ withdrawals: [] })));
    var wRows = wWs.getDataRange().getValues();
    var branchFilter = params.branch || "";
    var wList = [];
    for (var i = 1; i < wRows.length; i++) {
      if (branchFilter && String(wRows[i][1]) !== branchFilter) continue;
      wList.push({ timestamp: String(wRows[i][0] || ""), branch: String(wRows[i][1] || ""), name: String(wRows[i][2] || ""), type: String(wRows[i][3] || ""), qty: Number(wRows[i][4]) || 0, reason: String(wRows[i][5] || "") });
    }
    wList.reverse();
    return _cors(ContentService.createTextOutput(JSON.stringify({ withdrawals: wList.slice(0, 50) })));
  }

  // ── WAKA GYM API ──
  if (action === "wakagym_status") {
    var uid = params.line_user_id || "";
    var today = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var regWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    var statsWs2 = ss.getSheetByName(TAB_PLAYER_STATS);

    var event = _getActiveEvent(ss, null);
    var eventInfo = event ? {
      event_id: event.event_id, tier: event.tier,
      entry_fee: event.entry_fee, branch: event.branch,
      token_table: TOKEN_TABLE[event.tier] || {},
    } : null;

    var todayRegs = [];
    if (regWs && uid) {
      var rRows = regWs.getDataRange().getValues();
      var rHdr = rRows[0];
      var rCol = function(n) { return rHdr.indexOf(n); };
      for (var ri = 1; ri < rRows.length; ri++) {
        var evDate = String(rRows[ri][rCol("event_date")]);
        if (evDate.length > 10) evDate = evDate.substring(0, 10);
        if (String(rRows[ri][rCol("line_user_id")]) === uid && evDate === today) {
          todayRegs.push({
            reg_id: String(rRows[ri][rCol("reg_id")] || ""),
            player_name: String(rRows[ri][rCol("player_name")] || ""),
            slip_status: String(rRows[ri][rCol("slip_status")] || ""),
          });
        }
      }
    }

    var linkedStats = [];
    if (statsWs2 && uid) {
      var sRows2 = statsWs2.getDataRange().getValues();
      var sHdr2 = sRows2[0];
      var sC = function(n) { return sHdr2.indexOf(n); };
      for (var si = 1; si < sRows2.length; si++) {
        if (String(sRows2[si][sC("line_user_id")]) === uid) {
          linkedStats.push({
            player_name: String(sRows2[si][sC("player_name")] || ""),
            total_plays: Number(sRows2[si][sC("total_plays")]) || 0,
            total_tokens: Number(sRows2[si][sC("total_tokens")]) || 0,
            boxes_earned: Number(sRows2[si][sC("boxes_earned")]) || 0,
            boxes_given: Number(sRows2[si][sC("boxes_given")]) || 0,
          });
        }
      }
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
    var tRegWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    if (!tRegWs) return _cors(ContentService.createTextOutput(JSON.stringify({ players: [] })));
    var tRows = tRegWs.getDataRange().getValues();
    var tHdr = tRows[0];
    var tCol = function(n) { return tHdr.indexOf(n); };
    var players = [];
    for (var ti = 1; ti < tRows.length; ti++) {
      if (String(tRows[ti][tCol("event_date")]) !== date) continue;
      players.push({
        reg_id: String(tRows[ti][tCol("reg_id")] || ""),
        group_id: String(tRows[ti][tCol("group_id")] || ""),
        display_name: String(tRows[ti][tCol("display_name")] || ""),
        real_name: String(tRows[ti][tCol("real_name")] || ""),
        player_name: String(tRows[ti][tCol("player_name")] || ""),
        slip_url: String(tRows[ti][tCol("slip_url")] || ""),
        slip_status: String(tRows[ti][tCol("slip_status")] || ""),
        payment_method: String(tRows[ti][tCol("payment_method")] || ""),
        tokens_earned: String(tRows[ti][tCol("tokens_earned")] || ""),
        promo_packs: String(tRows[ti][tCol("promo_packs")] || ""),
        rewards_given: String(tRows[ti][tCol("rewards_given")] || ""),
        phone: String(tRows[ti][tCol("phone")] || ""),
        timestamp: String(tRows[ti][tCol("timestamp")] || ""),
      });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ players: players })));
  }

  if (action === "wakagym_player_stats") {
    var psWs = ss.getSheetByName(TAB_PLAYER_STATS);
    if (!psWs) return _cors(ContentService.createTextOutput(JSON.stringify({ stats: [] })));
    var psRows = psWs.getDataRange().getValues();
    var psHdr = psRows[0];
    var psCol = function(n) { return psHdr.indexOf(n); };
    var stats = [];
    for (var pi = 1; pi < psRows.length; pi++) {
      stats.push({
        player_name: String(psRows[pi][psCol("player_name")] || ""),
        line_user_id: String(psRows[pi][psCol("line_user_id")] || ""),
        display_name: String(psRows[pi][psCol("display_name")] || ""),
        real_name: String(psRows[pi][psCol("real_name")] || ""),
        total_plays: Number(psRows[pi][psCol("total_plays")]) || 0,
        total_tokens: Number(psRows[pi][psCol("total_tokens")]) || 0,
        boxes_earned: Number(psRows[pi][psCol("boxes_earned")]) || 0,
        boxes_given: Number(psRows[pi][psCol("boxes_given")]) || 0,
        last_play_date: String(psRows[pi][psCol("last_play_date")] || ""),
      });
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ stats: stats })));
  }

  if (action === "wakagym_update_reg") {
    var regId = params.reg_id || "";
    var field = params.field || "";
    var value = params.value || "";
    if (!regId || !field) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing params" })));
    var allowed = ["slip_status", "rewards_given", "note"];
    if (allowed.indexOf(field) < 0) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "invalid field" })));
    var tuWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    if (!tuWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no wakagym_reg tab" })));
    var tuRows = tuWs.getDataRange().getValues();
    var tuHdr = tuRows[0];
    var tuCol = function(n) { return tuHdr.indexOf(n); };
    for (var ui = 1; ui < tuRows.length; ui++) {
      if (String(tuRows[ui][tuCol("reg_id")]) === regId) {
        var fc = tuCol(field);
        if (fc >= 0) tuWs.getRange(ui + 1, fc + 1).setValue(value);
        return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
      }
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "reg not found" })));
  }

  if (action === "wakagym_give_box") {
    var boxPlayer = params.player_name || "";
    if (!boxPlayer) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing player_name" })));
    var bWs = ss.getSheetByName(TAB_PLAYER_STATS);
    if (!bWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no player_stats tab" })));
    var bRows = bWs.getDataRange().getValues();
    var bHdr = bRows[0];
    var bCol = function(n) { return bHdr.indexOf(n); };
    for (var bi = 1; bi < bRows.length; bi++) {
      if (String(bRows[bi][bCol("player_name")]).trim() === boxPlayer.trim()) {
        var given = Number(bRows[bi][bCol("boxes_given")]) || 0;
        given++;
        bWs.getRange(bi + 1, bCol("boxes_given") + 1).setValue(given);
        var boxAt = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
        if (bCol("last_play_date") >= 0) bWs.getRange(bi + 1, bCol("last_play_date") + 1).setValue("box " + boxAt);
        var boxUid = String(bRows[bi][bCol("line_user_id")] || "");
        if (boxUid && boxUid !== "dev_user") {
          _linePush(boxUid, "🎁 รับ Box เรียบร้อย!\nชื่อแข่ง: " + boxPlayer + "\nBox ที่ได้: " + given);
        }
        return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, boxes_given: given })));
      }
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "player not found" })));
  }

  if (action === "verify_staff_pin") {
    var pin = String(params.pin || "").trim();
    if (!pin) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing pin" })));
    var cfgWs3 = ss.getSheetByName(TAB_CONFIG);
    var adminPin = _getConfigValue(cfgWs3, "admin_pin") || "waka99";
    if (pin === adminPin) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, role: "admin", branch: "ทั้งหมด" })));
    }
    if (cfgWs3) {
      var cfgRows3 = cfgWs3.getDataRange().getValues();
      for (var ci = 1; ci < cfgRows3.length; ci++) {
        var key = String(cfgRows3[ci][0] || "");
        var val = String(cfgRows3[ci][1] || "");
        if (key.indexOf("staff_pin_") === 0 && val === pin) {
          var branchName = key.replace("staff_pin_", "");
          return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, role: "staff", branch: branchName })));
        }
      }
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "invalid" })));
  }

  if (action === "wakagym_summary") {
    var sumDate = params.date || Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var sumWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    if (!sumWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no data" })));
    var sumRows = sumWs.getDataRange().getValues();
    var sumHdr = sumRows[0];
    var sc = function(n) { return sumHdr.indexOf(n); };

    var totalPlayers = 0, totalTokens = 0, totalPromo = 0, rewardsGiven = 0;
    var cashAmount = 0, transferAmount = 0;
    var bankBreakdown = {};

    for (var si = 1; si < sumRows.length; si++) {
      if (String(sumRows[si][sc("event_date")]) !== sumDate) continue;
      totalPlayers++;
      var pm = String(sumRows[si][sc("payment_method")] || "transfer");
      var bk = String(sumRows[si][sc("bank")] || "ไม่ระบุ");
      var entryFee = Number(sumRows[si][sc("note")] || 0) || 200;

      totalTokens += Number(sumRows[si][sc("tokens_earned")] || 0);
      totalPromo += Number(sumRows[si][sc("promo_packs")] || 0);
      if (String(sumRows[si][sc("rewards_given")]).toLowerCase() === "true") rewardsGiven++;

      if (pm === "cash") {
        cashAmount += entryFee;
      } else {
        transferAmount += entryFee;
        if (!bankBreakdown[bk]) bankBreakdown[bk] = 0;
        bankBreakdown[bk] += entryFee;
      }
    }

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
    var evSs = ss;
    var evWs = _ensureTab(evSs, TAB_WAKAGYM_EVENTS, [
      "event_id", "date", "branch", "tier", "entry_fee", "status", "created_by"
    ]);
    var evNow = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    var evId = "EV" + evNow.replace(/-/g, "");
    var evRows = evWs.getDataRange().getValues();
    var evCount = 0;
    for (var ei = 1; ei < evRows.length; ei++) {
      var ed = String(evRows[ei][1]);
      if (ed.length > 10) ed = ed.substring(0, 10);
      if (ed === evNow) evCount++;
    }
    evId += "-" + (evCount + 1);
    evWs.appendRow([evId, evNow, evBranch, evTier, TIER_CONFIG[evTier].fee, "open", params.created_by || "staff"]);
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
    var srSs = ss;
    var srRegWs = srSs.getSheetByName(TAB_WAKAGYM_REG);
    var srStatsWs = srSs.getSheetByName(TAB_PLAYER_STATS);
    if (!srRegWs || !srStatsWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no data" })));

    var srEvent = null;
    if (srEventId) {
      var evWs2 = srSs.getSheetByName(TAB_WAKAGYM_EVENTS);
      if (evWs2) {
        var evRows2 = evWs2.getDataRange().getValues();
        var evHdr2 = evRows2[0];
        var evc = function(n) { return evHdr2.indexOf(n); };
        for (var ei2 = 1; ei2 < evRows2.length; ei2++) {
          if (String(evRows2[ei2][evc("event_id")]) === srEventId) {
            srEvent = { tier: String(evRows2[ei2][evc("tier")] || "L") };
            break;
          }
        }
      }
    }
    var tier = srEvent ? srEvent.tier : "L";

    var regRows = srRegWs.getDataRange().getValues();
    var regHdr = regRows[0];
    var rc = function(n) { return regHdr.indexOf(n); };

    var stRows = srStatsWs.getDataRange().getValues();
    var stHdr = stRows[0];
    var stc = function(n) { return stHdr.indexOf(n); };

    var processed = [];
    for (var ri = 0; ri < srResults.length; ri++) {
      var sr = srResults[ri];
      var regId = sr.reg_id || "";
      var placement = sr.placement || "";
      var wins = Math.min(Math.max(parseInt(sr.wins_3match) || 0, 0), 3);
      var tokens = (TOKEN_TABLE[tier] && TOKEN_TABLE[tier][placement]) || 0;
      var promos = PROMO_TABLE[wins] || 1;

      for (var rj = 1; rj < regRows.length; rj++) {
        if (String(regRows[rj][rc("reg_id")]) !== regId) continue;
        if (rc("placement") >= 0) srRegWs.getRange(rj + 1, rc("placement") + 1).setValue(placement);
        if (rc("wins_3match") >= 0) srRegWs.getRange(rj + 1, rc("wins_3match") + 1).setValue(wins);
        if (rc("tokens_earned") >= 0) srRegWs.getRange(rj + 1, rc("tokens_earned") + 1).setValue(tokens);
        if (rc("promo_packs") >= 0) srRegWs.getRange(rj + 1, rc("promo_packs") + 1).setValue(promos);

        var pName = String(regRows[rj][rc("player_name")] || "").trim();
        var lineUid = String(regRows[rj][rc("line_user_id")] || "");
        for (var si = 1; si < stRows.length; si++) {
          if (String(stRows[si][stc("player_name")]).trim() !== pName) continue;
          var curTokens = Number(stRows[si][stc("total_tokens")]) || 0;
          var curBoxes = Number(stRows[si][stc("boxes_earned")]) || 0;
          curTokens += tokens;
          while (curTokens >= TOKEN_BOX_THRESHOLD) {
            curTokens -= TOKEN_BOX_THRESHOLD;
            curBoxes++;
          }
          srStatsWs.getRange(si + 1, stc("total_tokens") + 1).setValue(curTokens);
          srStatsWs.getRange(si + 1, stc("boxes_earned") + 1).setValue(curBoxes);
          stRows[si][stc("total_tokens")] = curTokens;
          stRows[si][stc("boxes_earned")] = curBoxes;
          break;
        }

        processed.push({ reg_id: regId, player_name: pName, placement: placement, tokens: tokens, promo_packs: promos, line_user_id: lineUid });
        break;
      }
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
    var grWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    if (!grWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no data" })));
    var grRows = grWs.getDataRange().getValues();
    var grHdr = grRows[0];
    var grc = function(n) { return grHdr.indexOf(n); };
    for (var gi = 1; gi < grRows.length; gi++) {
      if (String(grRows[gi][grc("reg_id")]) !== grRegId) continue;
      if (String(grRows[gi][grc("rewards_given")]).toLowerCase() === "true") {
        return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
      }
      var givenAt = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
      grWs.getRange(gi + 1, grc("rewards_given") + 1).setValue("TRUE");
      if (grc("note") >= 0) grWs.getRange(gi + 1, grc("note") + 1).setValue("แจก " + givenAt);
      var grUid = String(grRows[gi][grc("line_user_id")] || "");
      var grName = String(grRows[gi][grc("player_name")] || "");
      var grTokens = Number(grRows[gi][grc("tokens_earned")]) || 0;
      var grPromos = Number(grRows[gi][grc("promo_packs")]) || 0;
      if (grUid && grUid !== "dev_user") {
        var grMsg = "✅ รับรางวัลแล้ว!\nชื่อแข่ง: " + grName;
        if (grTokens > 0) grMsg += "\n🪙 Token: " + grTokens;
        if (grPromos > 0) grMsg += "\n📦 Promo Pack: " + grPromos + " ซอง";
        _linePush(grUid, grMsg);
      }
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: false })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
  }

  if (action === "wakagym_lookup") {
    var lookupId = String(params.group_id || params.reg_id || "").trim();
    if (!lookupId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing id" })));
    var luWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    if (!luWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no data" })));
    var luRows = luWs.getDataRange().getValues();
    var luHdr = luRows[0];
    var luCol = function(n) { return luHdr.indexOf(n); };
    var found = [];
    for (var li = 1; li < luRows.length; li++) {
      var gid = String(luRows[li][luCol("group_id")] || "");
      var rid = String(luRows[li][luCol("reg_id")] || "");
      if (gid === lookupId || rid === lookupId) {
        found.push({
          reg_id: rid,
          group_id: gid,
          player_name: String(luRows[li][luCol("player_name")] || ""),
          real_name: String(luRows[li][luCol("real_name")] || ""),
          placement: String(luRows[li][luCol("placement")] || ""),
          wins_3match: String(luRows[li][luCol("wins_3match")] || ""),
          tokens_earned: Number(luRows[li][luCol("tokens_earned")]) || 0,
          promo_packs: Number(luRows[li][luCol("promo_packs")]) || 0,
          rewards_given: String(luRows[li][luCol("rewards_given")] || ""),
          slip_status: String(luRows[li][luCol("slip_status")] || ""),
          slip_url: String(luRows[li][luCol("slip_url")] || ""),
          payment_method: String(luRows[li][luCol("payment_method")] || ""),
          bank: String(luRows[li][luCol("bank")] || ""),
          note: String(luRows[li][luCol("note")] || ""),
          event_date: String(luRows[li][luCol("event_date")] || ""),
          row_num: li + 1,
        });
      }
    }
    if (found.length === 0) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));

    var statsWsLu = ss.getSheetByName(TAB_PLAYER_STATS);
    var statsMap = {};
    if (statsWsLu) {
      var stRows = statsWsLu.getDataRange().getValues();
      var stHdr = stRows[0];
      var stCol = function(n) { return stHdr.indexOf(n); };
      for (var si = 1; si < stRows.length; si++) {
        statsMap[String(stRows[si][stCol("player_name")]).trim()] = {
          total_tokens: Number(stRows[si][stCol("total_tokens")]) || 0,
          boxes_earned: Number(stRows[si][stCol("boxes_earned")]) || 0,
          boxes_given: Number(stRows[si][stCol("boxes_given")]) || 0,
        };
      }
    }
    for (var fi = 0; fi < found.length; fi++) {
      var pStat = statsMap[found[fi].player_name] || {};
      found[fi].total_tokens = pStat.total_tokens || 0;
      found[fi].boxes_earned = pStat.boxes_earned || 0;
      found[fi].boxes_given_count = pStat.boxes_given || 0;
    }

    return _cors(ContentService.createTextOutput(JSON.stringify({ players: found })));
  }

  if (action === "wakagym_give_cards") {
    var gcRegId = String(params.reg_id || "").trim();
    if (!gcRegId) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "missing reg_id" })));
    var gcWs = ss.getSheetByName(TAB_WAKAGYM_REG);
    if (!gcWs) return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no data" })));
    var gcRows = gcWs.getDataRange().getValues();
    var gcHdr = gcRows[0];
    var gcCol = function(n) { return gcHdr.indexOf(n); };
    for (var gi = 1; gi < gcRows.length; gi++) {
      if (String(gcRows[gi][gcCol("reg_id")]) === gcRegId) {
        if (String(gcRows[gi][gcCol("rewards_given")]).toLowerCase() === "true") {
          return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));
        }
        var givenAt = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");
        gcWs.getRange(gi + 1, gcCol("rewards_given") + 1).setValue("TRUE");
        if (gcCol("note") >= 0) gcWs.getRange(gi + 1, gcCol("note") + 1).setValue("แจก " + givenAt);
        var gcUid = String(gcRows[gi][gcCol("line_user_id")] || "");
        var gcName = String(gcRows[gi][gcCol("player_name")] || gcRows[gi][gcCol("real_name")] || "");
        var gcTokens = String(gcRows[gi][gcCol("tokens_earned")] || "0");
        var gcPromo = String(gcRows[gi][gcCol("promo_packs")] || "0");
        if (gcUid && gcUid !== "dev_user") {
          var gcMsg = "🏆 รับรางวัล WAKA GYM!\nชื่อแข่ง: " + gcName
            + "\n🪙 Token: " + gcTokens
            + "\n🎁 Promo Pack: " + gcPromo + " ซอง";
          _linePush(gcUid, gcMsg);
        }
        return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: false })));
      }
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "not found" })));
  }

  return _cors(ContentService.createTextOutput(JSON.stringify({ error: "unknown action" })));
}

function handleSendConfirmLink(data) {
  var trackUrl = data.confirmUrl;
  var msg = "";
  if (data.msgType === "ready") {
    msg = "สินค้าพร้อมรับที่สาขาแล้ว!\n\nออเดอร์: #" + data.orderId + "\n\nกดดูสถานะ / ยืนยันรับของ:\n" + trackUrl;
  } else if (data.msgType === "shipped") {
    msg = "สินค้ากำลังจัดส่งไปสาขา\n\nออเดอร์: #" + data.orderId + "\n\nกดดูสถานะ:\n" + trackUrl;
  } else if (data.msgType === "handover") {
    msg = "สาขาส่งมอบสินค้าแล้ว กรุณากดยืนยันรับของ\n\nออเดอร์: #" + data.orderId + "\n\nกดยืนยัน:\n" + trackUrl;
  } else {
    msg = "อัปเดตออเดอร์ #" + data.orderId + "\n\nกดดูสถานะ:\n" + trackUrl;
  }
  _linePush(data.lineUserId, msg);
  return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
}

function isDuplicateSlip(ss, ref) {
  if (!ref) return false;
  var cache = CacheService.getScriptCache();
  var cacheKey = "slip_ref_" + String(ref).trim();
  if (cache.get(cacheKey)) return true;

  var ws = ss.getSheetByName(TAB_ORDERS);
  if (!ws) return false;
  var lastRow = ws.getLastRow();
  if (lastRow < 2) return false;
  var hdr = ws.getRange(1, 1, 1, ws.getLastColumn()).getValues()[0];
  var refCol = hdr.indexOf("slip_txn_id");
  if (refCol < 0) return false;
  var refs = ws.getRange(2, refCol + 1, lastRow - 1, 1).getValues();
  for (var i = 0; i < refs.length; i++) {
    if (String(refs[i][0]).trim() === String(ref).trim()) {
      cache.put(cacheKey, "1", 3600);
      return true;
    }
  }
  return false;
}

function isCorrectAccount(ss, toAccount, toName) {
  var cfgWs = ss.getSheetByName(TAB_CONFIG);
  if (!cfgWs) return true;

  var acctOk = true;
  var shopAccount = _getConfigValue(cfgWs, "bank_account");
  if (shopAccount && toAccount) {
    var clean1 = String(toAccount).replace(/[-\s]/g, "");
    var clean2 = String(shopAccount).replace(/[-\s]/g, "");
    var digits1 = clean1.replace(/[^0-9]/g, "");
    acctOk = clean1.indexOf(clean2) >= 0 || clean2.indexOf(clean1) >= 0
      || (digits1.length >= 4 && clean2.indexOf(digits1) >= 0);
  }

  var nameOk = true;
  if (toName) {
    var shopNameTh = _getConfigValue(cfgWs, "bank_account_name") || "";
    var shopNameEn = _getConfigValue(cfgWs, "bank_account_name_en") || "";
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
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var shipId = "SH" + Utilities.formatDate(new Date(), "Asia/Bangkok", "yyMMddHHmmss");

    var shWs = ss.getSheetByName(TAB_SHIPMENTS);
    if (!shWs) {
      shWs = ss.insertSheet(TAB_SHIPMENTS);
      shWs.appendRow(["shipment_id", "timestamp", "to_branch", "status", "items_json", "received_at", "notes"]);
    }

    // D4: ตรวจ duplicate shipment_id ก่อน append
    var shExisting = shWs.getDataRange().getValues();
    for (var si = 1; si < shExisting.length; si++) {
      if (String(shExisting[si][0]) === shipId) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ล็อตนี้ถูกสร้างไปแล้ว กรุณารอสักครู่แล้วลองใหม่" })));
      }
    }

    var items = data.items || [];
    // ตัดสต็อกกลาง — batch write แทน per-cell
    var shCatWs = ss.getSheetByName(TAB_CATALOG);
    if (shCatWs) {
      var catRange = shCatWs.getDataRange();
      var sRows = catRange.getValues();
      var catMap = {};
      for (var ri = 1; ri < sRows.length; ri++) catMap[String(sRows[ri][0]).trim()] = ri;
      var catChanged = false;
      for (var idx = 0; idx < items.length; idx++) {
        var it = items[idx];
        var ri = catMap[String(it.name).trim()];
        if (ri === undefined) continue;
        var totalBox = (it.qty_box || 0) + (it.qty_box_extra || 0);
        var totalPack = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
        if (totalBox > 0)  { sRows[ri][7] = Math.max(0, (Number(sRows[ri][7]) || 0) - totalBox);  catChanged = true; }
        if (totalPack > 0) { sRows[ri][8] = Math.max(0, (Number(sRows[ri][8]) || 0) - totalPack); catChanged = true; }
      }
      if (catChanged) catRange.setValues(sRows);
    }

    shWs.appendRow([shipId, now, data.to_branch || "", "จัดส่ง", JSON.stringify(items), "", ""]);
    lock.releaseLock();

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
        _linePush(groupId, "📦 สร้างล็อตส่งสาขา " + (data.to_branch || "") + "\n\n" + shipId + " — " + now + "\n\n" + itemLines + "\n\nเมื่อสินค้าถึงสาขาแล้ว กดรับของที่:\n" + receiveUrl);
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
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var shWs = ss.getSheetByName(TAB_SHIPMENTS);
    if (!shWs) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no shipments tab" }))); }
    var shRows = shWs.getDataRange().getValues();
    var shHdr = shRows[0];
    var colIdx = function(n) { return shHdr.indexOf(n); };
    for (var i = 1; i < shRows.length; i++) {
      if (String(shRows[i][colIdx("shipment_id")]) !== String(data.shipment_id)) continue;
      var status = String(shRows[i][colIdx("status")] || "");
      if (status === "รับแล้ว" || status === "ยกเลิก") continue;
      // คืนสต็อกกลาง — batch write
      var items = [];
      try { items = JSON.parse(String(shRows[i][colIdx("items_json")] || "[]")); } catch(_) {}
      var catWs = ss.getSheetByName(TAB_CATALOG);
      if (catWs && items.length > 0) {
        var catRange = catWs.getDataRange();
        var catRows = catRange.getValues();
        var catMap = {};
        for (var ri = 1; ri < catRows.length; ri++) catMap[String(catRows[ri][0]).trim()] = ri;
        var catChanged = false;
        for (var idx = 0; idx < items.length; idx++) {
          var it = items[idx];
          var ri = catMap[String(it.name).trim()];
          if (ri === undefined) continue;
          var totalBox = (it.qty_box || 0) + (it.qty_box_extra || 0);
          var totalPack = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
          if (totalBox > 0)  { catRows[ri][7] = (Number(catRows[ri][7]) || 0) + totalBox;  catChanged = true; }
          if (totalPack > 0) { catRows[ri][8] = (Number(catRows[ri][8]) || 0) + totalPack; catChanged = true; }
        }
        if (catChanged) catRange.setValues(catRows);
      }
      shWs.getRange(i + 1, colIdx("status") + 1).setValue("ยกเลิก");
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
    }
    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบลอต" })));
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
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var shWs = ss.getSheetByName(TAB_SHIPMENTS);
    if (!shWs) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no shipments tab" }))); }
    var shRows = shWs.getDataRange().getValues();
    var shHdr = shRows[0];
    // D2: ข้าม rows ที่รับแล้ว/ยกเลิก — หา row ที่ status = "จัดส่ง" เท่านั้น
    var shipRow = -1, branch = "", items = [];
    for (var i = 1; i < shRows.length; i++) {
      if (String(shRows[i][0]) !== data.shipment_id) continue;
      var rowStatus = String(shRows[i][3] || "");
      if (rowStatus === "รับแล้ว" || rowStatus === "ยกเลิก") continue;
      shipRow = i;
      branch = String(shRows[i][2]);
      try { items = JSON.parse(shRows[i][4] || "[]"); } catch(e) {}
      break;
    }
    if (shipRow < 0) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true }))); }

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    shWs.getRange(shipRow + 1, 4).setValue("รับแล้ว");
    shWs.getRange(shipRow + 1, 6).setValue(now);

    // เพิ่มสต็อกสาขา — batch write แทน per-cell
    var bsWs = ss.getSheetByName(TAB_STOCK_BRANCH);
    if (!bsWs) {
      bsWs = ss.insertSheet(TAB_STOCK_BRANCH);
      bsWs.appendRow(["name", "category", "branch", "qty_box", "qty_pack"]);
    }
    var bsRange = bsWs.getDataRange();
    var bsRows = bsRange.getValues();
    var bsMap = {};
    for (var r = 1; r < bsRows.length; r++) {
      bsMap[String(bsRows[r][0]).trim() + "||" + String(bsRows[r][2]).trim()] = r;
    }
    var bsChanged = false;
    var newBsRows = [];
    for (var idx = 0; idx < items.length; idx++) {
      var it = items[idx];
      var addBox = (it.qty_box || 0) + (it.qty_box_extra || 0);
      var addPack = (it.qty_pack || 0) + (it.qty_pack_extra || 0);
      var bsKey = String(it.name).trim() + "||" + branch;
      var bsIdx = bsMap[bsKey];
      if (bsIdx !== undefined) {
        if (addBox  > 0) { bsRows[bsIdx][3] = (Number(bsRows[bsIdx][3]) || 0) + addBox;  bsChanged = true; }
        if (addPack > 0) { bsRows[bsIdx][4] = (Number(bsRows[bsIdx][4]) || 0) + addPack; bsChanged = true; }
      } else {
        newBsRows.push([it.name, it.category || "", branch, addBox, addPack]);
      }
    }
    if (bsChanged) bsRange.setValues(bsRows);
    for (var nr = 0; nr < newBsRows.length; nr++) bsWs.appendRow(newBsRows[nr]);

    // แจ้ง LINE ลูกค้าทุกคนที่มีออเดอร์ยืนยัน + สาขานี้ + ยังไม่ส่ง
    var ws = ss.getSheetByName(TAB_ORDERS);
    if (ws) {
      var oRows = ws.getDataRange().getValues();
      var oHdr = oRows[0];
      var oCol = function(name) { return oHdr.indexOf(name); };
      for (var j = 1; j < oRows.length; j++) {
        var oBranch = oRows[j][oCol("branch")] || "";
        var oSlip = oRows[j][oCol("slip_status")] || "";
        var oFf = oRows[j][oCol("fulfillment")] || "";
        if (oBranch !== branch || oSlip !== "ยืนยัน") continue;
        if (["พร้อมรับ","บางส่วน","รับบางส่วนแล้ว","สาขายืนยัน","รับแล้ว"].indexOf(oFf) >= 0) continue;
        // อัปเดต fulfillment เป็น "พร้อมรับ"
        if (oCol("fulfillment") >= 0) ws.getRange(j + 1, oCol("fulfillment") + 1).setValue("พร้อมรับ");
        if (oCol("fulfilled_at") >= 0) ws.getRange(j + 1, oCol("fulfilled_at") + 1).setValue(now);
        var uid = oRows[j][oCol("line_user_id")] || "";
        var oid = String(oRows[j][oCol("order_id")] || "");
        if (uid) {
          var trackUrl = "https://waka-liff.vercel.app/confirm.html?order=" + oid;
          _linePush(uid, "สินค้าพร้อมรับที่สาขา" + branch + " แล้ว!\n\nออเดอร์: #" + oid + "\n\nดูสถานะ:\n" + trackUrl);
        }
      }
    }

    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── ส่งมอบลูกค้า: ตัดสต็อกสาขา ────────────────────────────────────────────
// data: { order_id }
function handleHandoverOrder(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var ws = ss.getSheetByName(TAB_ORDERS);
    var oRows = ws.getDataRange().getValues();
    var oHdr = oRows[0];
    var oCol = function(name) { return oHdr.indexOf(name); };
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");

    for (var i = 1; i < oRows.length; i++) {
      if (String(oRows[i][oCol("order_id")]) !== data.order_id) continue;
      var branch = oRows[i][oCol("branch")] || "";
      var items = [];
      try { items = JSON.parse(oRows[i][oCol("items_json")] || "[]"); } catch(e) {}

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

      // ตัดสต็อกสาขาเฉพาะ itemsToHandover — batch write
      var bsWs = ss.getSheetByName(TAB_STOCK_BRANCH);
      if (bsWs) {
        var bsRange = bsWs.getDataRange();
        var bsRows = bsRange.getValues();
        var bsMap = {};
        for (var r = 1; r < bsRows.length; r++) {
          bsMap[String(bsRows[r][0]).trim() + "||" + String(bsRows[r][2]).trim()] = r;
        }
        var bsChanged = false;
        for (var idx = 0; idx < itemsToHandover.length; idx++) {
          var it = itemsToHandover[idx];
          var bsKey = String(it.name).trim() + "||" + branch;
          var bsIdx = bsMap[bsKey];
          if (bsIdx === undefined) continue;
          if (it.type === "box") {
            bsRows[bsIdx][3] = Math.max(0, (Number(bsRows[bsIdx][3]) || 0) - (it.qty || 1));
          } else {
            bsRows[bsIdx][4] = Math.max(0, (Number(bsRows[bsIdx][4]) || 0) - (it.qty || 1));
          }
          bsChanged = true;
        }
        if (bsChanged) bsRange.setValues(bsRows);
      }

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
      ws.getRange(i + 1, oCol("items_json") + 1).setValue(JSON.stringify(items));

      // กำหนด fulfillment ใหม่
      var allDone = items.every(function(it) { return !!it.handed_at || !!it.cancelled_at; });
      var newFf = allDone ? "สาขายืนยัน" : "รับบางส่วนแล้ว";
      if (oCol("fulfillment") >= 0) ws.getRange(i + 1, oCol("fulfillment") + 1).setValue(newFf);
      if (oCol("staff_confirmed_at") >= 0) ws.getRange(i + 1, oCol("staff_confirmed_at") + 1).setValue(now);
      _clearDashCache();

      // แจ้งลูกค้า
      var uid = oRows[i][oCol("line_user_id")] || "";
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
      }

      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, time: now, fulfillment: newFf })));
    }
    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
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
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var ws = ss.getSheetByName(TAB_ORDERS);
    var oRows = ws.getDataRange().getValues();
    var oHdr = oRows[0];
    var oCol = function(name) { return oHdr.indexOf(name); };
    var indices = data.indices || [];
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm:ss");

    for (var i = 1; i < oRows.length; i++) {
      if (String(oRows[i][oCol("order_id")]) !== String(data.order_id)) continue;

      var branch = oRows[i][oCol("branch")] || "";
      var uid = oRows[i][oCol("line_user_id")] || "";
      var items = [];
      try { items = JSON.parse(oRows[i][oCol("items_json")] || "[]"); } catch(e) {}

      // ตั้ง ready_at บน items ที่เลือก (ที่ยังไม่ handed_at และไม่ cancelled)
      for (var ii = 0; ii < indices.length; ii++) {
        var idx = indices[ii];
        if (idx >= 0 && idx < items.length && !items[idx].handed_at && !items[idx].cancelled_at) {
          items[idx].ready_at = now;
        }
      }

      ws.getRange(i + 1, oCol("items_json") + 1).setValue(JSON.stringify(items));

      // fulfillment ใหม่
      var activeItems = items.filter(function(it) { return !it.cancelled_at; });
      var allReady = activeItems.length > 0 && activeItems.every(function(it) { return !!it.ready_at || !!it.handed_at; });
      var newFf = allReady ? "พร้อมรับ" : "บางส่วน";
      ws.getRange(i + 1, oCol("fulfillment") + 1).setValue(newFf);
      ws.getRange(i + 1, oCol("fulfilled_at") + 1).setValue(now);
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
      }

      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, fulfillment: newFf })));
    }
    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
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
    var ws = ss.getSheetByName(TAB_ORDERS);
    var oRows = ws.getDataRange().getValues();
    var oHdr = oRows[0];
    var oCol = function(name) { return oHdr.indexOf(name); };
    var indices = data.indices || [];
    var reason = String(data.reason || "");
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");

    for (var i = 1; i < oRows.length; i++) {
      if (String(oRows[i][oCol("order_id")]) !== String(data.order_id)) continue;

      var uid = oRows[i][oCol("line_user_id")] || "";
      var items = [];
      try { items = JSON.parse(oRows[i][oCol("items_json")] || "[]"); } catch(e) {}

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
      restoreStock(ss, cancelledItems);
      restoreCatalogLimits(ss, cancelledItems);

      ws.getRange(i + 1, oCol("items_json") + 1).setValue(JSON.stringify(items));

      // ถ้าทุก item cancelled → ปิด order
      var allCancelled = items.every(function(it) { return !!it.cancelled_at || !!it.handed_at; });
      var onlyHandedRemain = items.every(function(it) { return !!it.handed_at || !!it.cancelled_at; });
      if (items.every(function(it) { return !!it.cancelled_at; })) {
        ws.getRange(i + 1, oCol("fulfillment") + 1).setValue("ยกเลิก");
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

      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, cancelled: cancelledItems.length })));
    }
    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
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
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var ws = ss.getSheetByName(TAB_ORDERS);
    var rows = ws.getDataRange().getValues();
    var hdr = rows[0];
    var col = function(name) { return hdr.indexOf(name); };

    for (var i = 1; i < rows.length; i++) {
      if (String(rows[i][col("order_id")]) !== data.order_id) continue;
      var currentSlip = rows[i][col("slip_status")] || "";
      if (currentSlip === "ยืนยัน") return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true, already: true })));

      ws.getRange(i + 1, col("slip_status") + 1).setValue("ยืนยัน");
      var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
      ws.getRange(i + 1, col("notes") + 1).setValue("Admin confirm " + now);

      var uid = rows[i][col("line_user_id")] || "";
      var orderId = String(rows[i][col("order_id")] || "");
      var branch = rows[i][col("branch")] || "";
      var total = rows[i][col("total")] || 0;
      var items = [];
      try { items = JSON.parse(rows[i][col("items_json")] || "[]"); } catch(_) {}

      if (uid) {
        var itemsText = items.map(function(it) {
          var unit = it.type === "box" ? "กล่อง" : "ซอง";
          return "  - " + it.name + " (" + unit + ") x" + it.qty;
        }).join("\n");
        var isDelivery = branch === "จัดส่ง";
        _linePush(uid, "ยืนยันการชำระเงินแล้ว ✅\n\nออเดอร์: #" + orderId + "\n\n" + itemsText + "\n\nยอดรวม: " + total + " บาท\n" + (isDelivery ? "จัดส่งพัสดุ" : "รับที่สาขา: " + branch) + "\n\nทีมงานจะแจ้งเมื่อสินค้าพร้อมรับครับ");
      }

      return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
    }
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "order not found" })));
  } catch (err) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  } finally {
    lock.releaseLock();
  }
}

// ── เพิ่มสต็อกสินค้าเดิม ──
// data: { name, add_box, add_pack }
function handleAddStock(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var ws = ss.getSheetByName(TAB_CATALOG);
    if (!ws) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no _catalog tab" }))); }
    var rows = ws.getDataRange().getValues();
    var found = false;
    for (var r = 1; r < rows.length; r++) {
      if (String(rows[r][0]).trim() === String(data.name).trim()) {
        if (data.add_box) ws.getRange(r + 1, 8).setValue((Number(rows[r][7]) || 0) + Number(data.add_box));
        if (data.add_pack) ws.getRange(r + 1, 9).setValue((Number(rows[r][8]) || 0) + Number(data.add_pack));
        found = true;
        break;
      }
    }
    if (!found) {
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้าใน _catalog: " + data.name })));
    }

    // อัปเดต limit ใน _catalog ถ้าส่งมา
    if (data.limit_box !== undefined && data.limit_box !== null || data.limit_pack !== undefined && data.limit_pack !== null) {
      var catWs = ss.getSheetByName(TAB_CATALOG);
      if (catWs) {
        var catRows = catWs.getDataRange().getValues();
        for (var c = 1; c < catRows.length; c++) {
          if (String(catRows[c][0]).trim() === String(data.name).trim()) {
            if (data.limit_box !== undefined && data.limit_box !== null) catWs.getRange(c + 1, 10).setValue(Number(data.limit_box));
            if (data.limit_pack !== undefined && data.limit_pack !== null) catWs.getRange(c + 1, 11).setValue(Number(data.limit_pack));
            CacheService.getScriptCache().remove("catalog_config");
            break;
          }
        }
      }
    }

    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เพิ่มสินค้าใหม่ใน _catalog + stock ──
// data: { name, category, price_box, price_pack, cost_box, cost_pack, barcode, initial_box, initial_pack }
function handleAddProduct(data) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var catWs = ss.getSheetByName(TAB_CATALOG);
    if (!catWs) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no _catalog tab" }))); }

    // เช็คชื่อซ้ำ
    var catRows = catWs.getDataRange().getValues();
    for (var i = 1; i < catRows.length; i++) {
      if (String(catRows[i][0]).trim() === String(data.name).trim()) {
        lock.releaseLock();
        return _cors(ContentService.createTextOutput(JSON.stringify({ error: "สินค้าชื่อนี้มีอยู่แล้ว" })));
      }
    }

    // เพิ่มใน _catalog: A=name, B=category, C=slug, D=cost_box, E=cost_pack, F=price_box, G=price_pack, H=qty_box, I=qty_pack, J=limit_box, K=limit_pack, L=active, M=image_url, N=barcode, O=notice
    var limBox = (data.limit_box === "" || data.limit_box === undefined || data.limit_box === null) ? "" : Number(data.limit_box);
    var limPack = (data.limit_pack === "" || data.limit_pack === undefined || data.limit_pack === null) ? "" : Number(data.limit_pack);
    var newRow = [
      data.name, data.category || "", "",
      Number(data.cost_box) || 0, Number(data.cost_pack) || 0,
      Number(data.price_box) || 0, Number(data.price_pack) || 0,
      Number(data.initial_box) || 0, Number(data.initial_pack) || 0,
      limBox, limPack, "TRUE", data.image_url || "", data.barcode || "", ""
    ];
    catWs.appendRow(newRow);

    CacheService.getScriptCache().remove("catalog_config");
    lock.releaseLock();
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
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var catWs = ss.getSheetByName(TAB_CATALOG);
    if (!catWs) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "no _catalog tab" }))); }
    var catRows = catWs.getDataRange().getValues();
    var targetRow = -1;
    for (var i = 1; i < catRows.length; i++) {
      if (String(catRows[i][0]).trim() === String(data.name).trim()) { targetRow = i + 1; break; }
    }
    if (targetRow === -1) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบสินค้า: " + data.name }))); }
    if (data.category !== undefined) catWs.getRange(targetRow, 2).setValue(data.category);
    if (data.cost_box !== undefined) catWs.getRange(targetRow, 4).setValue(Number(data.cost_box) || 0);
    if (data.cost_pack !== undefined) catWs.getRange(targetRow, 5).setValue(Number(data.cost_pack) || 0);
    if (data.price_box !== undefined) catWs.getRange(targetRow, 6).setValue(Number(data.price_box) || 0);
    if (data.price_pack !== undefined) catWs.getRange(targetRow, 7).setValue(Number(data.price_pack) || 0);
    if (data.limit_box !== undefined) catWs.getRange(targetRow, 10).setValue(data.limit_box === "" ? "" : Number(data.limit_box));
    if (data.limit_pack !== undefined) catWs.getRange(targetRow, 11).setValue(data.limit_pack === "" ? "" : Number(data.limit_pack));
    if (data.active !== undefined) catWs.getRange(targetRow, 12).setValue(data.active ? "TRUE" : "FALSE");
    if (data.image_url !== undefined) catWs.getRange(targetRow, 13).setValue(data.image_url || "");
    if (data.barcode !== undefined) catWs.getRange(targetRow, 14).setValue(data.barcode || "");
    if (data.notice !== undefined) catWs.getRange(targetRow, 15).setValue(data.notice || "");
    CacheService.getScriptCache().remove("catalog_config");
    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

// ── เบิกสินค้าจากสต็อกสาขา ────────────────────────────────────────────────
// data: { branch, name, type, qty, reason }
function handleWithdrawStock(data) {
  var branch = String(data.branch || "").trim();
  var name   = String(data.name   || "").trim();
  var type   = String(data.type   || "box").trim();
  var qty    = Number(data.qty)   || 0;
  var reason = String(data.reason || "").trim();

  if (!branch || !name || qty <= 0) {
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ข้อมูลไม่ครบ (branch, name, qty)" })));
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var ss = SpreadsheetApp.openById(SHEET_ID);
    var bsWs = ss.getSheetByName(TAB_STOCK_BRANCH);
    if (!bsWs) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีข้อมูลสต็อกสาขา" })));
    }

    var bsRows = bsWs.getDataRange().getValues();
    var found = false;
    for (var r = 1; r < bsRows.length; r++) {
      if (String(bsRows[r][0]).trim() !== name) continue;
      if (String(bsRows[r][2]).trim() !== branch) continue;
      if (type === "box") {
        bsWs.getRange(r + 1, 4).setValue(Math.max(0, (Number(bsRows[r][3]) || 0) - qty));
      } else {
        bsWs.getRange(r + 1, 5).setValue(Math.max(0, (Number(bsRows[r][4]) || 0) - qty));
      }
      found = true;
      break;
    }
    if (!found) {
      lock.releaseLock();
      return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch })));
    }

    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    var wWs = ss.getSheetByName("withdrawals");
    if (!wWs) {
      wWs = ss.insertSheet("withdrawals");
      wWs.appendRow(["timestamp", "branch", "name", "type", "qty", "reason"]);
    }
    wWs.appendRow([now, branch, name, type, qty, reason]);

    lock.releaseLock();
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
    var ss    = SpreadsheetApp.openById(SHEET_ID);
    var bsWs  = ss.getSheetByName(TAB_STOCK_BRANCH);
    var catWs = ss.getSheetByName(TAB_CATALOG);
    if (!bsWs)  { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีข้อมูลสต็อกสาขา" }))); }
    if (!catWs) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่มีข้อมูลคลังกลาง" }))); }

    // ลดสต็อกสาขา — batch write
    var bsRange = bsWs.getDataRange();
    var bsRows = bsRange.getValues();
    var found = false;
    for (var r = 1; r < bsRows.length; r++) {
      if (String(bsRows[r][0]).trim() !== name) continue;
      if (String(bsRows[r][2]).trim() !== branch) continue;
      if (qtyBox  > 0) bsRows[r][3] = Math.max(0, (Number(bsRows[r][3]) || 0) - qtyBox);
      if (qtyPack > 0) bsRows[r][4] = Math.max(0, (Number(bsRows[r][4]) || 0) - qtyPack);
      found = true;
      break;
    }
    if (!found) { lock.releaseLock(); return _cors(ContentService.createTextOutput(JSON.stringify({ error: "ไม่พบ " + name + " ในสต็อกสาขา " + branch }))); }
    bsRange.setValues(bsRows);

    // เพิ่มสต็อกกลาง — batch write
    var catRange = catWs.getDataRange();
    var catRows = catRange.getValues();
    var catChanged = false;
    for (var c = 1; c < catRows.length; c++) {
      if (String(catRows[c][0]).trim() !== name) continue;
      if (qtyBox  > 0) { catRows[c][7] = (Number(catRows[c][7]) || 0) + qtyBox;  catChanged = true; }
      if (qtyPack > 0) { catRows[c][8] = (Number(catRows[c][8]) || 0) + qtyPack; catChanged = true; }
      break;
    }
    if (catChanged) catRange.setValues(catRows);

    // บันทึก log
    var logWs = ss.getSheetByName("stock_returns");
    if (!logWs) { logWs = ss.insertSheet("stock_returns"); logWs.appendRow(["timestamp","branch","name","qty_box","qty_pack"]); }
    var now = Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd HH:mm");
    logWs.appendRow([now, branch, name, qtyBox, qtyPack]);

    CacheService.getScriptCache().remove("catalog_config");
    lock.releaseLock();
    return _cors(ContentService.createTextOutput(JSON.stringify({ ok: true })));
  } catch (err) {
    try { lock.releaseLock(); } catch(_) {}
    return _cors(ContentService.createTextOutput(JSON.stringify({ error: err.message })));
  }
}

function clearCache() {
  CacheService.getScriptCache().remove("catalog_config");
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
  var r1 = handlePartialReady({ order_id: testId, indices: [0] });
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

  // 3. ส่งมอบ (handover) — ควรหักเฉพาะ item[0]
  var r2 = handleHandoverOrder({ order_id: testId });
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
  var r3 = handlePartialCancelItems({ order_id: testId, indices: [1], reason: "test" });
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

