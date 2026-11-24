/* ============================================================================
 *  CifraControl · Web Worker de Limpieza y Estandarización (JS Nativo)
 * ============================================================================
 *  Ejecuta el pipeline completo (Partes A y B de Initial_EDA) en un hilo
 *  separado con SheetJS local, sin Pyodide ni bloqueo de la interfaz.
 * ========================================================================== */

'use strict';

importScripts('vendor/xlsx.full.min.js');

const HEADER_EXCEL = 2;
const ETIQUETA_SIN_DATO = 'No disponible';
const ETIQUETA_SIN_USUARIO = 'No asignado';
const MAX_FILAS_ARCHIVO = 100000;
const MAX_COLUMNAS_ARCHIVO = 120;
const CLAVES_PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);

const COLS_A = [
  'equipo_id', 'sistema_operativo', 'version_so', 'estado_tpm', 'encryption_readiness',
  'estado_de_cifrado', 'tecnologia_de_cifrado_state', 'estado_de_cumplimiento',
  'fuente_de_datos', 'en_mdm', 'en_ad', 'en_mac_os',
];

const COLS_B = [
  'usuario_id', 'pais', 'region', 'categoria_de_equipo', 'clase_de_equipo',
  'perfil_de_privilegio', 'antiguedad_meses', 'banda_antiguedad', 'estado_de_cuenta',
  'mes_ultimo_logon', 'banda_recencia', 'estado_hardware', 'tipo_de_red',
];

const BOOL_COLS = ['en_mdm', 'en_ad', 'en_mac_os'];
const CAT_B = [
  'pais', 'region', 'categoria_de_equipo', 'clase_de_equipo',
  'perfil_de_privilegio', 'estado_de_cuenta', 'estado_hardware', 'tipo_de_red',
];

const PATRON_SIN_DATO = /^\s*(no disponible|desconocido|sin dato|sin informacion|n\/?a|na|null|none|unknown|-)\s*$/i;

function sinAcentos(texto) {
  return String(texto).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function aSnakeCase(nombre) {
  let s = sinAcentos(nombre).trim();
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  s = s.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2');
  s = s.replace(/[^a-zA-Z0-9]+/g, '_');
  s = s.replace(/^_+|_+$/g, '').toLowerCase();
  if (!s || CLAVES_PROHIBIDAS.has(s)) return 'columna_segura';
  return s;
}

function esVacio(val) {
  if (val === null || val === undefined) return true;
  if (typeof val === 'number' && Number.isNaN(val)) return true;
  if (typeof val === 'string' && val.trim() === '') return true;
  return false;
}

function esSinDato(val) {
  if (esVacio(val)) return true;
  return PATRON_SIN_DATO.test(sinAcentos(String(val)).toLowerCase());
}

function limpiarEspacios(val) {
  if (esVacio(val)) return null;
  const s = String(val).trim().replace(/\s+/g, ' ');
  return s === '' ? null : s;
}

function claveTxt(val) {
  const s = limpiarEspacios(val);
  return s === null ? null : sinAcentos(s).toLowerCase();
}

function familiaSo(val) {
  const v = val === null || val === undefined ? '' : String(val);
  const low = v.toLowerCase();
  if (v === ETIQUETA_SIN_DATO || low === 'nan' || low === '<na>' || low === 'unknown' || low === '') {
    return ETIQUETA_SIN_DATO;
  }
  if (v.startsWith('10.0.19') || v === 'Windows 10') return 'Windows 10';
  if (v.startsWith('10.0.22') || v.startsWith('10.0.26') || v === 'Windows 11') return 'Windows 11';
  if (v.startsWith('Windows')) return 'Windows (sin versión)';
  if (v.startsWith('macOS') || v.startsWith('26.')) return 'macOS';
  return 'Sin clasificar';
}

function rangoBanda(banda) {
  if (banda === null || banda === undefined) return [NaN, NaN];
  const b = sinAcentos(String(banda)).toLowerCase();
  if (b === 'nan' || b === '<na>' || b === sinAcentos(ETIQUETA_SIN_DATO).toLowerCase()) {
    return [NaN, NaN];
  }
  const factor = /\banos?\b/.test(b) ? 12 : 1;
  let m = b.match(/(\d+)\s*-\s*(\d+)/);
  if (m) return [parseInt(m[1], 10) * factor, parseInt(m[2], 10) * factor];
  m = b.match(/(?:>|mas de)\s*(\d+)|(\d+)\s*\+/);
  if (m) return [parseInt(m[1] || m[2], 10) * factor, Infinity];
  m = b.match(/(?:<|menos de)\s*(\d+)/);
  if (m) return [0, parseInt(m[1], 10) * factor];
  return [NaN, NaN];
}

function bandasNoEntendibles(valores) {
  const set = new Set();
  for (const v of valores) {
    if (v !== null && v !== undefined && v !== ETIQUETA_SIN_DATO && Number.isNaN(rangoBanda(v)[0])) {
      set.add(String(v));
    }
  }
  return Array.from(set).sort();
}

function parseCsvTexto(texto, sep) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const ch = texto[i];
    if (enComillas) {
      if (ch === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        campo += ch;
      }
    } else if (ch === '"') {
      enComillas = true;
    } else if (ch === sep) {
      fila.push(campo);
      campo = '';
    } else if (ch === '\r') {
      if (texto[i + 1] === '\n') i++;
      fila.push(campo);
      if (fila.some((c) => c !== '')) filas.push(fila);
      fila = [];
      campo = '';
    } else if (ch === '\n') {
      fila.push(campo);
      if (fila.some((c) => c !== '')) filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += ch;
    }
  }
  if (campo !== '' || fila.length > 0) {
    fila.push(campo);
    if (fila.some((c) => c !== '')) filas.push(fila);
  }
  return filas;
}

