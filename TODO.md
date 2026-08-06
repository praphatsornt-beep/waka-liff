# WAKA — สิ่งที่ต้องทำ

---

## 🧹 คลีน LIFF / GAS (เริ่ม 2026-08-06)

เป้าหมาย: รวมงานของพนักงานสาขา (branch/staff/gym) เข้า `app.html` หน้าเดียว
ให้ครบ แล้วทยอยลบของเก่าที่ซ้ำซ้อน — เครื่องมือแอดมิน (warehouse/report/
products/tournament_*) **ตัดสินใจแล้วว่าเก็บแยกเหมือนเดิม ไม่รวม** (ตอบ
2026-08-06: งานใหญ่เกินไป ไม่คุ้มความเสี่ยง และพนักงานสาขาไม่ต้องใช้อยู่แล้ว)

### ทำแล้ว
- [x] แก้บั๊ก double-tap race ใน `confirmReceive`/`handoverOrder` (ปุ่มไม่ disable ทำให้กดรัวเด้ง prompt ซ้ำ)
- [x] เพิ่ม deep-link `app.html?order=xxx` และ `app.html#gym`
- [x] ลบ `wakagym-staff.html`, `branch.html` (ซ้ำซ้อนกับ `app.html` แล้ว) + แก้ลิงก์ที่เหลือให้ชี้ `app.html` แทน
- [x] ลบ GAS dead code: `isCorrectAccount`, `tournament_lookup`
- [x] ลบ pipeline ตรวจสลิปทัวร์นาเมนต์เก่าแบบ bank report (`process_registrations.py`, `match_bank_csv.py`, `verify_registrations.ipynb`/`.md`) — ไม่ได้ใช้แล้ว
- [x] role พนักงานสาขาใน `app.html`: bottom nav เหลือแค่ "เมนู" (ตัด สาขา/GYM ออก เพราะซ้ำซ้อนกับหน้าที่ auto-land อยู่แล้ว + การ์ด GYM ในหน้าสาขา)

### หมายเหตุ
- `notifyBranch()` ใน `gas/Code.gs` เป็น **dead code** (ไม่มีใครเรียกใช้จริง) — เจอตอนไล่เช็ค 2026-08-06 เคยแก้ `staffUrl` ข้างในให้ชี้ `app.html?order=` ไปแล้วแต่ไม่มีผลอะไรเพราะไม่ถูกเรียก ตัดสินใจ**ปล่อยไว้ก่อน ไม่ลบไม่ต่อสาย** จนกว่าจะมีเหตุผลชัดเจนกว่านี้

### รอทำ (ยังไม่ลบ เพราะยังมีใครลิงก์ถึง/ยังไม่มั่นใจ 100%)
- `staff.html` — ไม่มีใครลิงก์ถึงแล้ว แต่รอให้มั่นใจว่า `app.html?order=` ใช้แทนได้ครบจริงก่อนค่อยลบไฟล์
- `receive.html` — orphan อยู่แล้ว (ไม่มีใครลิงก์ถึง) แต่ยังไม่ลบ
- ตรวจว่า `credentials.json`/`token.json`/`refresh_token.py` (Google OAuth) ยังจำเป็นอยู่จริง — ตอนนี้ยังใช้โดย Streamlit (`shipments`/`stock_returns`/`player_stats`/`withdrawals` ที่ยังไม่ย้ายไป Supabase) ห้ามลบจนกว่าตารางพวกนี้จะย้ายด้วย

---

## 📦 ระบบออเดอร์การ์ด (ก่อนใช้งานจริง)

### 1. Deploy GAS ล่าสุด
- [ ] Copy โค้ดจาก `gas/Code.gs` ไปวางใน GAS editor ทั้งหมด
- [ ] Deploy → Manage deployments → Edit → **New version** → Deploy
- [ ] ตรวจว่า GAS URL ใน LIFF ตรงกับ deployment ล่าสุด

### 2. Push LIFF ขึ้น Vercel
- [ ] `cd liff && git add . && git commit -m "update" && git push`
- [ ] รอ 1-2 นาที Vercel auto deploy

### 3. กรอกข้อมูลใน Google Sheet

#### _catalog — สินค้า
- [ ] ใส่ทุกสินค้า: name, category, price_box, price_pack, active (TRUE), image_url
- [ ] รูปใน Google Drive ต้อง Share "Anyone with the link"

#### stock — สต็อกกลาง (tab สร้างแล้ว)
- [ ] ใส่จำนวนสต็อก: name (ต้องตรง _catalog), category, qty_box, qty_pack

