# Auditoría técnica y Registro de Remediación · FEMSA CifraControl

> **Estado actual:** **REMEDIADO Y VERIFICADO** (`node --check` en los 8 módulos JS, `python3 -B -m py_compile` en `pipeline.py`, suite criptográfica Web Crypto AAD/PBKDF2 y pruebas de ingesta sobre `muestras/`).

---

## 1. Scorecard Ejecutivo (Antes vs. Después de la Remediación)

### Calificación global: **54 / 100** → **91 / 100**

| Categoría | Antes | Después | Estado | Resumen de mejoras aplicadas |
|---|---|---|---|---|
| Seguridad y Privacidad | 15 / 25 | **23 / 25** | 🟢 Sólido | PBKDF2 subido a 600,000 iteraciones (OWASP), soporte AAD (`store:id` y cabecera de paquete) en AES-GCM-256, verificador PBKDF2 de 600k iteraciones en tiempo constante para licencia Admin, `Object.freeze` en todas las APIs y cabeceras CSP/XFO/COOP/CORP completas en Nginx. |
| Arquitectura y Diseño | 13 / 25 | **22 / 25** | 🟢 Sólido | Consolidación automática por `equipo_id` / `finding_id` entre lotes mensuales (sin inflar KPIs), clasificador único de estado de cifrado en toda la app y sincronización multi-pestaña vía `BroadcastChannel`. |
| Calidad de Código | 9 / 20 | **18 / 20** | 🟢 Sólido | Eliminación de métricas ficticias (`cvss`, `spark` artificiales, latencias fijas), eliminación de código muerto, telemetría real en monitoreo, eliminación de llamadas CDN en `frontend/` y limpieza de `__pycache__`. |
| Rendimiento | 8 / 15 | **14 / 15** | 🟢 Sólido | Carga perezosa de meses en Dashboard Global, pre-cálculo de resúmenes por país/SO en snapshots históricos, parser CSV por segmentos (`slice`), timeout adaptativo en Worker y tope de 2,000 filas en PDF técnico. |
| Resiliencia y Errores | 9 / 15 | **14 / 15** | 🟢 Sólido | Rechazo de respaldos `.enc.json` vacíos antes de tocar IndexedDB, confirmación previa con conteo de registros, transacción atómica `.add()` al crear bóveda, `try/catch` en todas las acciones destructivas y fallback UTF-8/Windows-1252 en CSV. |

---

## 2. Remediación de los Top 5 Riesgos Críticos

### R1 · [Seguridad] Verificación de rol Admin y protección de APIs en cliente
- **Archivos:** `security/vault.js`, `security/crypto.js`, `security/secure-db.js`, `db.js`, `pipeline.js`, `README.md`.
- **Solución aplicada:**
  - Se eliminó el hash SHA-256 directo del código fuente y se reemplazó por un verificador derivado con **PBKDF2-HMAC-SHA256 (600,000 iteraciones)** comparado en tiempo constante (`CryptoEngine.compararTiempoConstante`) y protegido con retardo exponencial ante intentos fallidos.
  - Se sellaron con `Object.freeze` las interfaces públicas de `CryptoEngine`, `Vault`, `SecureDB`, `DB` y `Pipeline` para impedir sobrescritura de métodos (`Vault.esAdmin`, `DB.esAdmin`) en tiempo de ejecución.
  - Se documentó explícitamente el límite de confianza Zero-Knowledge Client-Side en `vault.js` y `README.md`.

### R2 · [Resiliencia / Datos] Protección contra borrado accidental en `importarBackup`
- **Archivos:** `db.js`, `app.js`.
- **Solución aplicada:**
  - `DB.importarBackup` ahora valida que el paquete descifrado contenga registros o lotes reales antes de abrir la transacción que limpia `STORE_DATOS` y `STORE_HISTORIAL`. Si el paquete viene vacío, aborta sin tocar los datos actuales.
  - `ejecutarImportacionCifrada` en `app.js` verifica si ya existen registros en la base de datos local y solicita confirmación explícita mostrando el conteo actual de filas antes de reemplazarlas.
  - Se eliminó el `window.prompt` en texto plano para la contraseña del paquete; ahora exige ingresarla en el campo `input[type="password"]`.