function matrizAObjetos(matriz, headerIdx) {
  if (!matriz || matriz.length <= headerIdx + 1) return { headers: [], rows: [] };
  if (matriz.length - headerIdx - 1 > MAX_FILAS_ARCHIVO) {
    throw new Error(`El archivo excede el límite de seguridad de ${MAX_FILAS_ARCHIVO.toLocaleString('es-MX')} filas.`);
  }
  const rawHeaders = matriz[headerIdx] || [];
  if (rawHeaders.length > MAX_COLUMNAS_ARCHIVO) {
    throw new Error(`El archivo excede el límite de seguridad de ${MAX_COLUMNAS_ARCHIVO} columnas.`);
  }
  const headers = rawHeaders.map((h, i) => {
    const k = esVacio(h) ? `unnamed_${i}` : String(h);
    return CLAVES_PROHIBIDAS.has(k) ? `unnamed_${i}` : k;
  });
  const rows = [];
  for (let r = headerIdx + 1; r < matriz.length; r++) {
    const line = matriz[r];
    if (!line || line.every((c) => esVacio(c))) continue;
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = c < line.length && line[c] !== undefined ? line[c] : null;
    }
    rows.push(obj);
  }
  return { headers, rows };
}

function leerArchivoBytes(nombreArchivo, buffer) {
  const dotIdx = nombreArchivo.lastIndexOf('.');
  const ext = dotIdx >= 0 ? nombreArchivo.slice(dotIdx).toLowerCase() : '';

  if (ext === '.xlsx' || ext === '.xls') {
    const wb = XLSX.read(new Uint8Array(buffer), {
      type: 'array',
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      cellText: false,
      sheetRows: MAX_FILAS_ARCHIVO + 10,
    });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) throw new Error('El archivo Excel no contiene hojas.');
    const ws = wb.Sheets[sheetName];
    const matriz = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

    if (matriz.length > HEADER_EXCEL) {
      const hdrTry = (matriz[HEADER_EXCEL] || []).map((c) => aSnakeCase(esVacio(c) ? '' : c));
      if (hdrTry.includes('equipo_id')) {
        return matrizAObjetos(matriz, HEADER_EXCEL);
      }
    }
    return matrizAObjetos(matriz, 0);
  }

  if (ext === '.csv' || ext === '.tsv') {
    const texto = new TextDecoder('utf-8').decode(buffer);
    const firstNewline = texto.search(/\r?\n/);
    const primeraLinea = firstNewline >= 0 ? texto.slice(0, firstNewline) : texto;
    const sep = primeraLinea.includes('\t') && !primeraLinea.includes(',')
      ? '\t'
      : (primeraLinea.includes(';') && !primeraLinea.includes(',') ? ';' : ',');
    const matriz = parseCsvTexto(texto, sep);
    return matrizAObjetos(matriz, 0);
  }

  throw new Error(`extensión no admitida: ${ext}`);
}