#### _config — ข้อมูลร้าน
- [ ] `bank_name` — ชื่อธนาคาร
- [ ] `bank_account` — เลขบัญชี (ใช้เทียบสลิป ต้องถูกต้อง)
- [ ] `bank_account_name` — ชื่อบัญชี
- [ ] `delivery_fee` — ค่าจัดส่ง (เช่น 50)
- [ ] `group_staff` — Group ID กลุ่ม Line staff (ดูขั้นตอนข้อ 4)

### 4. ตั้ง Line Webhook + จับ Group ID
- [ ] LINE Developers → Waka Space → Messaging API tab
- [ ] Webhook URL ใส่ GAS URL ปัจจุบัน
- [ ] เปิด Use webhook
- [ ] เพิ่มบอท Waka Space เข้ากลุ่ม Line staff
- [ ] ส่งข้อความอะไรก็ได้ในกลุ่ม
- [ ] เปิด Sheet → _config → เห็น `group_NEW_xxxx` → แก้ key เป็น `group_staff`

### 5. ลบ tab สต็อกเก่า
- [ ] ลบ `stock_tonsak`
- [ ] ลบ `stock_muangthong`
- [ ] ลบ `stock_srinakarin`

### 6. ตั้ง Rich Menu ใน Line OA
- [ ] Line Official Account Manager → Rich Menu
- [ ] ลิงค์ไปที่: `https://liff.line.me/2010457385-UpJLXxJ0`

---

## GAS Script Properties (ต้องมีทั้งหมด)

| Key | Value | สถานะ |
|-----|-------|-------|
| LINE_TOKEN | Channel Access Token | ✅ มีแล้ว |
| SHEET_ID | `1aUHbSt3qlQ4uMIzlCGbF-iFm0AqSeqx12nxk5ny1JoY` | ✅ มีแล้ว |
| SLIP_FOLDER_ID | `1-H0ULQEF79zYAOFTFfIKglc2wbQLJo5B` | ✅ มีแล้ว |
| CLAUDE_KEY | API key จาก console.anthropic.com | ✅ มีแล้ว (เติม $5 แล้ว) |

---

## Flow ระบบ

```
ลูกค้าเปิด LIFF → เลือกสินค้า (Box/Pack) → เลือกสาขา/จัดส่ง → แนบสลิป → สั่งซื้อ
    ↓
GAS → ตัดสต็อกกลาง → บันทึกสลิปลง Drive → Claude ตรวจสลิป 4 ชั้น → บันทึก Sheet
    ↓
แจ้ง Line กลุ่ม staff (พร้อมลิงค์จัดการ) + แจ้งลูกค้าพร้อมสถานะ
    ↓
Staff กดลิงค์ใน Line (ไม่ต้องเปิด Streamlit):
  📤 จัดส่งไปสาขาแล้ว → 📍 ถึงสาขา/พร้อมรับ → 🤝 ส่งมอบ
    ↓
ลูกค้ากดลิงค์ยืนยันรับของ (เห็น Timeline สถานะ) → ✅ เสร็จสิ้น
```

## การตรวจสลิป (Claude AI — 4 ชั้น)

1. อ่านสลิปได้ไหม → ถ้าไม่ได้ → "รอตรวจ" (admin ตรวจเอง)
2. เลขอ้างอิงซ้ำไหม → "สลิปซ้ำ"
3. บัญชีปลายทางตรงกับร้านไหม → "บัญชีไม่ตรง"
4. ยอดตรงกับออเดอร์ไหม → "ยอดไม่ตรง" หรือ "ยืนยัน"

---

## ไฟล์สำคัญ

| ไฟล์ | คำอธิบาย | Deploy ที่ไหน |
|------|----------|--------------|
| `gas/Code.gs` | GAS backend | Copy วางใน GAS editor |
| `liff/index.html` | LIFF frontend ลูกค้า | Vercel (auto deploy จาก GitHub) |
| `tools/verify_app.py` | Admin dashboard (main entry / nav router) | Streamlit |

---

## Performance ที่แก้แล้ว (รอ deploy GAS)
- [x] LIFF SDK defer — ไม่ block first render
- [x] GAS catalog cache 5 นาที — LIFF โหลดเร็วขึ้น
- [x] LockService ป้องกัน race condition (order ID ซ้ำ + stock)
- [x] Formula injection protection — sanitize user input

## Bug ที่แก้แล้ว (รอ deploy)

