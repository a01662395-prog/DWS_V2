# FEMSA · CifraControl — Dashboard Estático Zero-Knowledge

Plataforma corporativa **100 % estática y portable** para control de cifrado, inventario tecnológico, monitoreo de calidad de datos y generación de reportes ejecutivos/técnicos. Se ejecuta íntegramente en el navegador sin requerir servidor backend ni base de datos externa.

## Arquitectura Principal

1. **Capa Criptográfica Zero-Knowledge (`security/`):**
   - `security/crypto.js`: Derivación de clave maestra en RAM (`extractable: false`) mediante **PBKDF2-HMAC-SHA256** (250,000 iteraciones) y cifrado autenticado **AES-GCM-256** con IV aleatorio único de 12 bytes por registro.
   - `security/vault.js`: Gestión de sesión en memoria RAM, validación por testigo autenticado (canary), bloqueo automático por inactividad y protección con backoff ante intentos fallidos.
   - `security/secure-db.js`: Abstracción de lectura/escritura cifrada y transacciones atómicas sobre IndexedDB.

2. **Persistencia Local Cifrada (`db.js`):**
   - Base de datos local en `IndexedDB` (`cifracontrol_zk_vault_db`) dividida en `__vault_meta__`, `dataset_actual` (almacenamiento por lotes e índice) e `historial_cargas`.
   - Exportación e importación de paquetes de transporte `.enc.json` cifrados de extremo a extremo.

3. **Motor del Pipeline de Limpieza en Segundo Plano (`pipeline.js` + `pipeline-worker.js`):**
   - Procesa archivos `.xlsx`, `.xls`, `.csv` y `.tsv` localmente dentro de un **Web Worker** usando SheetJS (`vendor/xlsx.full.min.js`), sin bloquear el hilo principal ni depender de CDNs externos.
   - Implementa las reglas de limpieza, normalización e imputación del EDA (Partes A y B), generando banderas de calidad (`flag_*`).
   - `pipeline/pipeline.py` conserva la referencia equivalente en Python/Pandas para validación offline.

4. **Interfaz y Visualización (`index.html`, `app.js`, `dashboard-global.js`):**
   - **Dashboard Global:** Mapa 2D interactivo (`world.geojson`), KPIs globales, cobertura por sistema operativo y gestión (MDM/AD).
   - **Inventario y Alertas:** Búsqueda instantánea con caché indexada en memoria, filtros multiselección y detección de incoherencias.
   - **Historial y Reportes:** Evolución temporal entre cortes, comparativas entre periodos y exportación a PDF (Ejecutivo, Técnico y Comparativo).

## Ejecución Local

Cualquier servidor estático local permite ejecutar la aplicación (necesario para cargar `Web Workers` y `world.geojson` bajo políticas CORS/CSP):

```bash
# Opción 1: Python
python3 -m http.server 3000

# Opción 2: Node.js (npx)
npx serve -l 3000 .
```

Abrir en el navegador: `http://localhost:3000`

## Estructura del Repositorio

```text
index.html              Documento principal (CSP estricta + vistas SPA)
estilos.css             Sistema de diseño base (claro/oscuro)
dashboard-global.css    Estilos del dashboard global y mapa interactivo
app.js                  Controlador de vistas, motor de consultas local y reportes
dashboard-global.js     Mapa interactivo 2D y métricas globales
db.js                   Gestor de lotes, historial y respaldos cifrados en IndexedDB
pipeline.js             Cliente del Web Worker de ingesta
pipeline-worker.js      Pipeline de limpieza y validación (Partes A y B)
security/
  ├── crypto.js         Primitivas Web Crypto (PBKDF2 + AES-GCM-256)
  ├── vault.js          Ciclo de vida de la clave maestra y sesión en RAM
  └── secure-db.js      Lectura/escritura cifrada y transacciones atómicas
vendor/
  └── xlsx.full.min.js  Motor SheetJS local para lectura de Excel
muestras/               Archivos sintéticos de ejemplo para pruebas de carga
pipeline/
  └── pipeline.py       Script de referencia del pipeline en Python/Pandas
```