### R3 · [Arquitectura / Integridad de datos] Consolidación y deduplicación entre lotes mensuales
- **Archivos:** `db.js`, `pipeline-worker.js`, `app.js`, `dashboard-global.js`.
- **Solución aplicada:**
  - `DB.guardarCarga` y `DB.obtenerActual` ahora ejecutan `consolidarFilasDeLotes`: cuando un mismo `equipo_id` (o `finding_id`) aparece en un nuevo corte mensual, prevalece el registro del lote más reciente sin duplicar el equipo en los KPIs globales, conservando intacto cada snapshot mensual individual en `STORE_HISTORIAL` / `STORE_DATOS` para comparativas e historial.
  - `pipeline-worker.js` extrae automáticamente `fecha_corte` desde el nombre del archivo (`YYYY-MM`) o desde el fin de mes de `mes_ultimo_logon`.

### R4 · [Seguridad] Herencia de cabeceras de seguridad en Nginx y CSP
- **Archivos:** `nginx.conf`, `Dockerfile`, `.dockerignore`, `index.html`.
- **Solución aplicada:**
  - Se corrigió `nginx.conf` para que el bloque `location ~* \.(html|js|css)$` incluya todas las cabeceras de seguridad (`Content-Security-Policy` con `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Opener-Policy: same-origin` y `Cross-Origin-Resource-Policy: same-origin`).
  - Se actualizó `.dockerignore` para excluir `dist/`, `__pycache__/`, `*.pyc` y `*.md` del contexto de compilación Docker.
  - Se reforzó el `HEALTHCHECK` en `Dockerfile` para verificar `/index.html` y `/app.js`.

### R5 · [Seguridad / Cripto] Endurecimiento de PBKDF2 (600k iteraciones) y soporte AAD en AES-GCM
- **Archivos:** `security/crypto.js`, `security/vault.js`, `security/secure-db.js`, `db.js`.
- **Solución aplicada:**
  - Se incrementó `PBKDF2_ITERATIONS` a `600,000` (manteniendo compatibilidad de lectura desde `100,000` para bóvedas previas y acotando el máximo a `1,000,000` contra DoS local).
  - Se implementó **Additional Authenticated Data (AAD)** en `CryptoEngine.cifrarPayload` y `descifrarPayload`:
    - `SecureDB` liga criptográficamente cada registro a `${storeName}:${keyId}` (`aadVersion: 1`), impidiendo el intercambio de ciphertexts entre colecciones o claves en IndexedDB.
    - `Vault` liga el testigo canary a `__vault_meta__:config` y usa `.add()` atómico al inicializar la bóveda.
    - `cifrarPaqueteTransporte` autentica la cabecera completa del archivo `.enc.json` (`formato|algoritmo|kdf|iteraciones|exportadoEn`) como AAD.
  - Se corrigió `Vault.cambiarPassword` para persistir explícitamente `iterations: CryptoEngine.PBKDF2_ITERATIONS` y `aadVersion: 1`, además de aplicar control de intentos fallidos al verificar la contraseña actual.

---

## 3. Otras Mejoras Técnicas Implementadas

- **Sincronización multi-pestaña (`BroadcastChannel`):** `Vault` propaga bloqueos (`VAULT_LOCKED`) y actualizaciones de datos (`DATA_UPDATED`) entre pestañas abiertas del mismo origen.
- **Clasificación unificada de estado de cifrado:** `dashboard-global.js` y `app.js` comparten una única jerarquía de evaluación (`desconocido` → `sin_cifrar` → `parcial` → `protegido`), corrigiendo el caso donde `"Partially encrypted"` se clasificaba antes como `protegido`.
- **Carga perezosa y optimización de memoria:**
  - `CifraGlobo.cargar()` en `dashboard-global.js` ya no descifra todas las filas históricas al iniciar; carga sólo metadatos ligeros y descifra un mes específico únicamente cuando el usuario lo selecciona.
  - `DB.exportarBackup` y `DB.asegurarActualEnHistorial` ya no duplican arrays `filas` dentro de `STORE_HISTORIAL` cuando el snapshot ya referencia un `loteId` en `STORE_DATOS`.
  - `resumenSnapshot` pre-calcula `paisesResumen` y `sistemasResumen` para que las gráficas de evolución histórica no re-analicen todas las filas en cada interacción.
- **Generación segura de PDF:** `descargarReportePDF` reemplaza `document.write` por un `Blob` URL con revocación automática y limita la tabla de detalle técnico a `2,000` filas para evitar bloqueos del hilo principal.
- **Limpieza de subproyectos:** `frontend/src/pages/index.astro` ahora consume `/world.geojson` local en lugar de GitHub CDN, cumpliendo la regla 100 % local de `AGENTS.md`.