- [x] writeOrder ไม่สร้างคอลัมน์ fulfillment ใน header → เพิ่มแล้ว
- [x] handleStaffPage ไม่เช็ค col() = -1 → เพิ่ม guard แล้ว
- [x] Delivery flow set "สาขายืนยัน" แทน "จัดส่งแล้ว" → แก้แล้ว
- [x] Order ID ซ้ำง่าย (random 0-99) → เพิ่มวินาที + random 0-999
- [x] notifyCustomer ส่ง slipBase64 ทั้งก้อน → ส่งเฉพาะ field ที่ใช้
- [x] fulfill_icon ไม่ครอบคลุมสถานะ → เพิ่มครบแล้ว

## Bug ที่ยังไม่ได้แก้

- [ ] **LIFF ไม่ reset ฟอร์ม** — หลังสั่งสำเร็จถ้าไม่ปิด LIFF สามารถสั่งซ้ำได้
- [ ] **LIFF ไม่ validate เบอร์โทร** — ใส่ตัวอักษรก็ผ่าน ควรเช็ค format
- [ ] **LIFF โหลดช้า** — GAS doGet ใช้เวลา ~2-3 วินาที (ข้อจำกัดของ GAS)
- [ ] **orders.py timezone** — ใช้ local time แทน Asia/Bangkok อาจผิดบน Streamlit Cloud
- [ ] **encodeKey อาจชนกัน** — ชื่อสินค้าที่ต่างกันแต่ตัวอักษรคล้ายกันอาจได้ key เดียวกัน

## รอทำทีหลัง

- [ ] **ที่อยู่จัดส่งแบบ filter** — ทำแล้ว dropdown จังหวัด/อำเภอ/ตำบล/รหัสไปรษณีย์ (รอ push + deploy)
- [ ] **Claude Design** — ออกแบบ UI/UX ด้วย Claude
- [ ] **SlipOK API** — ✅ ทำแล้ว (free 100 ครั้ง/เดือน, fallback Claude)

### Presentation สำหรับเจ้าของร้าน
ไปทำใน **claude.ai** (ไม่ใช่ Claude Design) โดยพิมพ์ prompt:
1. สร้าง presentation สวยๆ ระบบสั่งซื้อ WAKA SPACE
2. แสดง flow: ลูกค้าสั่ง → ตรวจสลิป → staff จัดส่ง → ลูกค้ารับ
3. ตัวอย่างหน้าจอ: LIFF, LINE messages, Staff page, Timeline
4. ข้อความ LINE ที่ลูกค้าได้รับ (ยืนยันออเดอร์, ทวนที่อยู่, แจ้งสถานะ)
5. การป้องกันโกง: SlipOK QR verify, สลิปซ้ำ, Claude AI
6. ค่าใช้จ่าย: ฟรีเกือบทั้งหมด
7. สไตล์: โทนเทาเข้ม + เบจ ตาม branding WAKA SPACE
- Claude จะสร้าง Artifact ให้ดู preview ได้ทันที
- [ ] **Bank API** — เช็คยอดเข้าบัญชีจริง 100% ต้องจดทะเบียนกับธนาคาร

### Security (ควรทำก่อนใช้งานจริง)
- [ ] **Server-side auth doPost** — validate LIFF access token ก่อนรับออเดอร์ ป้องกัน fake orders
- [ ] **Staff API auth** — ย้าย PIN verification ไป server-side (ตอนนี้ PIN อยู่ใน client source code)
- [ ] **Staff API ใช้ POST แทน GET** — ป้องกัน prefetch/cache trigger status change

### Performance (ควรทำถ้ามีออเดอร์เยอะ)
- [ ] **Order ID ใช้ Script Properties** — ไม่ต้องอ่าน Sheet ทั้งหมดเพื่อหาเลขล่าสุด
- [ ] **Stock check ก่อนสั่ง** — แสดงสต็อกคงเหลือใน LIFF ป้องกันสั่งของหมด
- [ ] **Batch cell updates** — deductStock เขียน Sheet ทีเดียวแทนทีละ cell
- [ ] **LINE push เป็น background** — ส่งหลัง response ให้ลูกค้าเร็วขึ้น

### UX ที่ควรเพิ่ม
- [ ] **ประวัติออเดอร์ลูกค้า** — ลูกค้าดูออเดอร์เก่าได้
- [ ] **Loading indicator ตอนอัปสลิป** — แสดง progress ตอน resize รูป
- [ ] **Staff auto-refresh** — polling ทุก 30 วิ ดูออเดอร์ใหม่
- [ ] **Staff ดูออเดอร์ทั้งหมดที่รอ** — ไม่ต้องค้นหา
- [x] **Export CSV** — admin export ออเดอร์สำหรับบัญชี (หน้ารายงาน)