function normalizarColumnas(rawHeaders, rawRows) {
  const normCols = rawHeaders.map(aSnakeCase);
  if (new Set(normCols).size !== normCols.length) {
    throw new Error('Dos columnas quedaron con el mismo nombre tras normalizarlas.');
  }
  const rows = rawRows.map((row) => {
    const out = {};
    for (let i = 0; i < rawHeaders.length; i++) {
      out[normCols[i]] = row[rawHeaders[i]];
    }
    return out;
  });
  return { cols: normCols, rows };
}

function limpiarGenerico(cols, rawRows, avisos) {
  const out = rawRows.map((row) => {
    const obj = {};
    for (const c of cols) {
      const val = row[c];
      if (typeof val === 'string' || val === null || val === undefined) {
        const s = limpiarEspacios(val);
        obj[c] = s === null || esSinDato(s) ? ETIQUETA_SIN_DATO : s;
      } else if (val instanceof Date) {
        obj[c] = Number.isNaN(val.getTime()) ? ETIQUETA_SIN_DATO : val.toISOString();
      } else {
        obj[c] = val;
      }
    }
    return obj;
  });
  avisos.push('Archivo procesado con limpieza estándar (esquema flexible detectado).');
  return { cols, rows: out };
}

function parseFechaMes(val) {
  if (esVacio(val)) return null;
  if (val instanceof Date) {
    return Number.isNaN(val.getTime()) ? null : val;
  }
  if (typeof val === 'number' && Number.isFinite(val)) {
    // Serial de Excel (días desde 1899-12-30)
    const ms = Math.round((val - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = limpiarEspacios(val);
  if (s === null || esSinDato(s)) return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})(?:[-/]\d{1,2})?$/);
  if (m) {
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    if (month >= 1 && month <= 12) {
      return new Date(Date.UTC(year, month - 1, 1));
    }
  }
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    const month = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (month >= 1 && month <= 12) {
      return new Date(Date.UTC(year, month - 1, 1));
    }
  }
  return null;
}

function finDeMesUTC(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
}

