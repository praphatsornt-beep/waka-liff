# Setup Google Authentication

> **สถานะ 2026-08: ไม่มีโค้ดจุดไหนในโปรเจกต์ใช้ `credentials.json`/`token.json` แล้ว** —
> ทุกหน้า Streamlit (`orders.py`, `stock.py`, `wakagym.py`) ย้ายไปอ่าน Supabase ตรงผ่าน
> `service_role` key (คนละกลไกกับ OAuth flow นี้) หมดแล้ว เก็บ workflow นี้ไว้เผื่อมีสคริปต์
> ใหม่ในอนาคตที่ต้องกลับไปพึ่ง Google Sheets/Drive โดยตรงอีกครั้ง — ไม่ต้องทำตามขั้นตอนนี้
> สำหรับใช้งานระบบปกติ

## Objective
ได้ไฟล์ `credentials.json` สำหรับให้ Python scripts เข้าถึง Google Sheets และ Google Drive

## ทำครั้งเดียว — ไม่ต้องทำซ้ำ

---

## ขั้นตอน

### 1. เปิด Google Cloud Console
ไปที่ https://console.cloud.google.com/

### 2. สร้าง Project ใหม่
- คลิก **Select a project** (มุมบนซ้าย) → **New Project**
- ตั้งชื่อ เช่น `waka-tournament`
- คลิก **Create**

### 3. เปิด API ที่จำเป็น

ไปที่ **APIs & Services → Library** แล้วเปิดทั้ง 2 ตัวนี้:

- ค้นหา **Google Sheets API** → คลิก **Enable**
- ค้นหา **Google Drive API** → คลิก **Enable**

### 4. สร้าง OAuth Credentials

1. ไปที่ **APIs & Services → Credentials**
2. คลิก **+ Create Credentials → OAuth client ID**
3. ถ้าถามให้ configure consent screen:
   - เลือก **External**
   - กรอก App name (อะไรก็ได้ เช่น `waka-tournament`)
   - กรอก User support email (email ตัวเอง)
   - กรอก Developer contact (email ตัวเอง)
   - คลิก **Save and Continue** ผ่านทุกหน้า → **Back to Dashboard**
4. กลับมาที่ **Create Credentials → OAuth client ID**
5. Application type เลือก **Desktop app**
6. Name ใส่อะไรก็ได้
7. คลิก **Create**

### 5. Download credentials.json
- ในหน้า Credentials → ตรง OAuth 2.0 Client IDs ที่เพิ่งสร้าง
- คลิกไอคอน **Download** (รูปลูกศรลง)
- เปลี่ยนชื่อไฟล์เป็น `credentials.json`
- วางไฟล์ที่ **root ของโปรเจกต์** (ข้างๆ CLAUDE.md)

### 6. เพิ่ม Test User (ถ้า Consent screen เป็น External)
- ไปที่ **APIs & Services → OAuth consent screen**
- เลื่อนลงไปส่วน **Test users** → คลิก **+ Add Users**
- ใส่ email ของตัวเอง → **Save**

---

## ทดสอบ

รันคำสั่งนี้ครั้งแรก:
```bash
uv run tools/refresh_token.py
```

จะเปิดเบราว์เซอร์ให้ล็อกอิน Google → อนุญาต → ระบบจะสร้าง `token.json` ให้อัตโนมัติ

`token.json` ไม่ถูกใช้โดยโค้ดจุดไหนในโปรเจกต์แล้ว (ดูหมายเหตุด้านบน) — ขั้นตอนนี้มีไว้เผื่อ
สร้าง token สำหรับสคริปต์ one-off ในอนาคตที่ต้องเข้าถึง Sheets/Drive โดยตรง

**ครั้งต่อไปไม่ต้องล็อกอินใหม่** (token มีอายุ และ refresh อัตโนมัติ)

---

## หมายเหตุความปลอดภัย
- `credentials.json` และ `token.json` อยู่ใน `.gitignore` — ห้าม commit หรือแชร์ไฟล์นี้
