# Vehicle Photos — ระบบถ่ายรูปรถเป็นชุด

ระบบนี้มีสองส่วน:
- **แอปภาคสนาม** (มือถือ, PWA) อยู่ที่ `/`
- **แดชบอร์ดผู้ดูแล** (เดสก์ท็อป) อยู่ที่ `/admin/`

รูปทั้งหมดเก็บใน **Google Drive** ส่วนข้อมูลรายการ (metadata) เก็บใน **Cloudflare D1** และรูปของวันล่าสุดเก็บเป็นแคชใน **Cloudflare R2** เพื่อให้เปิดดูได้เร็ว

> รายละเอียดสถาปัตยกรรม, เหตุผลที่เลือก PWA, สมมติฐาน, data model, API และโควต้า อยู่ใน [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

## สถานะการทำงาน

| ส่วน | สถานะ |
|---|---|
| แอปถ่ายรูป: คิวอัปโหลดที่ไม่หายเมื่อปิด/รีโหลด, ถ่ายซ้ำ, ปุ่ม DONE, ลายน้ำเวลา | ✅ ใช้งานได้ |
| แดชบอร์ด: ประวัติ, ตัวกรองวันเวลา, แบ่งหน้าฝั่งเซิร์ฟเวอร์, ดูชุดรูป, แก้ทะเบียน, ซ่อน/ลบ, Excel พร้อมรูป | ✅ ใช้งานได้ |
| ล็อกอิน, role, PIN, รีเซ็ตรหัสผ่าน, audit log | ✅ ใช้งานได้ |
| Google Drive (OAuth, โฟลเดอร์ตามวันที่, เปลี่ยนชื่อโฟลเดอร์, แชร์แบบ private) | ✅ เขียนครบ — **ยังไม่ได้ทดสอบกับบัญชี Google จริง** ต้องตั้งค่า OAuth ก่อน (ดูขั้นตอนด้านล่าง) |
| OCR ป้ายทะเบียน (Google Vision / AI for Thai) | ⚠️ เขียนไว้แล้ว แต่ **ยังไม่ได้ทดสอบกับรูปป้ายจริง** ค่าเริ่มต้นปิดไว้ |
| ย้าย metadata เก่าไปเก็บใน Drive | 📄 มีแค่เอกสารอธิบายวิธี ยังไม่ได้ทำเป็นระบบอัตโนมัติ |
| อัปโหลดต่อตอนปิดแอปหรือล็อกจอ | ❌ PWA ทำไม่ได้ ต้องทำเป็นแอป Capacitor (ดู ARCHITECTURE §2) |

**โหมด demo** (`DRIVE_MODE=demo`) จำลอง Google Drive ไว้ในเครื่อง และสร้างบัญชีทดสอบให้อัตโนมัติ ทุกหน้าจะแสดงแถบสีเหลือง "DEMO MODE" ชัดเจน ห้ามใช้โหมดนี้กับข้อมูลจริง

---

## 1. รันในเครื่อง (ไม่ต้องมีบัญชี Cloudflare หรือ Google)

ต้องมี Node.js 22 ขึ้นไป

```bash
npm ci
```
```bash
npm run dev:demo
```

เปิด http://localhost:8787 (แอปถ่ายรูป) และ http://localhost:8787/admin/ (แดชบอร์ด)

บัญชีทดสอบในโหมด demo:

| ผู้ใช้ | รหัสผ่าน | role |
|---|---|---|
| `admin` | `demo-admin-1234` | Super Admin |
| `reviewer` | `demo-review-1234` | Reviewer |
| `operator` / `operator2` | `demo-op-1234` | Field Operator |

ถ้าจะเติมข้อมูลตัวอย่างจำนวนมากเพื่อลองการแบ่งหน้า ใช้ API `POST /api/admin/demo/seed-history` (ใช้ได้เฉพาะโหมด demo)

**ถ้าจะแก้โค้ดหน้าเว็บแบบ hot reload:** เปิด `npm run dev:api:demo` ไว้หน้าต่างหนึ่ง แล้วเปิด `npm run dev:web` อีกหน้าต่าง จากนั้นเข้า http://localhost:5173

**ทดสอบบนมือถือจริง:** กล้องต้องใช้ HTTPS ให้เปิด tunnel ชั่วคราว (ฟรี ไม่ต้องมีบัญชี):
```bash
npx cloudflared tunnel --url http://localhost:8787
```

### เทสต์อัตโนมัติ
```bash
npm test
```
- `test/worker/*` รันใน runtime ของ Workers จริง (Miniflare + D1/R2)
- `test/web/*` ทดสอบตัวจัดการคิวอัปโหลดฝั่งมือถือ

| เงื่อนไขในสเปก | ไฟล์เทสต์ |
|---|---|
| ถ่ายขั้นตอนที่ 2 ได้ระหว่างที่รูปที่ 1 ยังอัปโหลดอยู่ | `capture.test.ts`, `engine.test.ts` |
| ถ่ายซ้ำแล้ว upload เก่าที่เสร็จทีหลังจะไม่ทับรูปใหม่ | `capture.test.ts`, `engine.test.ts` |
| DONE ปิดอยู่จนทุกรูปขึ้น Drive และเซิร์ฟเวอร์ยืนยันแล้ว | `capture.test.ts`, `engine.test.ts` |
| finalize ล้มเหลวแล้วรอบเดิมยังอยู่ / สำเร็จแล้วกลับไปขั้นตอนที่ 1 | `engine.test.ts`, `capture.test.ts` |
| แอดมินแก้ workflow ระหว่างรอบ ไม่กระทบรอบที่กำลังถ่าย | `capture.test.ts`, `engine.test.ts` |
| รอบที่ข้ามเที่ยงคืนอยู่ในโฟลเดอร์เดียว | `capture.test.ts` |
| ชุดเก่าไม่โหลดรูปหรือ thumbnail | `history.test.ts` |
| ตัวกรองวันที่เป็นช่วงเวลาต่อเนื่องช่วงเดียว และขอบเขตรวมวินาทีสุดท้าย | `history.test.ts` |
| แก้ทะเบียนแล้วเปลี่ยนชื่อโฟลเดอร์เดิม (ID ไม่เปลี่ยน) | `history.test.ts` |
| ซ่อนหรือลบชุดแล้วไม่ลบไฟล์ใน Drive | `history.test.ts` |
| กรองและแบ่งหน้าฝั่งเซิร์ฟเวอร์ (ทดสอบกับ 250 แถว) | `history.test.ts` |
| ผู้ใช้ภาคสนามเรียก API ของแอดมินไม่ได้ | `auth.test.ts` |

---

## 2. ตั้งค่า Google Drive (ทำครั้งเดียว ฟรี)

1. เข้า https://console.cloud.google.com แล้วสร้างโปรเจกต์ใหม่ โดยล็อกอินด้วย**บัญชีที่เป็นเจ้าของโฟลเดอร์เก็บรูป**
2. เข้าเมนู **APIs & Services → Library** แล้วเปิดใช้ **Google Drive API** (ถ้าจะใช้ OCR ให้เปิด **Cloud Vision API** ด้วย)
3. เข้าเมนู **OAuth consent screen**:
   - เลือกประเภท External
   - ใส่ชื่อแอปและอีเมลติดต่อ
   - เพิ่ม scope `.../auth/drive`
   - กด **Publish app** เพื่อเปลี่ยนสถานะเป็น "In production"
   - ⚠️ ถ้าค้างไว้ที่สถานะ "Testing" Google จะยกเลิก token ทุก 7 วัน และการอัปโหลดจะหยุด
   - ไม่ต้องรอ Google verify แอป ตอนเชื่อมต่อจะมีหน้าเตือนให้กด "Continue" แค่ครั้งเดียว
4. เข้าเมนู **Credentials → Create credentials → OAuth client ID**:
   - เลือกประเภท Web application
   - ใส่ Authorized redirect URI เป็น `https://<โดเมนของคุณ>/api/admin/drive/oauth/callback` (ดู URI ที่ถูกต้องได้ในแดชบอร์ด หน้า "Google Drive & retention")
   - ถ้าจะลองในเครื่องด้วย ให้เพิ่ม `http://localhost:8787/api/admin/drive/oauth/callback`
5. เก็บ Client ID และ Client Secret ไว้สำหรับขั้นตอนถัดไป
6. โฟลเดอร์เก็บรูปตั้งไว้แล้วใน `wrangler.jsonc` คือ `DRIVE_ROOT_FOLDER_ID=1qjKh1HpA14b63xgmaH5tBhVHF74yGjjp` (เปลี่ยนได้ในแดชบอร์ด)

**เรื่องความเป็นส่วนตัวของรูป:**
- ระบบไม่สร้างลิงก์แบบ "ทุกคนที่มีลิงก์" เลย
- ปุ่ม "Open set in Drive" จะเปิดได้เฉพาะบัญชี Google ที่ได้รับแชร์โฟลเดอร์หลักไว้
- Super Admin แชร์โฟลเดอร์ให้แอดมินคนอื่นได้จากแดชบอร์ด (ปุ่ม "Give view access")
- การลบผู้ใช้ออกจากแดชบอร์ด**ไม่ได้**ถอนสิทธิ์ Drive ให้อัตโนมัติ ต้องถอนแชร์ใน Drive เองด้วย

---

## 3. Deploy ขึ้น Cloudflare (บัญชีปลายทาง)

> บัญชี Cloudflare ที่ใช้ deploy **ไม่จำเป็นต้องเป็นบัญชีที่ล็อกอินอยู่ในเครื่อง** ในโค้ดไม่มี account ID ฝังอยู่เลย

### วิธีที่ 1: GitHub Actions (แนะนำ)

**ขั้นที่ 1 — เตรียม token ในบัญชี Cloudflare ปลายทาง**
1. ไปที่ **My Profile → API Tokens → Create Token**
2. เลือก template "Edit Cloudflare Workers"
3. เพิ่มสิทธิ์ **D1: Edit** และ **Workers R2 Storage: Edit**
4. จด **Account ID** ไว้ (อยู่หน้า Workers & Pages ด้านขวา)

**ขั้นที่ 2 — สร้าง D1 และ R2 ครั้งเดียว** (รันจากเครื่องไหนก็ได้ โดยใช้ token ของบัญชีปลายทาง)
```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy npx wrangler d1 create vehicle-photos
```
```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy npx wrangler r2 bucket create vehicle-photos-cache
```

**ขั้นที่ 3 — ใส่ secrets ของ Worker**

สร้าง `TOKEN_ENC_KEY` ด้วยคำสั่ง `openssl rand -base64 32` และตั้ง `SETUP_TOKEN` เป็นรหัสสุ่มยาว ๆ แล้วรันคำสั่งนี้ทีละตัว:
```bash
CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy npx wrangler secret put GOOGLE_CLIENT_ID
```
ทำแบบเดียวกันกับ `GOOGLE_CLIENT_SECRET`, `TOKEN_ENC_KEY` และ `SETUP_TOKEN`

**ขั้นที่ 4 — ใส่ secrets ใน GitHub repo**

ไปที่ **Settings → Secrets and variables → Actions** แล้วเพิ่ม:
- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `D1_DATABASE_ID` (ได้จากผลลัพธ์ของขั้นที่ 2)

**ขั้นที่ 5 — Deploy**

ไปที่แท็บ **Actions → Deploy to Cloudflare → Run workflow** ระบบจะรันเทสต์ → build → migrate ฐานข้อมูล → deploy

### วิธีที่ 2: deploy จากเครื่องตัวเอง
```bash
npx wrangler logout
```
```bash
npx wrangler login
```
ตอนล็อกอินให้เลือก**บัญชีปลายทาง** แล้วตรวจให้แน่ใจด้วยคำสั่งนี้:
```bash
npx wrangler whoami
```
จากนั้นรันสคริปต์ติดตั้ง (จะถามยืนยันบัญชีก่อนสร้างอะไร):
```bash
./scripts/setup-cloudflare.sh
```

### หลัง deploy เสร็จ
1. สร้าง Super Admin คนแรก (คำสั่งนี้ใช้ได้เฉพาะตอนที่ระบบยังไม่มีผู้ใช้):
   ```bash
   ./scripts/create-super-admin.sh https://vehicle-photos.<subdomain>.workers.dev
   ```
2. เข้า `/admin/` → **Google Drive & retention** → **Connect Google Drive** แล้วล็อกอินด้วยบัญชีเจ้าของโฟลเดอร์
3. เข้า **Members & permissions** เพื่อสร้างบัญชีให้พนักงานภาคสนาม
4. ให้พนักงานเปิด URL หลักบนมือถือ แล้วกด "เพิ่มลงหน้าจอหลัก" (Add to Home Screen)

### ตัวแปรและ secrets ทั้งหมด

| ชื่อ | ประเภท | คำอธิบาย |
|---|---|---|
| `DRIVE_MODE` | var | `google` (ใช้งานจริง) หรือ `demo` |
| `DRIVE_ROOT_FOLDER_ID` | var | ID ของโฟลเดอร์หลักเริ่มต้น |
| `PASSWORD_ITERATIONS` | var | จำนวนรอบ PBKDF2 (สูงสุด 100000) ถ้าล็อกอินแล้วเจอ error CPU limit บนแผนฟรี ให้ลดเป็น 50000 |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | secret | OAuth client |
| `TOKEN_ENC_KEY` | secret | key 32 ไบต์ (base64) ใช้เข้ารหัส refresh token |
| `SETUP_TOKEN` | secret | ใช้สร้าง Super Admin คนแรก |
| `PUBLIC_BASE_URL` | secret/var | (ไม่บังคับ) URL ที่ใช้ทำ OAuth redirect |
| `GOOGLE_VISION_API_KEY` / `AIFORTHAI_API_KEY` | secret | (ไม่บังคับ) สำหรับ OCR |

---

## 4. ข้อจำกัดที่ควรรู้

- **PWA อัปโหลดได้เฉพาะตอนเปิดแอปอยู่** รูปจะเก็บไว้ในเครื่องจนกว่าเซิร์ฟเวอร์ยืนยันว่าขึ้น Drive แล้ว และจะอัปโหลดต่อเมื่อเปิดแอปหรือกลับมาออนไลน์ ถ้าต้องการให้อัปโหลดเบื้องหลังจริง ต้องทำเป็นแอป Capacitor
- **Google Drive 15 GB จะเต็มก่อนส่วนอื่น** (ถ้าวันละประมาณ 200 ชุด จะเต็มในราว 2–3 เดือน) ทางเลือก: ปิดการเก็บต้นฉบับในหน้า Drive settings หรือซื้อพื้นที่ Google One เพิ่ม
- **ไม่มีแผนฟรีไหนใช้ได้ไม่จำกัด** ตัวเลขโควต้าทั้งหมดอยู่ใน ARCHITECTURE §8
- **OCR อ่านป้ายไม่ได้ถูก 100%** ต้องทดสอบกับรูปป้ายจริงก่อนเปิดใช้ และแอดมินแก้ทะเบียนเองได้เสมอ