function procesarEstandar(rawRows, avisos) {
  const n = rawRows.length;

  // --- Parte A ---
  const conteoEquipos = new Map();
  const filasA = new Array(n);
  let nSinEquipo = 0;

  for (let i = 0; i < n; i++) {
    const r = rawRows[i];
    const eqRaw = r.equipo_id;
    const eq = esVacio(eqRaw) ? null : String(eqRaw).trim().toUpperCase();
    if (eq !== null) conteoEquipos.set(eq, (conteoEquipos.get(eq) || 0) + 1);
    else nSinEquipo++;
    filasA[i] = { equipo_id: eq };
  }

  let nDuplicados = 0;
  for (let i = 0; i < n; i++) {
    const eq = filasA[i].equipo_id;
    filasA[i].flag_sin_equipo_id = eq === null;
    const dup = eq !== null && (conteoEquipos.get(eq) || 0) > 1;
    filasA[i].flag_equipo_id_duplicado = dup;
    if (dup) nDuplicados++;
  }
  if (nSinEquipo > 0) avisos.push(`Equipos sin EquipoID: ${nSinEquipo}`);
  if (nDuplicados > 0) avisos.push(`Filas con EquipoID repetido: ${nDuplicados}`);

  for (const c of BOOL_COLS) {
    const inesperados = new Set();
    for (let i = 0; i < n; i++) {
      const val = rawRows[i][c];
      if (esVacio(val)) {
        filasA[i][`${c}_bool`] = null;
      } else {
        const norm = sinAcentos(val).trim().toLowerCase();
        if (norm === 'si') filasA[i][`${c}_bool`] = true;
        else if (norm === 'no') filasA[i][`${c}_bool`] = false;
        else {
          inesperados.add(norm);
          filasA[i][`${c}_bool`] = null;
        }
      }
    }
    if (inesperados.size > 0) {
      avisos.push(`${c}: valores no esperados [${Array.from(inesperados).sort().join(', ')}] → quedan sin dato en ${c}_bool`);
    }
  }

  let nSoSinClasificar = 0;
  const catColsA = COLS_A.filter((c) => c !== 'equipo_id').concat(['familia_so']);

  for (let i = 0; i < n; i++) {
    const r = rawRows[i];
    const out = filasA[i];
    for (const c of COLS_A) {
      if (c === 'equipo_id') continue;
      let val = r[c];
      if (c === 'estado_de_cumplimiento' && val === 'Unknown') val = 'No evaluado';
      out[c] = val;
    }
    const fam = familiaSo(out.version_so);
    out.familia_so = fam;
    if (fam === 'Sin clasificar') nSoSinClasificar++;

    out.flag_compliant_sin_cifrar = (out.estado_de_cumplimiento === 'Compliant') && (out.estado_de_cifrado === 'Not encrypted');

    let sinDatoCount = 0;
    for (const c of catColsA) {
      if (esSinDato(out[c])) {
        out[c] = ETIQUETA_SIN_DATO;
        sinDatoCount++;
      }
    }
    out.n_campos_sin_dato = sinDatoCount;
    out.flag_sin_estado_cifrado = out.estado_de_cifrado === ETIQUETA_SIN_DATO;
  }
  if (nSoSinClasificar > 0) avisos.push(`Versiones de SO sin clasificar: ${nSoSinClasificar}`);

  // --- Parte B ---
  const filasB = new Array(n);
  const conteoUsuarios = new Map();

  for (let i = 0; i < n; i++) {
    const r = rawRows[i];
    const uRaw = r.usuario_id;
    const uStr = esVacio(uRaw) ? null : String(uRaw).trim();
    const sinUsuario = uStr === null || esSinDato(uStr) || sinAcentos(uStr).toLowerCase() === 'no asignado';
    const usuarioFinal = sinUsuario ? ETIQUETA_SIN_USUARIO : uStr;
    if (!sinUsuario) conteoUsuarios.set(usuarioFinal, (conteoUsuarios.get(usuarioFinal) || 0) + 1);
    filasB[i] = {
      usuario_id: usuarioFinal,
      flag_sin_usuario: sinUsuario,
    };
  }
  for (let i = 0; i < n; i++) {
    filasB[i].n_equipos_usuario = filasB[i].flag_sin_usuario ? 0 : (conteoUsuarios.get(filasB[i].usuario_id) || 0);
  }

  // Unificar variantes tipográficas en CAT_B
  for (const c of CAT_B) {
    const freqPorClave = new Map();
    const claves = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = limpiarEspacios(rawRows[i][c]);
      const k = claveTxt(s);
      claves[i] = { k, s };
      if (k !== null && s !== null) {
        let mapa = freqPorClave.get(k);
        if (!mapa) { mapa = new Map(); freqPorClave.set(k, mapa); }
        mapa.set(s, (mapa.get(s) || 0) + 1);
      }
    }
    const formaGanadora = new Map();
    for (const [k, mapa] of freqPorClave.entries()) {
      let mejorVal = null;
      let mejorCnt = -1;
      for (const [v, cnt] of mapa.entries()) {
        if (cnt > mejorCnt) { mejorCnt = cnt; mejorVal = v; }
      }
      formaGanadora.set(k, mejorVal);
    }
    for (let i = 0; i < n; i++) {
      const { k, s } = claves[i];
      const nueva = k !== null ? (formaGanadora.get(k) ?? s) : s;
      filasB[i][c] = (nueva === null || esSinDato(nueva)) ? ETIQUETA_SIN_DATO : nueva;
    }
  }

  // Jerarquía pais -> region e imputación
  const regionesPorPais = new Map();
  for (let i = 0; i < n; i++) {
    const p = filasB[i].pais;
    const reg = filasB[i].region;
    if (p !== ETIQUETA_SIN_DATO && reg !== ETIQUETA_SIN_DATO) {
      let mapa = regionesPorPais.get(p);
      if (!mapa) { mapa = new Map(); regionesPorPais.set(p, mapa); }
      mapa.set(reg, (mapa.get(reg) || 0) + 1);
    }
  }
  const paisesConflicto = [];
  const regionDePais = new Map();
  for (const [p, mapa] of regionesPorPais.entries()) {
    if (mapa.size > 1) {
      paisesConflicto.push(p);
    } else if (mapa.size === 1) {
      regionDePais.set(p, mapa.keys().next().value);
    }
  }
  if (paisesConflicto.length > 0) {
    avisos.push(`Países con más de una región: ${JSON.stringify(paisesConflicto)}`);
  }
  for (let i = 0; i < n; i++) {
    const p = filasB[i].pais;
    if (filasB[i].region === ETIQUETA_SIN_DATO && regionDePais.has(p)) {
      filasB[i].region = regionDePais.get(p);
      filasB[i].flag_region_imputada = true;
    } else {
      filasB[i].flag_region_imputada = false;
    }
  }

  // Antigüedad y banda_antiguedad
  const bandasAnt = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = rawRows[i];
    const s = limpiarEspacios(r.banda_antiguedad);
    const banda = (s === null || esSinDato(s)) ? ETIQUETA_SIN_DATO : s;
    filasB[i].banda_antiguedad = banda;
    bandasAnt[i] = banda;

    const origAnt = r.antiguedad_meses;
    filasB[i].antiguedad_meses = origAnt;
    let numMeses = null;
    if (!esSinDato(origAnt)) {
      const parsed = typeof origAnt === 'number' ? origAnt : Number(String(origAnt).trim());
      if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 600) {
        numMeses = parsed;
      }
    }
    filasB[i].antiguedad_meses_num = numMeses;

    const [lo, hi] = rangoBanda(banda);
    if (numMeses !== null && !Number.isNaN(lo)) {
      filasB[i].flag_banda_antiguedad_incoherente = !(numMeses >= lo && numMeses <= hi);
    } else {
      filasB[i].flag_banda_antiguedad_incoherente = false;
    }
  }
  const noEntAnt = bandasNoEntendibles(bandasAnt);
  if (noEntAnt.length > 0) avisos.push(`Bandas de antigüedad no entendibles: ${JSON.stringify(noEntAnt)}`);

  // mes_ultimo_logon y banda_recencia
  let noConvertidas = 0;
  let fechaMax = null;
  const fechasLogon = new Array(n);
  const bandasRec = new Array(n);

  for (let i = 0; i < n; i++) {
    const r = rawRows[i];
    const origLogon = r.mes_ultimo_logon;
    filasB[i].mes_ultimo_logon = origLogon;
    const fecha = parseFechaMes(origLogon);
    fechasLogon[i] = fecha;
    if (fecha !== null) {
      if (fechaMax === null || fecha.getTime() > fechaMax.getTime()) fechaMax = fecha;
    } else if (!esSinDato(origLogon)) {
      noConvertidas++;
    }
    filasB[i].mes_ultimo_logon_fecha = fecha ? fecha.toISOString() : null;

    const sRec = limpiarEspacios(r.banda_recencia);
    const bandaRec = (sRec === null || esSinDato(sRec)) ? ETIQUETA_SIN_DATO : sRec;
    filasB[i].banda_recencia = bandaRec;
    bandasRec[i] = bandaRec;
  }
  if (noConvertidas > 0) {
    avisos.push(`mes_ultimo_logon: ${noConvertidas} valores no se pudieron convertir a fecha`);
  }

  const corte = fechaMax !== null ? finDeMesUTC(fechaMax) : null;
  const MS_DIA = 86400000;
  for (let i = 0; i < n; i++) {
    const fecha = fechasLogon[i];
    const [lo, hi] = rangoBanda(bandasRec[i]);
    if (corte !== null && fecha !== null && !Number.isNaN(lo)) {
      const diasMin = Math.max(0, Math.floor((corte.getTime() - finDeMesUTC(fecha).getTime()) / MS_DIA));
      const diasMax = Math.floor((corte.getTime() - fecha.getTime()) / MS_DIA);
      filasB[i].flag_banda_recencia_incoherente = !((diasMax >= lo) && (diasMin <= hi));
    } else {
      filasB[i].flag_banda_recencia_incoherente = false;
    }
  }
  const noEntRec = bandasNoEntendibles(bandasRec);
  if (noEntRec.length > 0) avisos.push(`Bandas de recencia no entendibles: ${JSON.stringify(noEntRec)}`);

  // --- Unir A + B ---
  const equiposB = new Set();
  for (let i = 0; i < n; i++) {
    const eq = filasA[i].equipo_id;
    if (eq !== null && COLS_B.some((c) => !esSinDato(rawRows[i][c]))) {
      equiposB.add(eq);
    }
  }
  const filasFinales = new Array(n);
  for (let i = 0; i < n; i++) {
    const combinado = Object.assign({}, filasA[i], filasB[i]);
    combinado.flag_sin_datos_b = !equiposB.has(combinado.equipo_id);
    filasFinales[i] = combinado;
  }

  const columnas = filasFinales.length > 0 ? Object.keys(filasFinales[0]) : [];
  return { cols: columnas, rows: filasFinales };
}

