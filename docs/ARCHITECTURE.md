# Architecture & design decisions

This document covers the "before implementation" deliverables: architecture, web/PWA vs
native, assumptions, Drive authentication & permissions, data model, API, implementation
plan, and quota/cost considerations.

## 1. Architecture

```
 Phone (PWA, field app /)                       Desktop (dashboard /admin/)
 ├─ IndexedDB durable queue                     ├─ history table (server-side filters)
 ├─ canvas: compress + watermark                └─ ExcelJS export (in browser)
 └─ PUT bytes directly to Drive upload URL               │
        │            │                                   │
        │   /api/field/*  (cookie vp_field)    /api/admin/* (cookie vp_admin)
        ▼            ▼                                   ▼
 ┌───────────────────────── Cloudflare Worker (Hono) ────────────────────────┐
 │ auth + role checks · rounds/images · history · config · jobs · cron       │
 │   D1 (SQLite): metadata, indexes, config, audit, job queue                │
 │   R2: disposable cache of recent display copies + thumbnails              │
 │   Static assets: both SPAs                                                │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │ OAuth refresh token (encrypted in D1)
                                 ▼
                         Google Drive (system of record for photos)
                         Root/<capture profile>/YYYY-MM-DD/HH-mm-ss_PLATE_BAR_PF-000001/
```

* **One Worker** serves the API and both static apps from the same origin (no CORS,
  simple cookies). Field and admin are two separate entry points/bundles and two separate
  route trees with separate, path-scoped session cookies.
