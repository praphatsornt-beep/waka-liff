# WAKA — สิ่งที่ต้องทำ

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
- [ ] **Export CSV** — admin export ออเดอร์สำหรับบัญชี

### Streamlit รายงาน (ยังไม่ได้ทำ)
- [ ] **สรุปยอดขายรายวัน** — กราฟแท่ง ยอดต่อวัน
- [ ] **สรุปยอดต่อสาขา** — เปรียบเทียบสาขา
- [ ] **สินค้าขายดี** — ranking สินค้า Box/Pack
- [ ] **สถานะออเดอร์** — pie chart (ยืนยัน/รอตรวจ/ปัญหา/เสร็จสิ้น)
- [ ] **รายงานการจัดส่ง** — กี่ออเดอร์รอจัดส่ง / กำลังส่ง / เสร็จ
- [ ] **Export Excel/CSV** — ดาวน์โหลดรายงานสำหรับบัญชี
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

## ระบบเดิม (Tournament)

### ✅ ทำแล้ว
- Tab ตั้งค่า, ตรวจสลิป, รายชื่อ, ประกาศ, อีเมล, เช็คอิน
- ตรวจสลิปซ้ำ, Admin override, บันทึกรายละเอียดงาน

### รอทำ
- Config persistence → save config ลง Google Sheet แทน JSON (ทำบางส่วนแล้ว)
- Google Forms สร้างอัตโนมัติ → รอ OAuth scope `forms.body` (ดู memory)

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
- [ ] ตรวจสอบยอดสลิปอัตโนมัติ (กรอกยอดที่เห็น → เช็คตรง/ไม่ตรงให้)
- [ ] ระบบส่วนลดสมาชิก
- [ ] หมายเหตุแอดมินแบบแก้ไข/บันทึกได้ (ตอนนี้อ่านอย่างเดียว)
- [ ] Timeline ประวัติเปลี่ยนสถานะในการ์ดออเดอร์
- [ ] ตัวกรองช่องทางชำระเงิน
- [ ] ปุ่ม "ล้างตัวกรอง"

### ทัวร์นาเมนต์
- [ ] สายการแข่งขัน/Bracket (ไม่มีเลยทุก layer รวม backend)
- [ ] คำนวณเงินรางวัลรวม (60%) ต่องาน
- [ ] KPI สรุปภาพรวม (ทั้งหมด/เปิดรับสมัคร/ผู้สมัครรวม/ค่าสมัครเก็บแล้ว)
- [ ] ค้นหา/กรองสถานะในรายการทัวร์นาเมนต์
- [ ] ที่นั่งคงเหลือ (slotsLeft) ต่อทัวร์นาเมนต์
- [ ] ยอดค่าสมัครเก็บแล้ว/รอเก็บ (฿) ที่แท็บผู้สมัคร
- [ ] "ยืนยันสลิปที่ค้างทั้งหมด" แบบ bulk (ตอนนี้ทีละคน)

### WAKA GYM (ต่างจาก mockup มากที่สุด)
- [ ] เช็คอินด้วยมือ (กรอกชื่อ+โต๊ะ) ในแดชบอร์ด
- [ ] บันทึกผลแข่งแบบ win/lose ต่อแมตช์เดี่ยว พร้อมคู่แข่ง/โต๊ะ (ตอนนี้เป็น placement + จำนวนชนะรวม)
- [ ] Rewards catalog (แลก token กับรางวัลหลายแบบ) + ประวัติการแลก (ตอนนี้มีแค่แจก Box เดียวตอน token ครบ 30)
- [ ] ตารางอันดับ (leaderboard) พร้อมเหรียญ 1/2/3
- [ ] โปรไฟล์ผู้เล่น modal (อันดับ, ยอดวันนี้, แมตช์วันนี้, ประวัติแลกรางวัล)
- [ ] KPI "กำลังแข่งอยู่", ยอดชำระวันนี้, ยอดสลิปรอตรวจ (฿)

### คลังสินค้า (Stock)
- [ ] KPI "มูลค่าสต็อกรวม (฿)"
- [ ] ค้นหา/กรองหมวดหมู่ในตารางคลังกลาง
- [ ] การ์ดสรุปแยกตามหมวดหมู่
- [ ] ปุ่ม +/− ปรับสต็อกแบบ inline ต่อแถวในตาราง (ตอนนี้ตารางอ่านอย่างเดียว)
- [ ] ประวัติความเคลื่อนไหวสต็อกรวม (รับเข้า/ตัดจากออเดอร์/ปรับสต็อก — คนละเรื่องกับ "ประวัติการโอน" ที่มีอยู่)

### รายงาน (Report)
- [ ] ปุ่ม Export CSV ที่หน้ารายงาน (หน้าทัวร์นาเมนต์มีแล้ว แต่หน้านี้ยังไม่มี)