### Streamlit รายงาน (ยังไม่ได้ทำ)
- [ ] **สรุปยอดขายรายวัน** — กราฟแท่ง ยอดต่อวัน
- [ ] **สรุปยอดต่อสาขา** — เปรียบเทียบสาขา
- [ ] **สินค้าขายดี** — ranking สินค้า Box/Pack
- [ ] **สถานะออเดอร์** — pie chart (ยืนยัน/รอตรวจ/ปัญหา/เสร็จสิ้น)
- [ ] **รายงานการจัดส่ง** — กี่ออเดอร์รอจัดส่ง / กำลังส่ง / เสร็จ
- [x] **Export CSV** — ดาวน์โหลดรายงานสำหรับบัญชี (Excel export ยังไม่มี แค่ CSV)
- [ ] **ยกเลิกออเดอร์** — คืนสต็อก + แจ้งลูกค้า

### สิทธิ์และการจัดส่งสินค้าไปสาขา (ยังไม่ได้ทำ)

**ปัญหา:** การส่งของจากคลังกลาง → สาขา ไม่ได้จัดเป็นรายออเดอร์ แต่จัดเป็น "ล็อต" ตามประเภทสินค้า

**แนวทาง:**
1. **แยกสิทธิ์ staff** — ใคร "ส่งของจากคลัง" ได้ / ใคร "รับของประจำสาขา" ได้ / ใคร "ส่งมอบลูกค้า" ได้
2. **ระบบ shipment (ล็อต)** — สร้าง tab `shipments` แยกจาก orders
   - คลังกลางสร้าง shipment: วันที่, สาขาปลายทาง, รายการสินค้า (ชื่อ x จำนวน)
   - Staff สาขากดรับ shipment → ยืนยันว่าได้รับครบ
   - สต็อกสาขาอัปเดตอัตโนมัติ
3. **Flow:**
   ```
   คลังกลางจัด shipment → กดส่ง (staff คลัง)
       ↓
   สินค้าระหว่างทาง
       ↓
   สาขารับ → กดรับ (staff สาขา) → สต็อกสาขาเพิ่ม
       ↓
   ลูกค้ามารับ → กดส่งมอบ (staff สาขา)
   ```
4. **PIN แยกระดับ** — คลังใช้ PIN คนละตัวกับสาขา เพื่อแยกสิทธิ์

---

## ระบบเดิม (Tournament) — เลิกใช้แล้ว (2026-08-06)

Pipeline เก่า (Google Forms + Sheets + Claude ตรวจสลิปจาก bank report:
`tools/process_registrations.py`, `tools/match_bank_csv.py`,
`verify_registrations.ipynb`, `workflows/verify_registrations.md`) ถูกลบออก
— ไม่ได้แตะมา 5 สัปดาห์กว่า, `events_config.json` หายไปแล้ว, แทนที่ด้วยระบบ
ทัวร์นาเมนต์ในแอป (`treg.html`/`tournament_admin.html`/`tournament_staff.html`
+ ตาราง `tournament_registrations` บน Supabase) ที่ใช้งานจริงอยู่แล้ว

---

## Checklist: Gap จาก Mockup "WAKA Admin Dashboard" (เทียบ 2026-07-21)

เทียบ `WAKA Admin Dashboard.standalone-src.html` กับ `tools/screens/*.py` + `liff/*.html` + `gas/Code.gs`
ติ๊ก `[x]` แล้วเปลี่ยนเป็น **ทำ** หรือ **ข้าม (เหตุผล)** ทีละข้อ — ไม่ต้องทำทั้งหมด

### Sidebar ภาพรวม
- [ ] ตัวกรอง "สาขา" ที่ sidebar มีผลกับทุกหน้า (ตอนนี้มีแค่หน้าออเดอร์)
- [ ] ปุ่มสลับ Dark/Light mode
- [ ] Badge ตัวเลขแจ้งเตือน (ออเดอร์รอตรวจ, สินค้าใกล้หมด) ข้าง label เมนู

