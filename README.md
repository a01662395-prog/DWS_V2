# CifraControl · Dashboard

Dashboard de inventario tecnológico hecho en **vanilla JavaScript** (sin frameworks) con un backend en **Node.js puro** (sin Express ni Multer) y **PostgreSQL** para persistir la ingesta. Se ejecuta entero en **Docker**.

## Arranque rápido

```bash
cp .env.example .env      # opcional: ajustar credenciales
docker compose up -d --build
```

- Panel: http://localhost:3000
- Salud: http://localhost:3000/api/health (incluye el estado de PostgreSQL)
- Logs: `docker compose logs -f`
- Parar: `docker compose down` (los datos y los archivos subidos se conservan)

La primera vez que arranca, el backend crea el esquema (`findings` e `ingestas`) de forma idempotente.

## Requisitos

- Docker + Docker Compose (no hace falta Node.js instalado)
- Acceso a Docker (`sudo usermod -aG docker $USER` y reiniciar sesión, o usar `sudo`)

## Ejecutar sin Docker

Requiere `node`, el cliente `psql` en el `PATH` y un PostgreSQL accesible:

```bash
PGHOST=127.0.0.1 PGPORT=5432 PGUSER=cifracontrol PGPASSWORD=cifracontrol PGDATABASE=cifracontrol \
  node server.js
```

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `HOST` | `127.0.0.1` (`0.0.0.0` en Docker) | Interfaz de escucha |
| `UPLOADS_DIR` | `./uploads` (`/app/uploads` en Docker) | Carpeta de recepción de Excel/CSV |
| `SIMULATED_DELAY_MS` | `900` | Retardo simulado para ver los Skeleton Loaders |
| `PGHOST` | `postgres` | Host de PostgreSQL (`postgres` = servicio de Compose) |
| `PGPORT` | `5432` | Puerto de PostgreSQL |
| `PGUSER` | `cifracontrol` | Usuario de PostgreSQL |
| `PGPASSWORD` | `cifracontrol` | Contraseña de PostgreSQL |
| `PGDATABASE` | `cifracontrol` | Base de datos |

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servicio |
| GET | `/api/dashboard/metrics` | KPIs + series |
| GET | `/api/dashboard/inventario` | Activos filtrables y paginados |
| GET | `/api/dashboard/tecnologias` | Stack detectado con riesgo |
| GET | `/api/dashboard/monitoreo` | Salud de servicios |
| GET | `/api/dashboard/excepciones` | Incidencias por severidad |
| GET | `/api/uploads` | Metadatos de lo recibido |
| POST | `/api/upload-excel` | Ingesta `.xlsx` / `.xls` → vol. uploads · `.csv` (TSV) → PostgreSQL |

## Subir un Excel / TSV

Desde la web (pestaña de ingesta) o por curl:

```bash
# CSV/TSV → se cargan en la tabla `findings` (append)
curl -F "file=@findings.tsv" http://localhost:3000/api/upload-excel

# XLSX/XLS → quedan almacenados en cola (sin parser todavía)
curl -F "file=@inventario.xlsx" http://localhost:3000/api/upload-excel
```

El CSV/TSV debe traer la cabecera en el **mismo orden** que las columnas de la tabla `findings` (ver `muestras/findings_ejemplo.tsv`). El fichero se guarda también en el volumen `uploads_data` (auditoría) y **no** se versiona en el repositorio.

### Cómo funciona la carga

- Sin cliente npm: el backend delega en el binario **`psql`** (`COPY ... FROM STDIN`).
- Una sola **transacción**: si una fila no cuadra (columnas, comillas), **no se inserta nada** (rollback).
- Cada carga queda registrada en la tabla `ingestas` (archivo, filas, bytes, fecha).

## Usar tu propia imagen de PostgreSQL

Si tienes una imagen guardada en un `.tar`:

```bash
sudo docker load -i postgres_image.tar   # imprime "Loaded image: repo:tag", anótalo
docker images                            # confírmalo
```

Luego en `.env`:

```dotenv
POSTGRES_IMAGE=repo:tag
```

Sin `.env`, se usa `postgres:16-alpine` oficial.

## Estructura

```
index.html             Frontend (vanilla)
app.js                 Lógica del dashboard
estilos.css            Estilos
server.js              Backend Node.js (sólo módulos nativos + psql)
Dockerfile             Imagen del servicio (incluye postgresql-client)
docker-compose.yml     Servicios: dashboard + postgres + volúmenes
.env.example           Variables de configuración (copiar a .env)
muestras/              TSV sintético de ejemplo para probar la ingesta
```

> **Nota:** los ficheros de `uploads/` contienen datos de clientes y **nunca** se versionan (están en `.gitignore` y en `.dockerignore`).