* **Photos go phone → Drive directly.** The Worker creates a *resumable upload session*
  (`uploadType=resumable`, initiated with the browser's `Origin`), and returns only the
  session URL. The browser PUTs the bytes there. The Worker never relays photo bytes for
  Drive, so the free plan's CPU/bandwidth limits are not an issue, and no Google
  credential ever reaches the client.
* **Acknowledgement:** after uploading, the phone calls `complete`; the Worker reads the
  file metadata from Drive, verifies it exists, is not trashed and sits in the round's
  folder, and only then marks the image `uploaded`. DONE depends on this acknowledgement.
* **R2** keeps recent display copies/thumbnails so today's sets open fast. It is a cache:
  a cron trigger evicts the oldest objects when usage passes the configurable threshold
  (default 70 % of the configured quota) down to the target (default 60 %). Eviction never
  touches Drive.
* **Background jobs** (D1 table + cron every 15 min + immediate attempts): folder renames
  after OCR/plate correction, moving replaced photos into `_replaced/`, OCR.

## 2. Web/PWA vs hybrid/native

**Chosen: installable PWA**, because it is free to host and distribute, works on both
Android and iPhone without app-store review, and meets the core flow:

* capture and upload run concurrently while the app is open;
* photos are persisted in IndexedDB before the next step is shown, so reloads, crashes
  and connectivity loss do not lose them; the queue resumes automatically on `online`;
* `navigator.storage.persist()` is requested to reduce eviction risk.

**Honest limitation:** mobile browsers suspend pages that are in the background or closed.
Uploads **do not continue** while the PWA is closed or the phone is locked for long (iOS
Safari is the strictest; Background Sync is not available there). They resume the next
time the app is opened. If reliable uploads *while the app is suspended* are essential,
wrap the same web app in **Capacitor** and move the queue to a native background upload
plugin (Android WorkManager / iOS `URLSession` background transfers). The engine is
isolated behind `FieldTransport`/`EngineStore` interfaces (`src/web/field/engine.ts`) to
make that swap contained.

## 3. Assumptions and unresolved choices

| Topic | Assumption / default | Open question |
|---|---|---|
| "Vehicle bar" (บาร์รถ) | Kept as an editable label; no meaning assumed. | — |
| Round start time | First accepted image time on the **device**, if plausible (≤ 24 h old, ≤ 2 min in the future); otherwise server receipt time. The source is stored. | Should device time be trusted at all? Switch to server-only by changing `pickStartedAt`. |
| Watermark | Display copy carries: device capture time (camera) **or** "uploaded file — capture time NOT verified" (+ EXIF marked unverified), server receipt time, set ID, step. Originals are stored un-watermarked in the same folder (`*_original.jpg`). | Turn off originals to halve Drive usage (setting). |
| Replaced photos | If already in Drive: moved to `_replaced/` and kept. If never uploaded: discarded on the phone (the operator retook it). | Retention period for `_replaced/` (currently forever). |
| Abandoned rounds | Open rounds idle > 48 h (setting) become "abandoned"; Drive folder kept; they reopen if the phone uploads again. | — |
| OCR | Off by default. Providers: Google Cloud Vision (TEXT_DETECTION) or AI for Thai LPR (experimental, response parsed defensively). **Must be validated with real plate photos.** | Which provider/quality is acceptable. |
| Old sets | "Old" = op_date before the recent window (default: today only, Bangkok). Optional "cache mode" also shows images still in R2. | — |
| Dashboard language | Dashboard UI in Thai; field app fully translatable by admins. | — |
| Password hashing | PBKDF2-SHA256 100 000 iterations (Workers maximum). | On the free plan (10 ms CPU) this can occasionally exceed the CPU limit on login; lower `PASSWORD_ITERATIONS` or use Workers Paid ($5/mo). |

## 4. Google Drive authentication, storage and permissions

* **Account model:** one Google account (the owner of the root folder
  `1qjKh1HpA14b63xgmaH5tBhVHF74yGjjp`) is connected once by a Super Admin via OAuth
  ("Connect Google Drive"). Scope: `drive` (needed to write into an existing folder the app
  did not create). The refresh token is stored **AES-GCM encrypted** in D1 with the
  `TOKEN_ENC_KEY` Worker secret; access tokens are refreshed server-side.
* **Why not a service account:** service accounts have no storage quota of their own on
  personal Drive, so uploads into a personal "My Drive" fail. (With Google Workspace a
  Shared Drive + service account is possible; not implemented.)
* **OAuth consent screen:** publish the app to **In production** (it can stay
  unverified for a handful of admins; users see a warning once). In **Testing** status
  Google expires refresh tokens after 7 days and uploads would stop.
* **Private by default:** the app never creates "anyone with the link" permissions.
  Files inherit the root folder's sharing. Photos are never served publicly: the
  dashboard fetches recent images through the Worker after checking the admin session.
* **How admin auth and Drive access are coordinated:** dashboard login (our own users and
  roles) and Drive access (Google accounts) are separate. "Open set in Drive" opens
  `drive.google.com/drive/folders/<round folder id>`; Google shows it only to Google
  accounts that have access to the root folder. A Super Admin can grant that from the
  dashboard ("Give view access" → Drive `permissions.create`, reader, no email
  notification). Removing a dashboard user does **not** remove their Google access; do
  that in Drive as part of off-boarding.
* **Folder rules:** each capture profile has its own folder under the root (renamed with the profile; sets made before this are moved by the "ย้ายชุดเก่า" button — moves only); date folder from the round's first accepted image time in Bangkok;
  created once per day with a D1 lease (Drive allows duplicate names) and a re-list that
  keeps the oldest folder if a duplicate appears; round folder created on the first
  image (`HH-mm-ss_<plate or ไม่ระบุ>_PF-000001`); renamed (same ID) when OCR finishes or an
  admin corrects the plate; rounds crossing midnight stay in their original date folder;
  names are sanitised; folder IDs are stored in D1.
* **No permanent-delete path:** the `DriveClient` interface has no delete method. The only destructive call is
  `setTrashed()` — Drive trash, recoverable for 30 days — used solely by the Super-Admin "free up Drive space"
  feature (single set with typed set ID, or finished sets older than N ≥ 7 days with typed confirmation; every
  action audited; metadata kept; restore from set details). Hide/remove never call it (tested).

## 5. Data model (D1 / SQLite) — see `migrations/0001_init.sql`

* `users` (role ∈ super_admin/admin/reviewer/operator, PBKDF2 hash, optional PIN hash,
  disabled, must_change_password)
* `sessions` (SHA-256 of token, kind field|admin, expiry, revoked_at)
* `login_attempts` (per-account and per-IP lockout)
* `settings` (`app` JSON settings, encrypted `drive_token`, one-shot `oauth_state`)
* `workflow_versions` (immutable step lists: id, required, allowUpload, ocr, labels per language)
* `languages`, `translations` (admin overrides of built-in strings)
* `rounds` = photo sets (public_id PF-000001, operator, frozen workflow_version_id,
  started_at UTC ms + source, op_date Bangkok, status open/finalized/abandoned, counts,
  plate text/normalised/digits/raw/confidence/source, Drive root/date/round folder IDs and
  name, hidden_at/by, removed_at/by)
* `images` (one row per attempt; partial unique index = **one active image per step**;
  server_received_at, accepted_at_device, capture_time_device, exif_time (unverified),
  uploaded_at (backend ack), source camera/upload, Drive file IDs, version, superseded_by)
* `plate_history` (OCR results + manual corrections — auditable)
* `cache_objects` (R2 key, bytes — for usage without bucket listing)
* `jobs` (durable background jobs), `exports` (1-hour audited export grants), `audit_log`
* `drive_date_folders` (root, date → folder id, creation lease)

Indexes: `(started_at DESC, id DESC)`, `(status, started_at, id)`, a partial index for the
default visible view, `plate_norm`, `plate_digits`, `(operator_id, started_at)`.

## 6. API

Field (`/api/field`, cookie `vp_field`, roles operator/admin/super_admin):

| Method & path | Purpose |
|---|---|
| `POST /login`, `POST /logout` | session |
| `GET /bootstrap` | user, current workflow, languages, translations, field settings |
| `PUT /me/language`, `POST /me/password`, `POST /unlock` | operator self-service |
| `POST /images/begin` | idempotent (client IDs); creates round on first image, freezes workflow, ensures folders, supersedes previous image of the step, returns resumable upload URLs |
| `PUT /images/:id/cache/:kind` | recent-view cache copy (best effort) |
| `POST /images/:id/complete` | verify in Drive → acknowledge (or mark superseded) |
| `POST /rounds/:id/finalize` | idempotent DONE; 409 if anything missing/not uploaded |
| `GET /rounds/by-client/:clientRoundId` | server view for reconciliation |

Admin (`/api/admin`, cookie `vp_admin`, roles reviewer/admin/super_admin, every route
permission-checked server-side — see `src/worker/auth/permissions.ts`):

`GET /sets` (startDate,endDate,startTime,endTime,q,status,visibility,pageSize 20|50|100,
sort, keyset cursor + direction first|next|prev|last; returns rows + total) ·
`GET /sets/:id` · `POST /sets/:id/{hide|unhide|remove|restore}` · `PUT /sets/:id/plate` ·
`GET /images/:id/{thumb|display}` (recent only) · `POST /exports` +
`GET /exports/:id/images/:imageId` · `GET|PUT /settings` · `GET|POST /workflow` ·
`GET /i18n` · `PUT|DELETE /languages/:code` · `PUT /translations` · users CRUD
(`/users`, `/users/:id`, `/reset-password`, `/revoke-sessions`, `/pin`) · Drive
(`/drive/status`, `/drive/oauth/start`, `/drive/oauth/callback`, `/drive/disconnect`,
`/drive/share`) · `/storage`, `/storage/evict`, `/jobs/run`, `/jobs/:id/retry` · `/audit`.

## 7. Date/time filter semantics

One date-range button + one calendar; separate start/end time inputs with seconds.
The server builds **one continuous interval** `[startDate startTime, endDate endTime]`
in Asia/Bangkok, converts to UTC, and filters `started_at >= from AND started_at <= to`
where `to` is the last millisecond of the end second (inclusive). Reversed intervals are
rejected (400).

## 8. Quotas, limits and costs (free tiers change — re-check before relying on them)

| Service | Free allowance (approx.) | What uses it | Watch out |
|---|---|---|---|
| Workers | 100k requests/day, 10 ms CPU/request | ~6 API calls per photo + dashboard | PBKDF2 login CPU (see above) |
| D1 | 5 GB total, 500 MB per DB on free; 5M rows read/day | ~2–4 KB per set incl. images → ~150k sets/500 MB | `COUNT(*)` over huge ranges counts rows read; default view is "today" |
| R2 | 10 GB, 1M writes/10M reads per month, **no egress fee** | ~0.4 MB per image (display+thumb) | evicted at 70 % |
| Google Drive | 15 GB shared with Gmail/Photos | ~0.5–1.5 MB per photo (display + original) | **fills first**: ~200 sets/day ≈ 2–3 months. Google One 100 GB ≈ ฿70/month, or disable originals |
| Drive API | generous per-minute quotas, no cost | ~4 calls per photo | 403/429 back-off implemented |
| OCR | Vision ≈ 1000 units/month free; AI for Thai has its own quota | 1 call per set | Not unlimited; recognition not perfect |

**Metadata archiving:** at ~150k sets the 500 MB D1 database approaches its threshold. The
documented strategy (not automated yet): export old months to a JSONL manifest in Drive
(`_manifests/YYYY-MM.jsonl`) and then delete only the per-image rows for those months,
keeping the minimal `rounds` row (ID, times, plate, operator, Drive folder ID, hidden/removed)
so history search, pagination and folder links keep working. Records whose rows are fully
removed are **not searchable** in the app without extra infrastructure — that trade-off is
deliberate and explicit. Alternatively upgrade to Workers Paid (10 GB per DB).

## 9. Implementation plan (status)

1. Schema, auth, roles, sessions — **done**
2. Drive client, folder rules, demo Drive — **done**
3. Capture API: begin/complete/finalize, replacement safety, versioned workflow — **done**
4. Field PWA: engine, IndexedDB queue, compression/watermark, UI — **done**
5. Dashboard: history, filters, pagination, view/details, hide/remove, plate correction, export — **done**
6. Config: settings, workflow editor, languages/translations, live preview, members — **done**
7. Storage: R2 cache + threshold eviction, jobs, abandoned rounds, audit — **done**
8. OCR providers — **implemented, not validated with real plates** (needs keys + sample photos)
9. Metadata archive to Drive manifests — **documented only**
10. Native background uploads (Capacitor) — **not implemented** (see §2)
