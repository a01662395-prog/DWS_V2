# Agent Directives & Project Standards

## Project Overview
Static, zero-knowledge enterprise analytics dashboard (`FEMSA · CifraControl`) built with **Vanilla JavaScript (ES6+)**, **HTML5**, **CSS3 custom properties**, **Web Crypto API** (`PBKDF2-HMAC-SHA256` + `AES-GCM-256`), **IndexedDB**, and **Web Workers** (`SheetJS`).

## Core Commands
- **Static Dev Server:** `python3 -m http.server 3000`
- **JS Syntax Check:** `node --check app.js && node --check dashboard-global.js && node --check db.js && node --check pipeline.js && node --check pipeline-worker.js && node --check security/crypto.js && node --check security/vault.js && node --check security/secure-db.js`
- **Python Reference Pipeline Check:** `python3 -m py_compile pipeline/pipeline.py`

## Architecture & Code Quality Rules
1. **100% Static & Local Execution:** All data ingestion, cleaning, encryption, and querying run locally in the browser without external network calls or CDN dependencies (`Content-Security-Policy: default-src 'self'`).
2. **Data Validation & Sanitization:**
   - Guard every object deserialized from Excel/CSV or `.enc.json` packages against prototype pollution (`__proto__`, `constructor`, `prototype`).
   - Escape all dynamic values rendered into HTML templates using `esc()` / `reporteEsc()` or use DOM APIs (`textContent`, `createElement`).
3. **Atomic Encrypted Storage (`IndexedDB`):**
   - Never persist plaintext rows to disk. Always encrypt payloads via `SecureDB` (`AES-GCM-256` with unique 12-byte IVs).
   - Multi-record updates (e.g., batch data + index + history snapshot) must be encrypted in RAM first and committed in a single atomic IndexedDB `readwrite` transaction via `SecureDB.escribirTransaccionCifrada`.
4. **Performance & Responsiveness:**
   - Run file parsing and data cleaning inside `pipeline-worker.js` so the main UI thread never blocks.
   - Cache pre-mapped query projections in memory (`cacheConsultas`) and invalidate explicitly when dataset mutations or vault lock events occur.

## Security & Reliability Guardrails
- **Zero-Knowledge Key Lifecycle:** Master `CryptoKey` instances must always be derived with `extractable: false` and held exclusively in private RAM closures inside `Vault`, clearing references on lock or `beforeunload`.
- **Verification Protocol:** Before marking any task complete, verify that all JavaScript and Python files pass syntax checks without errors.
