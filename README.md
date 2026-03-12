# Kwangdong Market Survey MVP

A dependency-light Node/browser MVP for Kwangdong Pharm field market surveys. The app is smartphone-first, supports photo capture, stores product price matrices, auto-assigns field areas based on residence proximity first and fairness second, and gives admins a simple review/override console.

## MVP features
- **Mobile-first field survey** with store metadata, product-size price matrix entry, notes, and camera/photo upload.
- **Store-type quick templates** for `이마트 / GS 슈퍼`, `편의점`, `슈퍼 (POS 2개 이상)` to reduce mobile input effort.
- **Rule-based auto assignment** that prioritizes the researcher residence area first, then balances fairness using current submission counts.
- **Admin review console** in the same app shell for submission history and assignment overrides.
- **Storage fallback model**: local JSON persistence is always available for development/demo, with optional Google Sheets mirroring for production handoff.
- **No extra runtime dependencies**: pure Node.js + browser APIs.

## Project structure
- `src/server.js` — HTTP server, API routes, and static asset serving.
- `src/client/` — smartphone-first browser UI.
- `src/storage/` — local JSON persistence and Google Sheets mirror path.
- `tests/` — Node test runner coverage for assignment and API behavior.
- `scripts/lint.js` — lightweight formatting guard.
- `scripts/verify.js` — one-shot local verification runner.

## Quick start
```bash
cp .env.example .env
npm install
npm start
```

Then open `http://localhost:3000`.

> `npm install` does not fetch third-party packages in this MVP because the project intentionally ships without extra dependencies; it only creates/refreshes the lockfile if desired.

## Available scripts
- `npm start` — run the app
- `npm run dev` — run with Node watch mode
- `npm test` — run the Node test suite
- `npm run lint` — check for tabs/trailing whitespace
- `npm run typecheck` — syntax-check app, scripts, and tests using `node --check`
- `npm run verify` — run lint + typecheck + tests in sequence

## Environment
See `.env.example` for all supported variables.

### Core app settings
- `PORT`: server port (default `3000`)
- `ADMIN_TOKEN`: placeholder for future admin route protection / deployment secret
- `DATA_DIR`: root folder for local persistence
- `STORE_FILE`: JSON database file for submissions + overrides
- `UPLOADS_DIR`: where captured photos are stored locally

### Google Sheets integration
Set `GOOGLE_SHEETS_ENABLED=true` and provide:
- `GOOGLE_SHEETS_SPREADSHEET_ID`
- `GOOGLE_SHEETS_CLIENT_EMAIL`
- `GOOGLE_SHEETS_PRIVATE_KEY`
- `GOOGLE_SHEETS_SUBMISSIONS_RANGE`
- `GOOGLE_SHEETS_ASSIGNMENTS_RANGE`

Behavior:
1. submissions/overrides are written locally first
2. if Google Sheets is configured, the app mirrors rows to Sheets
3. if Google sync fails, the local write still succeeds and the sync error is retained in the response payload

## Suggested Google Sheets tabs
Create these tabs in the target spreadsheet:
- `Submissions`
- `Assignments`

Recommended columns:
- `Submissions`: submission id, timestamp, researcher, residence area, assigned area, region, store type, store name, POS count, display location, photo URL, notes, then one wide column per SKU/size from the shared sheet structure
- `Assignments`: submission id, assigned area, override reason, admin name, overridden at

The built-in product matrix is aligned to the shared sample sheet:
- 이온킥: 캔 240ml / PET 500ml / PET 1.5L
- 포카리스웨트: 캔 240ml / 캔 355ml / PET 620ml / PET 1.5L
- 파워에이드: 캔 240ml / 캔 355ml / PET 600ml / PET 1.5L
- 게토레이: 캔 240ml / PET 600ml / PET 1.5L
- 썬키스트: 사과 1.35L / 매실 1.35L

## Verification
```bash
npm run verify
```

Equivalent manual sequence:
```bash
npm run lint
npm run typecheck
npm test
```

## Local demo notes
- Photo uploads are stored in `data/uploads/`.
- Local state is kept in `data/store.json`.
- Delete the `data/` contents to reset the demo dataset.
- The app works without Google credentials for local demos and development.
