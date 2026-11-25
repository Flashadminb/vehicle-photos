# Project rules for AI assistants

## Free-tier quota review (required)
The owner runs this system on free tiers. **Every time you build something, change
something, or propose an idea**, include a short free-quota risk assessment in your reply
(in Thai, the owner's language):

- Which services it touches: Cloudflare Workers (requests/day, 10 ms CPU/request,
  subrequests), D1 (rows read/written per day, DB size), R2 (storage, Class A/B ops),
  Google Drive (15 GB storage shared with Gmail/Photos, API rate limits), Google OAuth
  (100-user cap for the unverified app), GitHub Actions minutes, OCR services, and the
  operators' mobile data / phone CPU.
- Estimated usage per photo set and per day, and at what daily volume the free tier runs out.
- A risk level (ต่ำ / กลาง / สูง) and the mitigation.
- Flag anything that could create a **charge** (e.g. Google Cloud billing, R2 over 10 GB).

Keep `docs/QUOTAS.md` up to date when usage characteristics change.

## Other conventions
- Dashboard and user-facing messages are Thai; the field app's texts are admin-editable (`src/shared/i18n.ts`).
- Never add a code path that PERMANENTLY deletes Google Drive files (`DriveClient` has no delete). The only
  destructive call is `setTrashed` (Drive trash, recoverable 30 days), used only by the Super-Admin
  "free up Drive space" feature (`services/drivetrash.ts`): finished sets only, typed confirmation, audited.
  Hide/remove must never call it.
- Run `npm run typecheck && npm test` before committing.