self.onmessage = (e) => {
  const { nombre, buffer } = e.data;
  try {
    self.postMessage({ tipo: 'progreso', pct: 25, msg: 'Leyendo hojas y columnas en segundo plano…' });
    const { headers, rows } = leerArchivoBytes(nombre, buffer);
    if (!rows.length) {
      throw new Error('El archivo no contiene filas.');
    }

    self.postMessage({ tipo: 'progreso', pct: 55, msg: 'Normalizando y validando registros…' });
    const { cols, rows: normRows } = normalizarColumnas(headers, rows);
    const avisos = [];

    let resultado;
    if (cols.includes('equipo_id')) {
      const esperadas = COLS_A.concat(COLS_B);
      const nuevas = cols.filter((c) => !esperadas.includes(c) && normRows.some((r) => !esVacio(r[c])));
      if (nuevas.length > 0) {
        avisos.push(`Se eliminaron columnas no reconocidas: ${JSON.stringify(nuevas)}`);
      }
      const faltantes = esperadas.filter((c) => !cols.includes(c));
      if (faltantes.length > 0) {
        avisos.push(`Faltan columnas; se cargan como '${ETIQUETA_SIN_DATO}': ${JSON.stringify(faltantes)}`);
        for (const row of normRows) {
          for (const c of faltantes) row[c] = null;
        }
      }
      resultado = procesarEstandar(normRows, avisos);
    } else {
      resultado = limpiarGenerico(cols, normRows, avisos);
    }

    self.postMessage({ tipo: 'progreso', pct: 90, msg: 'Empaquetando datos limpios…' });
    const flags = {};
    for (const c of resultado.cols) {
      if (c.startsWith('flag_')) {
        let suma = 0;
        for (const r of resultado.rows) {
          if (r[c] === true) suma++;
        }
        flags[c] = suma;
      }
    }

    self.postMessage({
      tipo: 'listo',
      resultado: {
        ok: true,
        meta: {
          archivo_origen: nombre,
          procesado_en: new Date().toISOString(),
          filas: resultado.rows.length,
          columnas: resultado.cols,
          flags,
          avisos,
        },
        filas: resultado.rows,
      },
    });
  } catch (err) {
    self.postMessage({
      tipo: 'error',
      mensaje: err?.message || 'Error al procesar el archivo.',
    });
  }
};
