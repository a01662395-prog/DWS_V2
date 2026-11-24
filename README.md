# FEMSA · CifraControl

Panel para ver **qué equipos de la empresa tienen el disco cifrado y cuáles no**. Subes un archivo de Excel, el programa lo limpia y te muestra gráficas, mapas, tablas y reportes en PDF.

**Tus datos nunca salen de tu computadora.** No hay servidor, no hay internet de por medio: todo se guarda dentro de tu navegador y va protegido con una contraseña que solo tú conoces.

---

## 1. Antes de empezar: ¿qué te mandaron?

| Si recibiste… | Ve a… |
|---|---|
| Un archivo `cifracontrol-demo-1.0.tar.gz` | [Opción A](#opción-a--con-docker-la-más-fácil) |
| La carpeta completa del proyecto (o la bajaste de GitHub) | [Opción B](#opción-b--con-la-carpeta-del-proyecto-sin-docker) o la [Opción A.2](#a2-si-tienes-la-carpeta-del-proyecto) |

> **No funciona haciendo doble clic en `index.html`.** El navegador bloquea partes del programa (el procesamiento del Excel y el mapa) cuando se abre así. Hay que abrirlo con una de las opciones de abajo.

---

## 2. Cómo abrirlo

### Opción A · Con Docker (la más fácil)

**Qué necesitas:** tener **Docker** instalado.
- Windows / Mac: instala [Docker Desktop](https://www.docker.com/products/docker-desktop/) y ábrelo una vez (espera a que diga que está corriendo).
- Linux: instala `docker` desde tu gestor de paquetes.

**Dónde escribir los comandos:**
- Windows: busca **PowerShell** en el menú Inicio y ábrelo.
- Mac: abre **Terminal**.
- Linux: abre tu terminal.

#### A.1 Si te mandaron el archivo `.tar.gz`

1. Guarda el archivo en una carpeta, por ejemplo `Descargas`.
2. En la terminal, entra a esa carpeta:
   ```bash
   cd Descargas
   ```
3. Carga la imagen (solo se hace **una vez**, tarda unos segundos):
   ```bash
   docker load -i cifracontrol-demo-1.0.tar.gz
   ```
4. Arráncala:
   ```bash
   docker run -d --name cifracontrol-demo -p 8080:80 cifracontrol-demo:1.0
   ```
5. Abre tu navegador (Chrome, Edge o Firefox) y entra a:

   **http://localhost:8080**

#### A.2 Si tienes la carpeta del proyecto

Dentro de la carpeta del proyecto, ejecuta:

```bash
docker build -t cifracontrol-demo:1.0 .
docker run -d --name cifracontrol-demo -p 8080:80 cifracontrol-demo:1.0
```

Luego abre **http://localhost:8080**.

#### Para apagarlo o volver a prenderlo

```bash
docker stop cifracontrol-demo      # apagar
docker start cifracontrol-demo     # prender otra vez
docker rm -f cifracontrol-demo     # borrar el contenedor (tus datos NO se pierden, viven en el navegador)
```

---

### Opción B · Con la carpeta del proyecto (sin Docker)

**Qué necesitas:** tener **Python 3** instalado (revisa con `python3 --version`; en Windows prueba `python --version`). Si no lo tienes, descárgalo en [python.org](https://www.python.org/downloads/).

1. Abre la terminal **dentro de la carpeta del proyecto** (la que contiene `index.html`).
   - Windows: en el Explorador de archivos entra a la carpeta, escribe `powershell` en la barra de dirección y presiona Enter.
2. Ejecuta:
   ```bash
   python3 -m http.server 3000
   ```
   *(En Windows, si no funciona, usa `python -m http.server 3000` o `py -m http.server 3000`.)*
3. Abre el navegador en:

   **http://localhost:3000**

4. Para apagarlo: vuelve a la terminal y presiona `Ctrl + C`.

---

### Importante: usa siempre `localhost`

Escribe la dirección exactamente como `http://localhost:8080` (o `:3000`).
Si la abres desde otra computadora con una IP (por ejemplo `http://192.168.1.50:8080`), **el cifrado deja de funcionar** porque el navegador lo bloquea por seguridad, y verás errores al crear la contraseña.

---

## 3. Primer uso

### 3.1 Crea tu contraseña

La primera vez te pide crear una contraseña (mínimo 6 caracteres). Elige un **tipo de cuenta**:

| Tipo de cuenta | Qué puede hacer |
|---|---|
| **Operador** | Ver todo (gráficas, inventario, alertas, reportes) e **importar paquetes cifrados** (`.json`) que alguien más le comparta. |
| **Administrador** | Todo lo anterior y además **subir los archivos Excel/CSV originales**. Para crearla te piden una **clave de administrador** que debe darte quien te pasó el proyecto. |

> ⚠️ **Guarda bien tu contraseña.** Con ella se cifran tus datos. **No hay forma de recuperarla**: si la olvidas, la única salida es borrar todo y empezar de cero (ver [Preguntas frecuentes](#6-preguntas-frecuentes)).

### 3.2 Sube un archivo (solo Administrador)

1. En el menú de la izquierda entra a **Cargar datos**.
2. Arrastra tu archivo al recuadro o presiona **Buscar archivo**.
3. Espera a que termine la barra de progreso. Al final verás un resumen con avisos de limpieza.

Para probar sin archivos propios, usa los de ejemplo que están en la carpeta [`muestras/`](muestras/):
`inventario_equipos_2026-09.xlsx`, `2026-10`, `2026-11`, `2026-12` y `2027-01`.

**Requisitos del archivo:**
- Formatos: `.xlsx`, `.xls`, `.csv` o `.tsv`.
- Tamaño máximo: **25 MB** y hasta **100,000 filas**.
- Debe tener una columna llamada **`EquipoID`**. Si el Excel trae los títulos en la 3.ª fila, el programa los detecta solo.
- Puedes subir varios archivos: se **van acumulando**.

---

## 4. Qué hay en cada pantalla

| Menú | Para qué sirve |
|---|---|
| **Dashboard global** | La vista principal: mapa por país, KPIs, cifrado por sistema operativo, MDM / Active Directory y los equipos más críticos. Arriba tienes filtros por **Mes**, **Región**, **País** y **Estado de cifrado**. |
| **Inventario** | Tabla de todos los equipos con búsqueda, filtros y ordenamiento. |
| **Alertas de cifrado** | Lista de equipos con problemas, por severidad (Crítica, Alta, Media, Baja). Se puede buscar por número de serie. |
| **Reportes** | Genera reportes **Ejecutivo**, **Técnico** o **Comparativo** y los imprime o guarda como PDF. |
| **Historial de datos** | Cargas anteriores, comparación entre periodos y evolución mensual. |
| **Cargar datos** | Subir Excel/CSV (Administrador) o importar paquetes cifrados. |
| **Ajustes** | Tema oscuro, bloqueo automático, cambiar contraseña, respaldo y borrado de datos. |

### Cómo se clasifican las alertas

| Severidad | Cuándo aparece |
|---|---|
| **Crítica** | El equipo dice estar en cumplimiento, pero su disco **no está cifrado**. |
| **Alta** | Equipo **sin cifrar**, o su último acceso no coincide con su banda de recencia. |
| **Media** | **Sin información** de cifrado, o su antigüedad no coincide con su banda. |
| **Baja** | Hallazgos de baja prioridad que traiga el archivo en una columna `severity`. |

---

## 5. Compartir tus datos con otra persona

Los datos viven solo en **tu** navegador. Para pasárselos a alguien:

1. Entra a **Ajustes → Compartir / Respaldar Base de Datos**.
2. Escribe una **contraseña para el archivo** (puede ser distinta a la tuya) y presiona **Exportar archivo (.json)**.
3. Mándale el archivo `.enc.json` y, **por otro medio**, esa contraseña.
4. La otra persona entra a **Ajustes → Importar archivo (.json)** (o a **Paquetes cifrados**), escoge el archivo y escribe la contraseña.

El archivo no se puede leer ni modificar sin la contraseña.

---

## 6. Preguntas frecuentes

**Se cerró la sesión sola.**
Es el bloqueo por inactividad (10 minutos por defecto). Vuelve a escribir tu contraseña. Puedes cambiar el tiempo o apagarlo en **Ajustes**.

**Olvidé mi contraseña.**
No se puede recuperar: nadie, ni quien hizo el programa, puede abrir tus datos sin ella. La única salida es **borrar los datos guardados y empezar de cero**:
1. En Chrome o Edge, con la página abierta, presiona `F12`, ve a la pestaña **Application** (Aplicación), entra a **Storage** (Almacenamiento) y presiona **Clear site data** (Borrar datos del sitio).
   En Firefox: `F12` → **Almacenamiento** → clic derecho sobre `localhost` → **Eliminar todo**.
2. Recarga la página (`F5`) y crea una contraseña nueva.

> Si todavía tienes la sesión abierta, también puedes hacerlo desde **Ajustes → Restablecer de fábrica** (te pide escribir `BORRAR BOVEDA`). **Cualquiera de las dos formas borra todos los datos.**

**Subí un archivo y me dice que no es válido.**
Revisa que sea `.xlsx`, `.xls`, `.csv` o `.tsv`, que pese menos de 25 MB, tenga menos de 100,000 filas y traiga la columna `EquipoID`.

**Entro con Operador y no veo dónde subir Excel.**
Es correcto: solo el Administrador sube archivos originales. El Operador importa paquetes `.json` cifrados.

**Cambié a otro navegador (o a otra computadora) y no veo mis datos.**
Los datos son por navegador. Impórtalos con el paquete cifrado de la sección 5.

**El puerto 8080 (o 3000) ya está en uso.**
Cambia el número. Por ejemplo, con Docker usa `-p 8090:80` y abre `http://localhost:8090`; con Python usa `python3 -m http.server 3100`.

**Aparece "Docker no se reconoce como comando".**
Docker no está instalado o no está abierto. En Windows/Mac abre Docker Desktop y espera a que termine de iniciar.

**No se descarga o imprime el PDF.**
Permite las ventanas emergentes de la página en tu navegador: los reportes se abren en una ventana nueva.

---

## 7. Privacidad y seguridad (en pocas palabras)

- Todo se procesa **dentro de tu navegador**. No se envía nada a internet.
- Los datos se guardan **cifrados** (AES-GCM de 256 bits con datos adicionales autenticados AAD) usando una llave derivada de tu contraseña (PBKDF2-HMAC-SHA256, 600,000 iteraciones).
- Cuando subes nuevos cortes mensuales, la base de datos **consolida automáticamente por `EquipoID`** (prevalece el corte más reciente) para no duplicar equipos en los KPIs, conservando cada corte mensual intacto en el historial.
- Al ser una aplicación 100 % local en el navegador (Zero-Knowledge), la distinción entre **Administrador** y **Operador** es un control de flujo operativo sellado en el testigo cifrado de la bóveda local.
- Al bloquear la sesión o cerrar la pestaña, la llave se borra de la memoria.
- Si alguien copia los archivos de tu navegador, solo verá datos ilegibles.

---

## 8. Para quien quiera saber más (técnico)

- **Tecnología:** JavaScript puro (sin frameworks), HTML, CSS, Web Crypto API, IndexedDB y un Web Worker con SheetJS para limpiar los archivos sin congelar la pantalla.
- **100 % estático:** no tiene backend ni base de datos externa. Docker solo sirve los archivos con nginx.
- **Revisión de sintaxis** (para desarrolladores):
  ```bash
  node --check app.js && node --check dashboard-global.js && node --check db.js \
    && node --check pipeline.js && node --check pipeline-worker.js \
    && node --check security/crypto.js && node --check security/vault.js \
    && node --check security/secure-db.js
  python3 -m py_compile pipeline/pipeline.py
  ```

### Estructura de la carpeta

```text
index.html              Página principal
app.js                  Pantallas, consultas y reportes
dashboard-global.js     Mapa y gráficas del dashboard global
db.js                   Guardado cifrado en el navegador (IndexedDB)
pipeline.js             Conexión con el procesador de archivos
pipeline-worker.js      Limpieza de datos en segundo plano
security/               Cifrado, contraseña y sesión
  crypto.js  vault.js  secure-db.js
vendor/xlsx.full.min.js Lector de Excel (local, sin internet)
estilos.css             Estilos generales
dashboard-global.css    Estilos del dashboard global
world.geojson           Mapa de países
muestras/               Archivos de ejemplo para probar
pipeline/pipeline.py    Versión de referencia en Python
Dockerfile, nginx.conf  Para empaquetar la demo en un contenedor
```