### ออเดอร์ (Orders)
- [ ] พิมพ์ใบเสร็จ
- [ ] ใบปะหน้าพัสดุ
- [ ] โปรไฟล์ลูกค้า (ประวัติออเดอร์, ยอดใช้จ่ายรวม, tier, ส่ง SMS)
- [x] ตรวจสอบยอดสลิปอัตโนมัติ — เพิ่มแล้ว (`orders.py`, ใช้ `slip_amount` ที่ AI/SlipOK ตรวจไว้อยู่แล้วตอนสั่งซื้อ ไม่ต้องกรอกเอง)
- [ ] ระบบส่วนลดสมาชิก
- [ ] หมายเหตุแอดมินแบบแก้ไข/บันทึกได้ (ตอนนี้อ่านอย่างเดียว)
- [ ] Timeline ประวัติเปลี่ยนสถานะในการ์ดออเดอร์
- [ ] ตัวกรองช่องทางชำระเงิน
- [x] ปุ่ม "ล้างตัวกรอง" — เพิ่มแล้ว (`orders.py`)
- [x] เลือกจำนวนออเดอร์ต่อหน้า (20/40/60/80/ทั้งหมด) + ปุ่มเปลี่ยนหน้า — เพิ่มแล้ว (`orders.py`, นอกเหนือจาก mockup ตามที่ขอเพิ่ม)

### ทัวร์นาเมนต์
- [ ] สายการแข่งขัน/Bracket (ไม่มีเลยทุก layer รวม backend)
- [ ] คำนวณเงินรางวัลรวม (60%) ต่องาน
- [x] KPI สรุปภาพรวม (ทั้งหมด/เปิดรับสมัคร/ผู้สมัครรวม/ค่าสมัครเก็บแล้ว) — เพิ่มแล้ว (`tournament.py`)
- [x] ค้นหา/กรองสถานะในรายการทัวร์นาเมนต์ — เพิ่มแล้ว (`tournament.py`)
- [x] ที่นั่งคงเหลือ (slotsLeft) ต่อทัวร์นาเมนต์ — เพิ่มแล้ว (`tournament.py`)
- [x] ยอดค่าสมัครเก็บแล้ว/รอเก็บ (฿) ที่แท็บผู้สมัคร — เพิ่มแล้ว (`tournament.py`)
- [ ] "ยืนยันสลิปที่ค้างทั้งหมด" แบบ bulk (ตอนนี้ทีละคน)

### WAKA GYM (ต่างจาก mockup มากที่สุด)
- [ ] เช็คอินด้วยมือ (กรอกชื่อ+โต๊ะ) ในแดชบอร์ด
- [ ] บันทึกผลแข่งแบบ win/lose ต่อแมตช์เดี่ยว พร้อมคู่แข่ง/โต๊ะ (ตอนนี้เป็น placement + จำนวนชนะรวม)
- [ ] Rewards catalog (แลก token กับรางวัลหลายแบบ) + ประวัติการแลก (ตอนนี้มีแค่แจก Box เดียวตอน token ครบ 30)
- [x] ตารางอันดับ (leaderboard) พร้อมเหรียญ 1/2/3 — เพิ่มแล้ว (`wakagym.py` แท็บสะสม)
- [ ] โปรไฟล์ผู้เล่น modal (อันดับ, ยอดวันนี้, แมตช์วันนี้, ประวัติแลกรางวัล)
- [ ] KPI "กำลังแข่งอยู่", ยอดชำระวันนี้, ยอดสลิปรอตรวจ (฿)

### คลังสินค้า (Stock)
- [x] KPI "มูลค่าสต็อกรวม (฿)" — เพิ่มแล้ว (`stock.py`, ตอนนี้นับเฉพาะคลังกลาง ยังไม่รวมสต็อกสาขา)
- [x] ค้นหา/กรองหมวดหมู่ในตารางคลังกลาง — เพิ่มแล้ว (`stock.py`)
- [x] การ์ดสรุปแยกตามหมวดหมู่ — เพิ่มแล้ว (`stock.py`)
- [ ] ปุ่ม +/− ปรับสต็อกแบบ inline ต่อแถวในตาราง (ตอนนี้ตารางอ่านอย่างเดียว)
- [ ] ประวัติความเคลื่อนไหวสต็อกรวม (รับเข้า/ตัดจากออเดอร์/ปรับสต็อก — คนละเรื่องกับ "ประวัติการโอน" ที่มีอยู่)

### รายงาน (Report)
- [x] ปุ่ม Export CSV ที่หน้ารายงาน — เพิ่มแล้ว (`report.py` ทุกแท็บ: ออเดอร์, ยอดขายแยกสาขา, สินค้าขายดี, เปรียบเทียบทัวร์นาเมนต์/GYM)
