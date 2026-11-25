# Guía Maestra de Presentación · FEMSA CifraControl

Esta guía resume **todo lo que necesitas dominar** para presentar **FEMSA · CifraControl** con criterio técnico de alto nivel: arquitectura, flujo de datos, criptografía, base de datos, pipeline de limpieza, decisiones de diseño (con alternativas descartadas) y respuestas a preguntas difíciles.

---

## 1. Elevator Pitch (60 segundos)

> **FEMSA · CifraControl** es una plataforma analítica **100 % estática, local y Zero-Knowledge** para auditar el estado de cifrado de disco del parque tecnológico. El usuario sube archivos Excel/CSV corporativos, un **Web Worker** los limpia y normaliza sin bloquear la interfaz, y toda la información se cifra en memoria RAM con **AES-GCM-256** (clave derivada con **PBKDF2-SHA256**) antes de tocar **IndexedDB**. Ningún dato sale del navegador, no existe backend ni dependencias externas de red, y el sistema consolida automáticamente múltiples cortes mensuales sin duplicar equipos en los KPIs.

---

## 2. Arquitectura General y Decisiones de Diseño

### Diagrama de Capas

En [`index.html`](file:///home/jose-manuel/DWS/index.html#L1065-L1071) los módulos se cargan en orden estricto de dependencias (sin bundlers ni imports remotos):

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ CAPA DE PRESENTACIÓN (UI / SPA por Hash)                                │
│  • app.js (Vistas, tablas, alertas, reportes PDF, apiLocal())           │
│  • dashboard-global.js (Globo 3D / Mapa con world.geojson, KPIs)        │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ consultas / mutaciones
          ┌─────────────────────┴─────────────────────┐
          ▼                                           ▼
┌───────────────────────────┐           ┌─────────────────────────────────┐
│ CAPA DE INGESTA (Worker)  │           │ CAPA DE DATOS (db.js)           │
│  • pipeline.js            │──────────►│  • Sanitización anti-pollution  │
│  • pipeline-worker.js     │           │  • Consolidación por equipo_id  │
│  • vendor/xlsx.full.min.js│           │  • Cola de escritura + caché    │
└───────────────────────────┘           └─────────────────┬───────────────┘
                                                          │ JSON plano en RAM
                                                          ▼
                                        ┌─────────────────────────────────┐
                                        │ PERSISTENCIA CIFRADA            │
                                        │  • security/secure-db.js        │
                                        │    (Transacciones atómicas +    │
                                        │     AAD "storeName:keyId")      │
                                        └─────────────────┬───────────────┘
                                                          │ Ciphertext + IV
                                                          ▼
                                        ┌─────────────────────────────────┐
                                        │ BÓVEDA Y CRIPTOGRAFÍA           │
                                        │  • security/vault.js (RAM/Canary│
                                        │  • security/crypto.js (WebCrypto│
                                        └─────────────────────────────────┘
```

### ¿Por qué tomamos cada decisión? (Trade-offs y Alternativas)

| Decisión elegida | Alternativas descartadas | ¿Por qué se eligió esta opción? |
| :--- | :--- | :--- |
| **100 % Estático y Local** (`default-src 'self'`) | Backend REST (Node/Python) + BD en la nube | **Cero superficie de ataque en red y cero exposición de inventario sensible.** Los datos de equipos, usuarios y vulnerabilidades de cifrado nunca abandonan la máquina del auditor. Despliegue trivial (Nginx/Docker o `python3 -m http.server`). |
| **Vanilla JS (ES6+) sin frameworks** | React / Vue / Angular + `node_modules` | **Cero deuda de dependencias, cero vulnerabilidades de cadena de suministro (npm)** y cumplimiento estricto de CSP sin `eval` ni compilación. Carga instantánea y control total sobre el ciclo de vida de la memoria RAM. |
| **Web Worker + SheetJS JS nativo** (`pipeline-worker.js`) | 1) Procesar en el hilo principal<br>2) Usar **Pyodide** (Python en WebAssembly) | Procesar en el hilo principal congelaría el navegador con archivos de 50k–100k filas. **Pyodide** requeriría descargar decenas de MB de runtime WASM. SheetJS en un Worker dedicado mantiene la UI a 60 FPS con bajo consumo de memoria. |
| **IndexedDB cifrada** (`SecureDB`) | `localStorage` / `sessionStorage` / SQLite WASM | `localStorage` es síncrono (bloquea UI), solo soporta strings y tiene límite de ~5 MB. **IndexedDB** es asíncrono, soporta `ArrayBuffer`/objetos binarios nativos (ideal para `iv` y `ciphertext` sin overhead Base64 en disco) y almacena cientos de MB. |
| **Fachada `apiLocal()` en `app.js`** | Llamar a `DB` directamente desde cada componente de vista | Desacopla la interfaz del almacenamiento. Si en el futuro la empresa decide conectar un backend real, basta con reemplazar `apiLocal('/dashboard/metrics')` por `fetch('/api/dashboard/metrics')` sin reescribir la UI. |

---

## 3. Capa de Seguridad Zero-Knowledge (`security/`)

### 3.1 Primitivas Criptográficas ([`security/crypto.js`](file:///home/jose-manuel/DWS/security/crypto.js))
Todo corre sobre la **Web Crypto API** nativa del navegador (implementada en C++/Rust dentro del motor del navegador, no en JS):

1. **Derivación de Clave (KDF):** `PBKDF2-HMAC-SHA256` con **600,000 iteraciones** (estándar OWASP vigente) y **Salt aleatorio de 16 bytes (128 bits)**.
   - *¿Por qué PBKDF2 y no Argon2id?* Porque `Web Crypto API` soporta `PBKDF2` de forma nativa y acelerada por hardware, mientras que Argon2 requeriría importar una librería WASM de terceros (rompiendo la política minimalista sin dependencias).
2. **Cifrado Simétrico Autenticado:** `AES-GCM-256` con **IV único de 12 bytes (96 bits)** generado con `crypto.getRandomValues` en **cada** operación de escritura.
   - *¿Por qué AES-GCM y no AES-CBC?* `AES-GCM` es **AEAD** (*Authenticated Encryption with Associated Data*): provee confidencialidad **e integridad** simultáneamente mediante un MAC Tag. Si alguien altera 1 bit en IndexedDB, el descifrado falla inmediatamente (`OperationError`).
3. **Clave no extraíble (`extractable: false`):** Al derivar la `CryptoKey`, se marca `extractable: false`. Ni siquiera un script malicioso inyectado podría exportar los bytes crudos de la clave maestra mediante `crypto.subtle.exportKey`.
4. **Limpieza de buffers y tiempo constante:** Los `Uint8Array` de contraseñas y texto plano se sobrescriben con `.fill(0)` en bloques `finally`, y las comparaciones críticas usan `compararTiempoConstante()` para evitar ataques de temporización.

### 3.2 Gestión de Bóveda y Sesión ([`security/vault.js`](file:///home/jose-manuel/DWS/security/vault.js))
- **Cero hashes de contraseña en disco (Patrón Canary):** No se guarda un hash de la contraseña para validar el login. En su lugar, al crear la bóveda se cifra una constante testigo (`FEMSA_ZERO_KNOWLEDGE_CANARY_V1`) junto con el rol en `__vault_meta__`. Al iniciar sesión, se deriva la clave y se intenta descifrar el *Canary*: si AES-GCM verifica el Tag y coincide el texto, la contraseña es correcta.
- **Aislamiento en RAM:** `claveActivaRAM` y `rolActivoRAM` viven únicamente dentro de una **clausura (IIFE)** privada en `Vault`. No están en `window`, ni en `localStorage`, ni en cookies.
- **Auto-bloqueo y Multi-pestaña:**
  - Timer de inactividad configurable (monitorea `mousedown`, `keydown`, `scroll`, `touchstart` con *throttling* de 5 s).
  - Listener `beforeunload` que destruye las referencias en RAM al cerrar o recargar.
  - `BroadcastChannel('cifracontrol_vault_sync')`: si bloqueas la bóveda en una pestaña, todas las demás pestañas abiertas se bloquean al instante; si cargas datos nuevos, las demás invalidan su caché.

### 3.3 Paquetes de Transporte (`.enc.json`)
Para compartir datos entre un **Administrador** y un **Operador** sin servidor:
- `cifrarPaqueteTransporte()` cifra el JSON con una contraseña de transporte usando `PBKDF2 (600k)` + `AES-GCM-256` + `AAD` de cabecera (`formato|algoritmo|kdf|iteraciones|exportadoEn`).
- El formato resultante (`FEMSA_CIFRACONTROL_ENCRYPTED_PACKAGE_V1`) incluye validación estricta de rango de iteraciones (`100,000` a `1,000,000`) para evitar ataques de degradación (*downgrade*).

---

## 4. Base de Datos Local Cifrada (`SecureDB` + `DB`)

### 4.1 Wrapper Criptográfico ([`security/secure-db.js`](file:///home/jose-manuel/DWS/security/secure-db.js))
Cada registro almacenado en IndexedDB tiene la forma `{ id, iv, ciphertext, aadVersion: 1, encryptedAt }`.
- **Binding con AAD (`storeName:keyId`):** Al cifrar, se pasa como *Additional Authenticated Data* el nombre del ObjectStore y el ID del registro. Esto impide un ataque de intercambio (*swap attack*): si alguien copia un registro cifrado de un store o ID a otro en IndexedDB, la verificación del MAC Tag fallará al descifrar.
- **Transacciones Atómicas (`escribirTransaccionCifrada`):** Primero cifra **todos** los registros en RAM en paralelo (`Promise.all`) y luego abre **una sola transacción `readwrite`** de IndexedDB para limpiar stores y escribir lote + índice + historial. Si falla el cifrado o la escritura, la base de datos no queda jamás en estado parcial.

### 4.2 Esquema y Lógica de Datos ([`db.js`](file:///home/jose-manuel/DWS/db.js))
Base de datos: `cifracontrol_zk_vault_db` (v2) con 3 ObjectStores (`keyPath: 'id'`):
1. `__vault_meta__`: Metadatos de la bóveda (salt, iteraciones, Canary cifrado).
2. `dataset_actual`: Almacena cada lote cifrado individual (`lote-...`) y el registro `__indice__` (lista ordenada de lotes y metadata combinada).
3. `historial_cargas`: Snapshots de cada carga (sin duplicar las filas completas; referencia al `loteId` para hidratar comparativas).

**Mecanismos clave en `db.js`:**
- **Consolidación inteligente entre cortes mensuales (`consolidarFilasDeLotes`):** Si en septiembre cargaste el equipo `EQ-100` como "Sin cifrar" y en octubre vuelves a subir un corte donde `EQ-100` ya aparece "Cifrado", `db.js` conserva ambos lotes intactos en el historial (para gráficas de evolución mensual), pero en el dataset activo **prevalece el registro del lote más reciente** por llave primaria (`equipo_id` o `finding_id`). Así no se duplican equipos ni se inflan los KPIs.
- **Protección contra Prototype Pollution:** `sanitizarFilas()` descarta claves `__proto__`, `constructor` y `prototype` de cualquier objeto deserializado de Excel/CSV o `.enc.json`.
- **Serialización de escrituras (`colaEscritura`):** Encadena promesas para evitar *race conditions* si se disparan dos escrituras concurrentes.

---

## 5. Pipeline de Limpieza e Ingesta (`pipeline.js` + `pipeline-worker.js`)

El Worker ([`pipeline-worker.js`](file:///home/jose-manuel/DWS/pipeline-worker.js)) replica en JavaScript nativo el pipeline de referencia en Python ([`pipeline/pipeline.py`](file:///home/jose-manuel/DWS/pipeline/pipeline.py)):

1. **Límites de seguridad (DoS protection):** Máximo **25 MB** por archivo, **100,000 filas** y **120 columnas** (`MAX_FILAS_ARCHIVO`, `MAX_COLUMNAS_ARCHIVO`). Timeout adaptativo en `pipeline.js` (entre 45 s y 180 s según el tamaño).
2. **Lectura y detección de encabezados:** Usa SheetJS (`vendor/xlsx.full.min.js`) y escanea las primeras filas para encontrar la fila de encabezados reales (por ejemplo, si el Excel corporativo trae títulos en la 3.ª fila).
3. **Normalización de esquema:** Convierte nombres de columnas a `snake_case` sin acentos (protegiendo contra claves prohibidas) y unifica variantes de nulos (`N/A`, `null`, `unknown`, `-`, etc.) a `'No disponible'` o `'No asignado'`.
4. **Limpieza en 2 Partes:**
   - **Parte A (`COLS_A`):** Datos técnicos y de cifrado (`equipo_id`, `sistema_operativo`, `version_so`, `estado_tpm`, `encryption_readiness`, `estado_de_cifrado`, `tecnologia_de_cifrado_state`, `estado_de_cumplimiento`, `fuente_de_datos`, `en_mdm`, `en_ad`, `en_mac_os`).
   - **Parte B (`COLS_B`):** Contexto organizacional y de uso (`usuario_id`, `pais`, `region`, `categoria_de_equipo`, `clase_de_equipo`, `perfil_de_privilegio`, `antiguedad_meses`, `banda_antiguedad`, `estado_de_cuenta`, `mes_ultimo_logon`, `banda_recencia`, `estado_hardware`, `tipo_de_red`).
5. **Banderas de calidad y auditoría (`flag_*`):** Calcula incoherencias automáticamente, como `flag_banda_recencia_incoherente` (si la fecha de último logon no cuadra con la banda declarada respecto a la fecha de corte) o `flag_sin_datos_b`.

---

## 6. Capa de UI, Rendimiento y Seguridad Front-end

- **Clasificación de Alertas:**
  - **Crítica:** Declara cumplimiento, pero el disco no está cifrado.
  - **Alta:** Equipo sin cifrar o recencia incoherente.
  - **Media:** Sin información de cifrado o antigüedad incoherente.
  - **Baja:** Hallazgos menores provenientes de columna `severity`.
- **Rendimiento:** `db.js` mantiene `cacheActual` en RAM y `app.js` mantiene `estado.cache` para que filtrar, ordenar y paginar tablas de miles de equipos sea instantáneo sin re-descifrar IndexedDB en cada clic. Ambos cachés se invalidan automáticamente ante eventos `LOCKED` o `DATA_UPDATED`.
- **Defensa contra XSS:**
  - CSP estricta en `index.html`: `default-src 'self'; script-src 'self'; worker-src 'self'; object-src 'none'`.
  - Todo contenido dinámico insertado en HTML pasa por `esc()` o se construye con APIs seguras del DOM (`document.createElement`, `textContent`).
- **Visualización Geoespacial ([`dashboard-global.js`](file:///home/jose-manuel/DWS/dashboard-global.js)):** Renderiza el mapa/globo interactivo usando [`world.geojson`](file:///home/jose-manuel/DWS/world.geojson) local y clasifica el estado de cada equipo de forma uniforme mediante `clasificarEstadoDetallado()`.

---

## 7. Preguntas Difíciles y Respuestas "Nivel Pro"

1. **"¿Qué pasa si un usuario olvida su contraseña? ¿Cómo la recuperan?"**
   - *Respuesta:* Por diseño **Zero-Knowledge**, no existe recuperación ni puerta trasera. La contraseña no se almacena ni se transmite; es la única semilla capaz de derivar la `CryptoKey` en RAM. Si se olvida, la única salida segura es restablecer la bóveda local (borrando los datos cifrados) y volver a importar un respaldo `.enc.json` o los archivos fuente.

2. **"¿Por qué el rol Administrador pide una clave local si todo corre en el navegador del cliente?"**
   - *Respuesta:* Como documenta `vault.js`, en una app 100 % client-side sin servidor, la separación `admin` / `operador` es un **control de flujo operativo** (para evitar que operadores modifiquen o ingesten fuentes crudas por error), reforzado con verificación PBKDF2-SHA256 y `Object.freeze`, no un control de identidad criptográfico frente a alguien con acceso físico y DevTools en su propia máquina. Para seguridad real de distribución, el Administrador exporta paquetes `.enc.json` cifrados.

3. **"¿Por qué la app exige abrirse en `http://localhost` y falla en `file://` o en una IP HTTP (`http://192.168.x.x`)?"**
   - *Respuesta:* Por dos restricciones estándar de seguridad de los navegadores modernos:
     1. Los **Web Workers** (`pipeline-worker.js`) y `fetch` a [`world.geojson`](file:///home/jose-manuel/DWS/world.geojson) son bloqueados por CORS bajo el protocolo `file://`.
     2. La **Web Crypto API** (`window.crypto.subtle`) solo está disponible en **Secure Contexts** (`https://` o `http://localhost`). En una IP de red local sin TLS, `crypto.subtle` es `undefined`.

4. **"¿Qué pasa si subo el reporte de septiembre y luego el de octubre con los mismos equipos? ¿Se duplican?"**
   - *Respuesta:* No. Cada carga se guarda cifrada como un lote independiente para preservar el historial y las comparativas mensuales, pero `DB.consolidarFilasDeLotes()` indexa por `equipo_id` (o `finding_id`) y hace que en la vista activa prevalezca únicamente el estado del lote más reciente.

5. **"¿Por qué no usaron un framework como React o una librería de gráficos externa?"**
   - *Respuesta:* El requisito central era una herramienta auditada, portátil, sin conexión a internet y con superficie de ataque mínima (`default-src 'self'`). Evitar frameworks y CDNs elimina cientos de dependencias transitivas de `npm`, evita problemas de CSP y nos da control determinista sobre la memoria RAM donde vive la clave maestra.

---

## 8. Ciencia de Datos, EDA y Calidad de Datos

Esta es una de las partes más fuertes del proyecto porque no se limita a "pintar un Excel": aplica un **pipeline formal de limpieza, estandarización, imputación controlada y detección de anomalías** nacido de un Análisis Exploratorio de Datos (`Initial_EDA.ipynb`).

### 8.1 Paridad Python (Referencia) ↔ JavaScript (Producción)
- El pipeline se diseñó primero en Python ([`pipeline/pipeline.py`](file:///home/jose-manuel/DWS/pipeline/pipeline.py)) usando `pandas`, `numpy` y `pyjanitor`.
- Para lograr ejecución 100 % local sin servidor ni Pyodide, toda la lógica matemática y de transformación se portó de forma idéntica a JavaScript nativo dentro de [`pipeline-worker.js`](file:///home/jose-manuel/DWS/pipeline-worker.js).
- *Por qué importa en la presentación:* Garantiza **reproducibilidad científica**. El script en Python sirve como especificación de referencia y herramienta de validación offline, mientras que el Worker ejecuta exactamente las mismas reglas en el navegador.

### 8.2 Limpieza y Estandarización (Data Wrangling)
El pipeline procesa los datos en dos bloques lógicos (**Parte A**: inventario técnico y cifrado; **Parte B**: contexto organizacional y uso):

1. **Detección dinámica de encabezados y normalización:**
   - Escanea hasta las primeras 10 filas (`MAX_SCAN_HEADER_ROWS`) para detectar dónde empiezan realmente los títulos (por ejemplo, fila 3 en reportes corporativos con encabezados decorativos).
   - Convierte nombres a `snake_case` sin acentos y separando `CamelCase` (`EquipoID` → `equipo_id`), validando que no existan colisiones de nombres tras normalizar.
2. **Unificación de valores faltantes (`PATRON_SIN_DATO`):**
   - Todas las variantes sucias (`N/A`, `na`, `null`, `none`, `unknown`, `-`, `sin informacion`, `desconocido`) se normalizan a `'No disponible'` (y en usuarios a `'No asignado'`), evitando que el mismo concepto aparezca fragmentado en 8 categorías distintas en las gráficas.
3. **Canonicalización categórica por moda (`CAT_B`):**
   - En columnas como `pais`, `region`, `categoria_de_equipo`, `clase_de_equipo`, `perfil_de_privilegio`, `estado_de_cuenta`, `estado_hardware` y `tipo_de_red`, es común tener variantes tipográficas (`"México"`, `"mexico"`, `"MEXICO "`).
   - El algoritmo agrupa por clave normalizada (`claveTxt`: minúsculas, sin acentos ni espacios extra) y selecciona automáticamente la **moda** (la forma escrita más frecuente en el archivo) como representación canónica.
4. **Imputación jerárquica trazable (`pais` → `region`):**
   - Si a un equipo le falta la `region` pero tiene `pais`, el pipeline verifica qué países tienen una relación **1 a 1 sin conflictos** con una única región.
   - Solo imputa la región en esos casos inequívocos y enciende la bandera `flag_region_imputada = true` para mantener trazabilidad total de qué datos son originales y cuáles fueron inferidos.
5. **Ingeniería de características (*Feature Engineering*):**
   - **Booleanos estrictos (`_bool`):** Convierte `"Sí"` / `"No"` en `en_mdm`, `en_ad`, `en_mac_os` a booleanos reales, reportando valores anómalos en `avisos`.
   - **Agrupación por familia de SO (`familia_so`):** Mapea builds técnicos de `version_so` (ej. `10.0.19*` → `Windows 10`, `10.0.22*` / `10.0.26*` → `Windows 11`, `macOS` / `26.*` → `macOS`) y alerta si aparecen versiones nuevas (`Sin clasificar`).
   - **Conteo de carga por usuario (`n_equipos_usuario`):** Calcula cuántos equipos tiene asignados cada `usuario_id` válido.
   - **Diferenciación semántica:** Convierte `Unknown` en `estado_de_cumplimiento` a `'No evaluado'` (porque sí podemos conocer su estado de cifrado aunque MDM/AD no lo haya evaluado).

### 8.3 Detección de Anomalías y Reglas de Coherencia (`flag_*`)
En lugar de borrar filas sospechosas en silencio, el pipeline genera **banderas booleanas de auditoría** por fila y un resumen cuantitativo en `meta.flags`:

| Bandera (`flag_*`) | Qué detecta (Regla de negocio / estadística) | Impacto en el análisis |
| :--- | :--- | :--- |
| `flag_compliant_sin_cifrar` | `estado_de_cumplimiento === 'Compliant'` **Y** `estado_de_cifrado === 'Not encrypted'` | **Contradicción crítica:** El equipo reporta estar en cumplimiento pero su disco no está cifrado. Dispara alertas **Críticas**. |
| `flag_sin_equipo_id` / `flag_equipo_id_duplicado` | Llaves primarias nulas o repetidas dentro del mismo corte | Permite auditar duplicidad en la fuente antes de consolidar KPIs. |
| `flag_banda_antiguedad_incoherente` | `antiguedad_meses` fuera de `[0, 600]` (absurdos > 50 años) se anula; luego valida si el número cae dentro del rango `[lo, hi]` de `banda_antiguedad` (ej. `'1-2 años'` → `[12, 24]`). | Detecta errores de captura o desfase entre el cálculo numérico y la etiqueta de banda. |
| `flag_banda_recencia_incoherente` | **Validación por intervalo de incertidumbre:** Como `mes_ultimo_logon` solo tiene precisión mensual (`YYYY-MM`), calcula el rango `[diasMin, diasMax]` posible dentro de ese mes respecto a la fecha de corte (`finDeMesUTC(fechaMax)`). Solo marca incoherencia si **ningún día** del mes cae dentro de `banda_recencia`. | Evita falsos positivos por redondeo mensual y detecta equipos cuya banda de actividad no corresponde a su último logon. |
| `flag_sin_estado_cifrado` / `n_campos_sin_dato` | Equipos sin dato de cifrado y conteo total de atributos faltantes en Parte A | Mide la **completitud (Data Quality Score)** de cada registro. |
| `flag_sin_datos_b` | Equipos presentes en Parte A sin ningún dato organizacional en Parte B | Identifica activos "huérfanos" en inventario técnico sin dueño/ubicación asignada. |

### 8.4 Análisis Longitudinal y Consolidación Temporal
- **Detección de fecha de corte:** Extrae automáticamente la fecha del corte del nombre del archivo (ej. `inventario_equipos_2026-10.xlsx` → `2026-10-31`) o, en su defecto, del mes máximo observado en `mes_ultimo_logon`.
- **Estado actual vs. Serie de tiempo:**
  - Para **KPIs y mapa actual**, `DB.consolidarFilasDeLotes()` aplica una lógica tipo *SCD Type 1* (Slowly Changing Dimension): prevalece el estado más reciente de cada `equipo_id`.
  - Para **Historial y Comparativas**, cada lote se conserva íntegro, permitiendo medir la **evolución mensual** de la tasa de cifrado (qué equipos pasaron de `Not encrypted` a `Encrypted` entre cortes).

---

## 9. Generación de Reportes y Exportación a PDF

El módulo de **Reportes** en [`app.js`](file:///home/jose-manuel/DWS/app.js#L2760-L3745) permite construir, previsualizar en vivo y exportar a PDF tres tipos de documentos sin depender de librerías externas como `jsPDF` o `html2canvas`.

### 9.1 Tipos de Reporte y Fuentes de Datos
1. **Tres enfoques según la audiencia (`reporteTipoActivo`):**
   - **Ejecutivo (`renderReporteEjecutivo`):** Orientado a toma de decisiones. Muestra KPIs de alto nivel, gráficas de barras CSS (estado, países, sistemas), geografía, resumen de alertas y recomendaciones automáticas.
   - **Técnico (`renderReporteTecnico`):** Orientado a TI y ciberseguridad. Incluye tablas detalladas por país/región/SO, cobertura de MDM y Active Directory, desglose de excepciones/inconsistencias y la tabla de **equipos que requieren atención**.
   - **Comparativo (`renderReporteComparativo`):** Toma dos snapshots históricos (`reportePeriodoInicialId` vs `reportePeriodoFinalId`) y calcula deltas en cantidad y puntos porcentuales (`pp`) de cobertura.
2. **Fuentes seleccionables (`reporteFuente`):** Puede alimentarse del dataset consolidado **actual** (`DB.obtenerActual()`), de un snapshot **histórico** puntual (`DB.obtenerHistorial()`) o de una comparación entre dos periodos.
3. **Personalización modular (`reporteContenido`):** El usuario puede activar o desactivar bloques individuales (`resumen`, `geografia`, `estado`, `sistemas`, `mdm`, `ad`, `cumplimiento`, `alertas`, `evolucion`, `comparacion`, `recomendaciones`, `detalle`) y aplicar filtros multicriterio; la vista previa se recalcula al instante.

### 9.2 ¿Cómo se genera el PDF? (Arquitectura Vectorial Nativa + Sandbox)
En lugar de capturar capturas de pantalla borrosas con `html2canvas` o importar librerías pesadas de generación de PDF, `descargarReportePDF(tipo)` utiliza el motor de impresión vectorial del navegador:

1. **Análisis y Sanitización:** `reporteAnalizar(reporteFiltradas)` calcula todas las métricas sobre los datos ya filtrados. Cada texto dinámico pasa por `reporteEsc()` (escapado HTML) antes de insertarse en la plantilla.
2. **Control de volumen para fluidez:** En la vista previa web, la tabla de detalle técnico se limita a **100 filas**; al generar el PDF (`paraPDF = true`), se amplía hasta **`MAX_FILAS_PDF_DETALLE = 2000`** registros para evitar que el motor de impresión del navegador se congele con documentos de cientos de páginas.
3. **Documento HTML autocontenido + CSP de aislamiento:** `reporteDocumentoHTML()` genera un documento HTML5 completo en memoria con:
   - Su propia **Content-Security-Policy** aún más restrictiva: `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:;` (cero scripts ejecutables dentro del reporte).
   - Reglas CSS `@page { size: A4 portrait; margin: 14mm 12mm 17mm }` y `print-color-adjust: exact` para que los colores de barras, badges y KPIs se impriman fielmente.
   - `aplicarPaletaPDF()` para unificar colores con la paleta corporativa oficial (`PALETA`).
4. **Renderizado en `Blob URL` y limpieza:**
   - Convierte el HTML en un `Blob` (`text/html;charset=utf-8`), crea una URL temporal en RAM (`URL.createObjectURL(blob)`) y la abre en una pestaña nueva (`window.open`).
   - Anula `ventana.opener = null` por seguridad, dispara `ventana.print()` (donde el usuario guarda como PDF vectorial con texto seleccionable) y revoca la `blobUrl` tras 15 segundos para liberar memoria.

*¿Por qué esta decisión es superior a `jsPDF`/`html2canvas`?* Produce PDFs **100 % vectoriales** (texto nítido y buscable, tablas que no se cortan a la mitad gracias a `break-inside: avoid`), pesa **0 KB de dependencias externas** y mantiene el aislamiento total de seguridad sin enviar datos a ningún servicio de conversión.
