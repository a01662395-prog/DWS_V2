/* ============================================================================
 *  CifraControl · Motor del Pipeline de Limpieza en Python (Pyodide Wasm)
 * ============================================================================
 *  Ejecuta el pipeline exacto de la rama RONIEL (Partes A y B de Initial_EDA)
 *  directamente dentro del navegador del usuario sin instalar Python ni Docker.
 *  Soporta archivos .xlsx, .xls y .csv/.tsv.
 * ========================================================================== */

'use strict';

const Pipeline = (() => {
  const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js';
  let pyodideListo = null;

  /** Código Python de limpieza de la rama RONIEL adaptado a Pyodide (sin depender de pyjanitor externo). */
  const CODIGO_PYTHON = `
import io
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import numpy as np
import pandas as pd

HEADER_EXCEL = 2
ETIQUETA_SIN_DATO = "No disponible"
ETIQUETA_SIN_USUARIO = "No asignado"
FECHA_CORTE_B = None

COLS_A = ["equipo_id", "sistema_operativo", "version_so", "estado_tpm", "encryption_readiness",
          "estado_de_cifrado", "tecnologia_de_cifrado_state", "estado_de_cumplimiento",
          "fuente_de_datos", "en_mdm", "en_ad", "en_mac_os"]
COLS_B = ["usuario_id", "pais", "region", "categoria_de_equipo", "clase_de_equipo",
          "perfil_de_privilegio", "antiguedad_meses", "banda_antiguedad", "estado_de_cuenta",
          "mes_ultimo_logon", "banda_recencia", "estado_hardware", "tipo_de_red"]

BOOL_COLS = ["en_mdm", "en_ad", "en_mac_os"]
MAPA_SI_NO = {"si": True, "no": False}

CAT_B = ["pais", "region", "categoria_de_equipo", "clase_de_equipo",
         "perfil_de_privilegio", "estado_de_cuenta", "estado_hardware", "tipo_de_red"]

PATRON_SIN_DATO = r"^\\s*(no disponible|desconocido|sin dato|sin informacion|n/?a|na|null|none|unknown|-)\\s*$"


def sin_acentos(texto):
    return "".join(ch for ch in unicodedata.normalize("NFKD", str(texto))
                   if not unicodedata.combining(ch))


def a_snake_case(nombre):
    s = sin_acentos(str(nombre)).strip()
    # Separa CamelCase (ej. EquipoID -> Equipo_ID, VulnerabilityTypeID -> Vulnerability_Type_ID)
    s = re.sub(r"([a-z0-9])([A-Z])", r"\\1_\\2", s)
    s = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\\1_\\2", s)
    # Quita caracteres especiales y reemplaza espacios/guiones por _
    s = re.sub(r"[^a-zA-Z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_").lower()
    return s or "columna"


def limpiar_nombres(df):
    out = df.copy()
    out.columns = [a_snake_case(c) for c in out.columns]
    return out


def es_sin_dato(s):
    return s.astype("string").map(lambda x: sin_acentos(x).lower() if pd.notna(x) else x) \\
            .str.match(PATRON_SIN_DATO, na=False)


def limpiar_espacios(s):
    return s.astype("string").str.strip().str.replace(r"\\s+", " ", regex=True)


def clave_txt(s):
    return limpiar_espacios(s).map(lambda x: sin_acentos(x).lower() if pd.notna(x) else x)


def familia_so(v):
    v = str(v)
    if v == ETIQUETA_SIN_DATO or v.lower() in ("nan", "<na>", "unknown", ""):
        return ETIQUETA_SIN_DATO
    if v.startswith("10.0.19") or v == "Windows 10":
        return "Windows 10"
    if v.startswith(("10.0.22", "10.0.26")) or v == "Windows 11":
        return "Windows 11"
    if v.startswith("Windows"):
        return "Windows (sin versión)"
    if v.startswith(("macOS", "26.")):
        return "macOS"
    return "Sin clasificar"


def conflictos_jerarquia(df, padre, hijo):
    con_dato = df[(df[padre] != ETIQUETA_SIN_DATO) & (df[hijo] != ETIQUETA_SIN_DATO)]
    if con_dato.empty:
        return pd.DataFrame()
    t = pd.crosstab(con_dato[padre], con_dato[hijo])
    return t[(t > 0).sum(axis=1) > 1]


def rango_banda(banda):
    b = sin_acentos(str(banda)).lower()
    if banda is pd.NA or b in ("nan", "<na>", sin_acentos(ETIQUETA_SIN_DATO).lower()):
        return (np.nan, np.nan)
    factor = 12 if "ano" in b else 1
    m = re.search(r"(\\d+)\\s*-\\s*(\\d+)", b)
    if m:
        return (int(m.group(1)) * factor, int(m.group(2)) * factor)
    m = re.search(r"(?:>|mas de)\\s*(\\d+)|(\\d+)\\s*\\+", b)
    if m:
        return (int(m.group(1) or m.group(2)) * factor, np.inf)
    m = re.search(r"(?:<|menos de)\\s*(\\d+)", b)
    if m:
        return (0, int(m.group(1)) * factor)
    return (np.nan, np.nan)


def bandas_no_entendibles(s):
    return sorted({v for v in s.dropna().unique()
                   if v != ETIQUETA_SIN_DATO and np.isnan(rango_banda(v)[0])})


def leer_archivo_bytes(nombre_archivo, raw_bytes):
    ext = os.path.splitext(nombre_archivo)[1].lower()
    bio = io.BytesIO(raw_bytes)
    if ext in (".xlsx", ".xls"):
        # Primero intentamos con header=HEADER_EXCEL (fila 3 del Excel corporativo)
        df_try = pd.read_excel(bio, header=HEADER_EXCEL)
        cols_norm = [a_snake_case(c) for c in df_try.columns]
        if "equipo_id" in cols_norm:
            return df_try
        # Si el usuario subió un Excel con encabezados en la fila 1 (header=0), lo detectamos automáticamente
        bio.seek(0)
        return pd.read_excel(bio, header=0)
    if ext in (".csv", ".tsv"):
        texto = raw_bytes.decode("utf-8", errors="replace")
        primera_linea = texto.splitlines()[0] if texto else ""
        sep = "\\t" if "\\t" in primera_linea and "," not in primera_linea else (";" if ";" in primera_linea and "," not in primera_linea else ",")
        return pd.read_csv(io.StringIO(texto), sep=sep)
    raise ValueError(f"extensión no admitida: {ext}")


def limpiar_a(data_raw, avisos):
    df_a = data_raw[COLS_A].copy()

    df_a["equipo_id"] = df_a["equipo_id"].astype("string").str.strip().str.upper()
    df_a["flag_sin_equipo_id"] = df_a["equipo_id"].isna()
    df_a["flag_equipo_id_duplicado"] = df_a["equipo_id"].notna() & df_a.duplicated("equipo_id", keep=False)
    if df_a["flag_sin_equipo_id"].any():
        avisos.append(f"Equipos sin EquipoID: {int(df_a['flag_sin_equipo_id'].sum())}")
    if df_a["flag_equipo_id_duplicado"].any():
        avisos.append(f"Filas con EquipoID repetido: {int(df_a['flag_equipo_id_duplicado'].sum())}")

    cat_cols = [c for c in COLS_A if c != "equipo_id"]

    for c in BOOL_COLS:
        s = df_a[c].map(lambda x: sin_acentos(x).strip().lower() if pd.notna(x) else x)
        inesperados = set(s.dropna().unique()) - set(MAPA_SI_NO)
        if inesperados:
            avisos.append(f"{c}: valores no esperados {sorted(inesperados)} → quedan sin dato en {c}_bool")
        df_a[f"{c}_bool"] = s.map(MAPA_SI_NO).astype("boolean")

    df_a["familia_so"] = df_a["version_so"].map(familia_so)
    cat_cols.append("familia_so")
    n_sin_clasificar = int((df_a["familia_so"] == "Sin clasificar").sum())
    if n_sin_clasificar:
        avisos.append(f"Versiones de SO sin clasificar: {n_sin_clasificar}")

    df_a["estado_de_cumplimiento"] = df_a["estado_de_cumplimiento"].replace({"Unknown": "No evaluado"})

    df_a["flag_compliant_sin_cifrar"] = (
        (df_a["estado_de_cumplimiento"] == "Compliant") &
        (df_a["estado_de_cifrado"] == "Not encrypted")
    )

    for c in cat_cols:
        mask = df_a[c].isna() | es_sin_dato(df_a[c])
        df_a[c] = df_a[c].astype("object").mask(mask, ETIQUETA_SIN_DATO)

    sin_dato = df_a[cat_cols] == ETIQUETA_SIN_DATO
    df_a["n_campos_sin_dato"] = sin_dato.sum(axis=1)
    df_a["flag_sin_estado_cifrado"] = df_a["estado_de_cifrado"] == ETIQUETA_SIN_DATO

    return df_a


def limpiar_b(data_raw, avisos):
    df_b = data_raw[["equipo_id"] + COLS_B].copy()
    df_b["equipo_id"] = df_b["equipo_id"].astype("string").str.strip().str.upper()

    u = df_b["usuario_id"].astype("string").str.strip()
    sin_usuario = (u.isna() | es_sin_dato(u)
                   | u.map(lambda x: sin_acentos(x).lower() if pd.notna(x) else x).eq("no asignado"))
    df_b["usuario_id"] = u.mask(sin_usuario, ETIQUETA_SIN_USUARIO)

    df_b["flag_sin_usuario"] = df_b["usuario_id"] == ETIQUETA_SIN_USUARIO
    equipos_por_usuario_b = df_b.loc[~df_b["flag_sin_usuario"], "usuario_id"].value_counts()
    df_b["n_equipos_usuario"] = (df_b["usuario_id"].map(equipos_por_usuario_b)
                                 .fillna(0).astype("Int64"))

    for c in CAT_B:
        s = limpiar_espacios(df_b[c])
        k = clave_txt(s)
        df_kv = pd.DataFrame({"k": k, "v": s}).dropna()
        if not df_kv.empty:
            forma = df_kv.groupby("k")["v"].agg(lambda g: g.value_counts().idxmax())
            nueva = k.map(forma)
        else:
            nueva = s
        mask = nueva.isna() | es_sin_dato(nueva)
        df_b[c] = nueva.astype("object").mask(mask, ETIQUETA_SIN_DATO)

    conf_pais = conflictos_jerarquia(df_b, "pais", "region")
    if len(conf_pais):
        avisos.append(f"Países con más de una región: {conf_pais.index.tolist()}")
    con_dato = df_b[(df_b["pais"] != ETIQUETA_SIN_DATO) & (df_b["region"] != ETIQUETA_SIN_DATO)]
    if not con_dato.empty:
        region_de_pais = (con_dato.groupby("pais")["region"].agg(lambda g: g.value_counts().idxmax())
                          .drop(conf_pais.index, errors="ignore"))
        completar = (df_b["region"] == ETIQUETA_SIN_DATO) & df_b["pais"].isin(region_de_pais.index)
        df_b["flag_region_imputada"] = completar
        df_b.loc[completar, "region"] = df_b.loc[completar, "pais"].map(region_de_pais)
    else:
        df_b["flag_region_imputada"] = False

    s = limpiar_espacios(df_b["banda_antiguedad"])
    df_b["banda_antiguedad"] = s.astype("object").mask(s.isna() | es_sin_dato(s), ETIQUETA_SIN_DATO)

    original = df_b["antiguedad_meses"]
    meses = pd.to_numeric(original.mask(es_sin_dato(original)), errors="coerce")
    absurdos = (meses < 0) | (meses > 600)
    df_b["antiguedad_meses_num"] = meses.mask(absurdos).astype("Float64")

    rangos = df_b["banda_antiguedad"].map(rango_banda)
    lo, hi = rangos.str[0], rangos.str[1]
    meses_f = df_b["antiguedad_meses_num"].astype(float)
    validable = df_b["antiguedad_meses_num"].notna() & lo.notna()
    dentro = (meses_f >= lo) & (meses_f <= hi)
    df_b["flag_banda_antiguedad_incoherente"] = validable & ~dentro
    no_ent = bandas_no_entendibles(df_b["banda_antiguedad"])
    if no_ent:
        avisos.append(f"Bandas de antigüedad no entendibles: {no_ent}")

    original = df_b["mes_ultimo_logon"]
    if pd.api.types.is_datetime64_any_dtype(original):
        fecha = original
    else:
        txt = limpiar_espacios(original)
        txt = txt.mask(es_sin_dato(txt))
        fecha = pd.to_datetime(txt, format="%Y-%m", errors="coerce")
        no_convertidas = int((txt.notna() & fecha.isna()).sum())
        if no_convertidas:
            avisos.append(f"mes_ultimo_logon: {no_convertidas} valores no se pudieron convertir a fecha")
    df_b["mes_ultimo_logon_fecha"] = fecha

    s = limpiar_espacios(df_b["banda_recencia"])
    df_b["banda_recencia"] = s.astype("object").mask(s.isna() | es_sin_dato(s), ETIQUETA_SIN_DATO)

    if fecha.notna().any():
        corte = FECHA_CORTE_B if FECHA_CORTE_B is not None else fecha.max() + pd.offsets.MonthEnd(0)
        dias_min = (corte - (fecha + pd.offsets.MonthEnd(0))).dt.days.clip(lower=0)
        dias_max = (corte - fecha).dt.days
        rangos = df_b["banda_recencia"].map(rango_banda)
        lo, hi = rangos.str[0], rangos.str[1]
        validable = fecha.notna() & lo.notna()
        df_b["flag_banda_recencia_incoherente"] = validable & ~((dias_max >= lo) & (dias_min <= hi))
    else:
        df_b["flag_banda_recencia_incoherente"] = False

    no_ent_rec = bandas_no_entendibles(df_b["banda_recencia"])
    if no_ent_rec:
        avisos.append(f"Bandas de recencia no entendibles: {no_ent_rec}")

    return df_b


def unir(df_a, df_b):
    df_ab = pd.concat([df_a, df_b.drop(columns="equipo_id")], axis=1)
    df_ab["flag_sin_datos_b"] = ~df_ab["equipo_id"].isin(df_b["equipo_id"].dropna())
    return df_ab


def limpiar_generico(df, avisos):
    """Si el usuario sube el TSV de muestras (findings_ejemplo.tsv) u otro CSV que no tiene equipo_id,
    lo limpia también con las mismas reglas de snake_case, espacios, nulos y genera sus métricas."""
    df = limpiar_nombres(df)
    for c in df.columns:
        if df[c].dtype == "object" or str(df[c].dtype) == "string":
            s = limpiar_espacios(df[c])
            mask = s.isna() | es_sin_dato(s)
            df[c] = s.astype("object").mask(mask, ETIQUETA_SIN_DATO)
    avisos.append("Archivo procesado con limpieza estándar (esquema flexible detectado).")
    return df


def ejecutar_pipeline_en_memoria(nombre_archivo, raw_bytes_js):
    avisos = []
    raw_bytes = bytes(raw_bytes_js)
    data_raw = leer_archivo_bytes(nombre_archivo, raw_bytes)
    if data_raw.empty:
        raise ValueError("El archivo no contiene filas.")

    data_norm = limpiar_nombres(data_raw)
    if not data_norm.columns.is_unique:
        raise ValueError("Dos columnas quedaron con el mismo nombre tras normalizarlas.")

    if "equipo_id" in data_norm.columns:
        esperadas = COLS_A + COLS_B
        nuevas = [c for c in data_norm.columns if c not in esperadas and data_norm[c].notna().any()]
        if nuevas:
            avisos.append(f"Se eliminaron columnas no reconocidas: {nuevas}")
        faltantes = [c for c in esperadas if c not in data_norm.columns]
        if faltantes:
            avisos.append(f"Faltan columnas; se cargan como '{ETIQUETA_SIN_DATO}': {faltantes}")
            for c in faltantes:
                data_norm[c] = pd.NA
        data_validada = data_norm[esperadas]
        df_ab = unir(limpiar_a(data_validada, avisos), limpiar_b(data_validada, avisos))
    else:
        # Soporte compatible también para muestras/findings_ejemplo.tsv o CSVs generales
        df_ab = limpiar_generico(data_raw, avisos)

    flags = [c for c in df_ab.columns if c.startswith("flag_")]
    meta = {
        "archivo_origen": nombre_archivo,
        "procesado_en": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "filas": int(len(df_ab)),
        "columnas": df_ab.columns.tolist(),
        "flags": {c: int(df_ab[c].sum()) for c in flags},
        "avisos": avisos,
    }
    registros_json = df_ab.to_json(orient="records", date_format="iso", force_ascii=False)
    return json.dumps({
        "ok": True,
        "meta": meta,
        "filas": json.loads(registros_json)
    }, ensure_ascii=False)
`;

  /** Carga el script de Pyodide en el navegador sólo cuando se requiere. */
  function cargarScriptPyodide() {
    if (window.loadPyodide) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PYODIDE_URL;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('No se pudo cargar el motor de Python (Pyodide). Verifica tu conexión a internet la primera vez.'));
      document.head.appendChild(s);
    });
  }

  /** Inicializa Pyodide + Pandas + OpenPyXL en WebAssembly. */
  async function inicializar(onProgress) {
    if (pyodideListo) return pyodideListo;

    pyodideListo = (async () => {
      if (onProgress) onProgress(15, 'Iniciando motor Python (Pyodide WebAssembly)…');
      await cargarScriptPyodide();
      const pyodide = await window.loadPyodide();

      if (onProgress) onProgress(40, 'Cargando librerías de ciencia de datos (pandas, numpy, openpyxl)…');
      await pyodide.loadPackage(['pandas', 'numpy', 'openpyxl']);

      if (onProgress) onProgress(70, 'Compilando pipeline de limpieza (Partes A y B)…');
      await pyodide.runPythonAsync(CODIGO_PYTHON);
      return pyodide;
    })();

    try {
      return await pyodideListo;
    } catch (err) {
      pyodideListo = null;
      throw err;
    }
  }

  /**
   * Ejecuta el pipeline de limpieza sobre un objeto File del navegador.
   * Si Pyodide está disponible lo procesa con el script exacto de Python;
   * si no hay internet para bajar Pyodide la primera vez y es un CSV/TSV, incluye fallback nativo.
   */
  async function procesarArchivo(archivo, onProgress) {
    const buffer = await archivo.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    try {
      const pyodide = await inicializar(onProgress);
      if (onProgress) onProgress(85, 'Limpiando y estandarizando filas con Python…');

      const fn = pyodide.globals.get('ejecutar_pipeline_en_memoria');
      const pyBytes = pyodide.toPy(bytes);
      const resultadoStr = fn(archivo.name, pyBytes);
      if (pyBytes && typeof pyBytes.destroy === 'function') pyBytes.destroy();
      const resultado = JSON.parse(resultadoStr);

      if (onProgress) onProgress(100, '¡Limpieza en Python completada!');
      return resultado;
    } catch (errPy) {
      // Si el usuario está 100% sin internet y sube un CSV/TSV, aplicamos el mismo pipeline en JS local de respaldo
      const ext = '.' + archivo.name.split('.').pop().toLowerCase();
      if (ext === '.csv' || ext === '.tsv') {
        if (onProgress) onProgress(85, 'Procesando con motor local de respaldo (modo offline)…');
        return procesarCsvFallbackLocal(archivo.name, buffer);
      }
      throw new Error(errPy.message || 'Error al ejecutar el pipeline de Python.');
    }
  }

  /** Respaldo offline instantáneo para CSV/TSV cuando no hay red para cargar el CDN de Wasm. */
  function procesarCsvFallbackLocal(nombreArchivo, buffer) {
    const texto = new TextDecoder('utf-8').decode(buffer);
    const lineas = texto.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lineas.length < 2) throw new Error('El archivo no contiene filas de datos.');

    const primera = lineas[0];
    const sep = primera.includes('\t') ? '\t' : (primera.includes(';') && !primera.includes(',') ? ';' : ',');

    const aSnake = (str) =>
      str
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .toLowerCase();

    const cabeceras = primera.split(sep).map((c) => aSnake(c.replace(/^"|"$/g, '').trim()));
    const patronSinDato = /^\s*(no disponible|desconocido|sin dato|sin informacion|n\/?a|na|null|none|unknown|-)\s*$/i;

    const filas = [];
    for (let i = 1; i < lineas.length; i++) {
      const cols = lineas[i].split(sep);
      const obj = {};
      cabeceras.forEach((col, idx) => {
        let val = (cols[idx] || '').replace(/^"|"$/g, '').trim();
        if (!val || patronSinDato.test(val)) val = 'No disponible';
        obj[col] = val;
      });
      filas.push(obj);
    }

    return {
      ok: true,
      meta: {
        archivo_origen: nombreArchivo,
        procesado_en: new Date().toISOString(),
        filas: filas.length,
        columnas: cabeceras,
        flags: {},
        avisos: ['Procesado en modo offline local (estandarización snake_case y limpieza de faltantes).'],
      },
      filas,
    };
  }

  return { procesarArchivo };
})();
