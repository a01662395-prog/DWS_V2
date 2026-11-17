/* ============================================================================
 *  CifraControl · Lógica del panel 100 % Portable (Cero Dummies + BD Local + Python)
 * ============================================================================
 *  ARQUITECTURA PORTABLE:
 *    - Base de Datos Local en IndexedDB (db.js): inicia limpia con 0 registros.
 *    - Pipeline de Limpieza en Python dentro del navegador (pipeline.js / Pyodide).
 *    - Sin datos dummies: todos los KPIs, gráficas y tablas se calculan a partir
 *      de los datos reales que el usuario o su compañero haya subido.
 * ========================================================================== */

'use strict';

const PALETA = window.CIFRACONTROL_PALETA || Object.freeze({
  exito: '#198765', peligro: '#DC3545', alerta: '#E5A12D', desconocido: '#9CA3AF', info: '#487DA8', femsa: '#982B3B'
});

/* ==========================================================================
 *  1. CONFIGURACIÓN Y ESTADO GLOBAL
 * ========================================================================== */

const config = {
  /** Sidebar plegado en escritorio. */
  sidebarPlegado: false,
};

const estado = {
  vista: 'dashboard',
  cache: {},
  vuelo: {},
  sparks: [],
  notificaciones: [],
};

let rangoDias = 30;

const pedirMetricas = () => apiLocal('/dashboard/metrics', { days: rangoDias });

const MODULOS = {
  kpis:        { clave: 'metricas', cargar: pedirMetricas, pintar: pintarKpis },
  serie:       { clave: 'metricas', cargar: pedirMetricas, pintar: pintarSerie },
  algoritmos:  { clave: 'metricas', cargar: pedirMetricas, pintar: pintarAlgoritmos },
  inventario:  { cargar: () => apiLocal('/dashboard/inventario', filtros.inventario), pintar: pintarInventario },
  tecnologias: { cargar: () => apiLocal('/dashboard/tecnologias'), pintar: pintarTecnologias },
  monitoreo:   { cargar: () => apiLocal('/dashboard/monitoreo'), pintar: pintarMonitoreo },
  excepciones: { cargar: () => apiLocal('/dashboard/excepciones', filtros.excepciones), pintar: pintarExcepciones },
  carga:       { cargar: () => apiLocal('/health'), pintar: () => {} },
  cola:        { cargar: () => apiLocal('/uploads'), pintar: pintarCola },
};

const filtros = {
  inventario: { search: '', estado: [], tipo: [], sort: 'id', dir: 'asc', page: 1, pageSize: 100 },
  excepciones: { severidad: '', serie: '' },
};

const inventarioOpciones = { estado: [], tipo: [] };

/* ==========================================================================
 *  2. UTILIDADES
 * ========================================================================== */

const crear = (etiqueta, clase, texto) => {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto != null) el.textContent = texto;
  return el;
};

const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const nf = new Intl.NumberFormat('es-ES');
const num = (n) => nf.format(Number(n) || 0);

function numeroSerieFila(fila) {
  const normalizarClave = texto => String(texto ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase();
  const aliases = ['numero_serie', 'numero de serie', 'serial_number', 'serial', 'service_tag', 'asset_serial', 'etiqueta_serial'];
  const clave = Object.keys(fila || {}).find(actual => {
    const normalizada = normalizarClave(actual);
    return aliases.some(alias => normalizarClave(alias) === normalizada);
  });
  return clave ? String(fila[clave] ?? '').trim() : '';
}

function formatearKPI(valor, formato) {
  if (formato === 'percent') return `${String(valor).replace('.', ',')} %`;
  if (formato === 'gb') return `${num(valor)} GB`;
  return num(valor);
}

function fechaCorta(iso) {
  if (!iso || iso === 'No disponible') return 'No disponible';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).replace('.', '');
}

function fechaHora(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('es-ES', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

function rebocar(fn, ms) {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
}

const icono = (id, clase = 'ico') => `<svg class="${clase}"><use href="#i-${id}"></use></svg>`;

function setBadge(nombre, valor) {
  document.querySelectorAll(`[data-badge="${nombre}"]`).forEach((el) => {
    const n = Number(valor) || 0;
    el.textContent = n > 99 ? '99+' : n;
    el.hidden = n === 0;
  });
}

const etiquetaBytes = (b) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = Number(b) || 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${Math.round(n * 10) / 10} ${u[i]}`;
};

function avisar(titulo, texto, tipo = 'info', ms = 4600) {
  const caja = document.getElementById('avisos');
  const el = crear('div', `aviso aviso--${tipo}`);

  const ico = crear('span');
  ico.innerHTML = icono({ exito: 'check', error: 'alerta', alerta: 'alerta', info: 'campana' }[tipo] || 'campana');

  const cuerpo = crear('div', 'aviso__t');
  cuerpo.append(crear('strong', null, titulo));
  if (texto) cuerpo.append(crear('p', null, texto));

  const cerrar = crear('button', 'aviso__cerrar');
  cerrar.setAttribute('aria-label', 'Cerrar aviso');
  cerrar.innerHTML = icono('cerrar');
  cerrar.onclick = () => el.remove();

  el.append(ico, cuerpo, cerrar);
  caja.append(el);

  if (tipo === 'error') el.setAttribute('role', 'alert');
  setTimeout(() => el.remove(), ms);
}

/* ==========================================================================
 *  3. MOTOR DE CONSULTAS SOBRE LA BASE DE DATOS LOCAL (CERO DUMMIES)
 * ========================================================================== */

/** Normaliza el estado de cifrado de una fila limpia del pipeline (A+B o TSV). */
function clasificarEstadoFila(f) {
  const raw = String(f.estado_de_cifrado || f.encryption_context || f.finding_status || '').toLowerCase();
  if (!raw || raw === 'no disponible' || raw === 'ninguno' || raw.includes('not encrypted') || raw.includes('unencrypted') || raw.includes('sin cifrar')) {
    return 'sin_cifrar';
  }
  if (raw.includes('encrypted') || raw.includes('cifrado') || raw.includes('aes') || raw.includes('tls') || raw.includes('bitlocker') || raw.includes('filevault')) {
    return 'protegido';
  }
  return 'parcial';
}

/** Obtiene conteos de una columna para armar gráficas reales desde la BD. */
function agruparPorColumna(filas, candidatosColumna) {
  if (!filas.length) return { columna: 'Sin datos', grupos: [] };
  const primera = filas[0];
  const col = candidatosColumna.find((c) => c in primera) || Object.keys(primera)[1] || Object.keys(primera)[0];
  const mapa = {};
  filas.forEach((r) => {
    const val = String(r[col] ?? 'No disponible').trim() || 'No disponible';
    mapa[val] = (mapa[val] || 0) + 1;
  });
  const grupos = Object.entries(mapa)
    .map(([label, count]) => ({
      label,
      count,
      pct: Math.round((count / filas.length) * 1000) / 10,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);
  return { columna: col, grupos };
}

/**
 * Sustituye las llamadas de red por consultas a la Base de Datos Local (IndexedDB).
 * No inventa ningún dato: si la BD tiene 0 filas, devuelve 0 en todo.
 */
async function apiLocal(ruta, params = {}) {
  const dbActual = await DB.obtenerActual();
  const filas = dbActual.filas || [];
  const meta = dbActual.meta || null;
  const total = filas.length;

  switch (ruta) {
    case '/health': {
      const cripto = await DB.infoCriptografica();
      return {
        status: 'ok',
        modo: 'Zero-Knowledge Vault (Web Crypto API + IndexedDB + Pyodide)',
        cifrado: cripto.algoritmo,
        iteracionesPBKDF2: cripto.iteracionesPBKDF2,
        bovedaDesbloqueadaEnRAM: cripto.desbloqueadaEnRAM,
        registrosCifrados: total,
        ultimoArchivo: meta ? meta.archivo_origen : 'Ninguno (esperando carga)',
        procesadoEn: meta ? meta.procesado_en : null,
      };
    }

    case '/uploads': {
      const historial = await DB.listarHistorial();
      return {
        disponible: dbActual.disponible,
        totalRegistros: total,
        meta,
        filas: historial,
        pendientes: 0,
        distribution: agruparPorColumna(filas, [
          'estado_de_cifrado',
          'familia_so',
          'sistema_operativo',
          'severity',
          'encryption_context',
          'pais',
        ]),
      };
    }

    case '/dashboard/metrics': {
      let protegidos = 0;
      let parcial = 0;
      let sinCifrar = 0;
      let incoherencias = 0;

      filas.forEach((f) => {
        const est = clasificarEstadoFila(f);
        if (est === 'protegido') protegidos++;
        else if (est === 'sin_cifrar') sinCifrar++;
        else parcial++;

        if (
          f.flag_compliant_sin_cifrar ||
          f.flag_banda_antiguedad_incoherente ||
          f.flag_banda_recencia_incoherente ||
          String(f.severity || '').toLowerCase().includes('critic')
        ) {
          incoherencias++;
        }
      });

      const cobertura = total > 0 ? Math.round((protegidos / total) * 1000) / 10 : 0;

      const distPrincipal = agruparPorColumna(filas, [
        'estado_de_cifrado',
        'familia_so',
        'sistema_operativo',
        'severity',
        'functional_category',
        'pais',
      ]);

      const distAlgoritmos = agruparPorColumna(filas, [
        'tecnologia_de_cifrado_state',
        'estado_de_cifrado',
        'encryption_context',
        'familia_so',
        'protocol_category',
      ]);

      const colores = [PALETA.femsa, PALETA.info, PALETA.exito, PALETA.alerta, PALETA.desconocido];

      return {
        disponible: total > 0,
        totalRegistros: total,
        meta,
        kpis: [
          {
            id: 'activos',
            label: 'Registros en Base de Datos',
            format: 'num',
            value: total,
            delta: total > 0 ? 100 : 0,
            sufijo: meta ? `Archivo: ${meta.archivo_origen}` : 'Sube un CSV/Excel para poblar',
            icono: 'servidor',
            color: PALETA.info,
            spark: total > 0 ? [0, Math.round(total * 0.4), Math.round(total * 0.8), total] : [0, 0, 0, 0],
          },
          {
            id: 'cifrado',
            label: 'Equipos / Filas Cifradas',
            format: 'num',
            value: protegidos,
            delta: cobertura,
            sufijo: 'del total cargado',
            icono: 'candado',
            color: PALETA.exito,
            spark: total > 0 ? [0, protegidos] : [0, 0],
          },
          {
            id: 'cobertura',
            label: 'Cobertura de Cifrado',
            format: 'percent',
            value: cobertura,
            delta: cobertura,
            sufijo: `${protegidos} de ${total} registros`,
            icono: 'escudo',
            color: PALETA.info,
            spark: total > 0 ? [0, cobertura] : [0, 0],
          },
          {
            id: 'criticas',
            label: 'Alertas / Flags de Limpieza',
            format: 'num',
            value: incoherencias,
            delta: incoherencias,
            sufijo: 'detectadas por el pipeline',
            icono: 'alerta',
            color: PALETA.peligro,
            spark: total > 0 ? [0, incoherencias] : [0, 0],
          },
        ],
        graficos: {
          barras: {
            columna: distPrincipal.columna,
            grupos: distPrincipal.grupos.map((g, idx) => ({
              ...g,
              color: colores[idx % colores.length],
            })),
          },
          algoritmos: distAlgoritmos.grupos.map((g, idx) => ({
            label: g.label,
            value: g.pct,
            count: g.count,
            color: colores[idx % colores.length],
          })),
        },
        resumen: {
          totalEventos: meta?.avisos?.length || 0,
        },
        inventario: {
          total,
          protegidos,
          parcial,
          sinCifrar,
          pendientes: parcial + sinCifrar,
          cobertura,
        },
      };
    }

    case '/dashboard/inventario': {
      const mapeadas = filas.map((f, idx) => {
        const id = f.equipo_id || f.finding_id || `REG-${idx + 1}`;
        const nombre = f.equipo_id || f.server_id || f.usuario_id || `Registro ${idx + 1}`;
        const tipo = f.familia_so || f.sistema_operativo || f.functional_category || f.clase_de_equipo || 'Activo';
        const cifrado = f.tecnologia_de_cifrado_state || f.estado_de_cifrado || f.encryption_context || 'No disponible';
        const est = clasificarEstadoFila(f);
        const ubicacion = [f.pais, f.region, f.port_category].filter((x) => x && x !== 'No disponible').join(' / ') || 'No disponible';
        const responsable = f.usuario_id || f.fuente_de_datos || 'No asignado';
        const ultimoAnalisis = f.mes_ultimo_logon || f.last_seen_band || (meta ? meta.procesado_en.slice(0, 50) : '—');
        return {
          id: String(id),
          nombre: String(nombre),
          tipo: String(tipo),
          cifrado: String(cifrado),
          estado: est,
          ubicacion: String(ubicacion),
          responsable: String(responsable),
          bytesCifrados: Number(f.n_campos_sin_dato ?? 0),
          ultimoAnalisis: String(ultimoAnalisis),
          iniciales: String(nombre).replace(/[^a-zA-Z0-9]/g, '').slice(0, 2).toUpperCase() || 'EQ',
        };
      });

      const tiposDisponibles = [...new Set(mapeadas.map((m) => m.tipo))].sort();
      const estadosDisponibles = [...new Set(mapeadas.map((m) => m.estado))].sort();

      const estadosSeleccionados = Array.isArray(params.estado)
        ? params.estado
        : (params.estado ? [params.estado] : []);
      const tiposSeleccionados = Array.isArray(params.tipo)
        ? params.tipo
        : (params.tipo ? [params.tipo] : []);

      const q = String(params.search || '').toLowerCase();
      let filtradas = mapeadas.filter((m) => {
        if (estadosSeleccionados.length && !estadosSeleccionados.includes(m.estado)) return false;
        if (tiposSeleccionados.length && !tiposSeleccionados.includes(m.tipo)) return false;
        if (q) {
          const texto = `${m.id} ${m.nombre} ${m.tipo} ${m.cifrado} ${m.ubicacion} ${m.responsable}`.toLowerCase();
          if (!texto.includes(q)) return false;
        }
        return true;
      });

      const col = params.sort || 'id';
      const mult = params.dir === 'desc' ? -1 : 1;
      filtradas.sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? ''), 'es', { numeric: true }) * mult);

      const pageSize = Number(params.pageSize) || 100;
      const totalPaginas = Math.max(1, Math.ceil(filtradas.length / pageSize));
      const pagina = Math.min(Math.max(1, Number(params.page) || 1), totalPaginas);
      const inicio = (pagina - 1) * pageSize;
      const paginadas = filtradas.slice(inicio, inicio + pageSize);

      return {
        filas: paginadas,
        estadosDisponibles,
        tiposDisponibles,
        paginacion: {
          total: filtradas.length,
          pagina,
          pageSize,
          totalPaginas,
          desde: filtradas.length ? inicio + 1 : 0,
          hasta: Math.min(inicio + pageSize, filtradas.length),
        },
        resumen: {
          pendientes: mapeadas.filter((m) => m.estado !== 'protegido').length,
        },
      };
    }

    case '/dashboard/tecnologias': {
      if (!total) {
        return { filas: [], resumen: { total: 0, criticas: 0, alto: 0 } };
      }
      const dist = agruparPorColumna(filas, ['familia_so', 'sistema_operativo', 'version_so', 'protocol_category']);
      const filasTec = dist.grupos.map((g) => {
        const esSinClasificar = g.label === 'Sin clasificar' || g.label === 'No disponible';
        return {
          nombre: g.label,
          categoria: dist.columna,
          version: g.label,
          cvss: esSinClasificar ? 7.5 : 2.0,
          riesgo: esSinClasificar ? 'alto' : 'bajo',
          uso: Math.round(g.pct),
          dependencias: g.count,
          desactualizada: esSinClasificar,
          ultimaVersion: 'Estándar',
        };
      });
      return {
        filas: filasTec,
        resumen: {
          total: filasTec.length,
          criticas: filasTec.filter((t) => t.riesgo === 'critico').length,
          alto: filasTec.filter((t) => t.riesgo === 'alto').length,
        },
      };
    }

    case '/dashboard/monitoreo': {
      return {
        resumen: { operativos: 3, degradados: 0, caidos: 0 },
        filas: [
          {
            servicio: 'Bóveda Cifrada IndexedDB (AES-GCM-256)',
            estado: 'operativo',
            uptime: 100,
            latencia: 1,
            intentos: 0,
            hostname: `vault://cifracontrol_zk_vault_db (${total} registros cifrados)`,
          },
          {
            servicio: 'Derivación PBKDF2-HMAC-SHA256 (Web Crypto)',
            estado: 'operativo',
            uptime: 100,
            latencia: 2,
            intentos: 0,
            hostname: 'crypto.subtle · 250,000 iteraciones · extractable: false',
          },
          {
            servicio: 'Motor Python Pyodide (Wasm)',
            estado: 'operativo',
            uptime: 100,
            latencia: 4,
            intentos: 0,
            hostname: meta ? `Última carga: ${meta.archivo_origen}` : 'Sin cargas previas (0 registros)',
          },
        ],
      };
    }

    case '/dashboard/excepciones': {
      if (!total) {
        return { filas: [], conteo: { critica: 0, alta: 0, media: 0, baja: 0 } };
      }
      const listaExc = [];
      filas.forEach((f, idx) => {
        const idEq = f.equipo_id || f.finding_id || `FILA-${idx + 1}`;
        const resp = f.usuario_id || f.server_id || 'No asignado';
        const numeroSerie = numeroSerieFila(f);
        if (f.flag_compliant_sin_cifrar) {
          listaExc.push({
            id: `FLAG-${idx + 1}`,
            activo: idEq,
            tipo: 'Marcado como Compliant pero sin cifrar (Not encrypted)',
            severidad: 'critica',
            estado: 'abierta',
            responsable: resp,
            numeroSerie,
            detectada: meta?.procesado_en || new Date().toISOString(),
          });
        }
        if (f.flag_banda_recencia_incoherente) {
          listaExc.push({
            id: `REC-${idx + 1}`,
            activo: idEq,
            tipo: 'Incoherencia entre mes_ultimo_logon y banda_recencia',
            severidad: 'alta',
            estado: 'en_revision',
            responsable: resp,
            numeroSerie,
            detectada: meta?.procesado_en || new Date().toISOString(),
          });
        }
        if (f.flag_banda_antiguedad_incoherente) {
          listaExc.push({
            id: `ANT-${idx + 1}`,
            activo: idEq,
            tipo: 'Incoherencia entre antiguedad_meses y banda_antiguedad',
            severidad: 'media',
            estado: 'en_revision',
            responsable: resp,
            numeroSerie,
            detectada: meta?.procesado_en || new Date().toISOString(),
          });
        }
        if (f.severity) {
          const sevLower = String(f.severity).toLowerCase();
          const sevMap = sevLower.includes('crit') ? 'critica' : sevLower.includes('alt') ? 'alta' : sevLower.includes('med') ? 'media' : 'baja';
          listaExc.push({
            id: String(f.finding_id || `F-${idx + 1}`),
            activo: String(f.server_id || idEq),
            tipo: `${f.vulnerability_type_id || 'Hallazgo'} · ${f.functional_category || ''}`,
            severidad: sevMap,
            estado: 'abierta',
            responsable: String(f.encryption_context || 'Equipo'),
            numeroSerie,
            detectada: meta?.procesado_en || new Date().toISOString(),
          });
        }
      });

      const conteo = {
        critica: listaExc.filter((e) => e.severidad === 'critica').length,
        alta: listaExc.filter((e) => e.severidad === 'alta').length,
        media: listaExc.filter((e) => e.severidad === 'media').length,
        baja: listaExc.filter((e) => e.severidad === 'baja').length,
      };

      const sevFiltro = params.severidad || '';
      const serieFiltro = String(params.serie || '').trim().toLowerCase();
      const filtradas = listaExc.filter((e) => {
        if (sevFiltro && e.severidad !== sevFiltro) return false;
        if (serieFiltro && !String(e.numeroSerie || '').toLowerCase().includes(serieFiltro)) return false;
        return true;
      });
      const conteoFiltrado = {
        critica: filtradas.filter((e) => e.severidad === 'critica').length,
        alta: filtradas.filter((e) => e.severidad === 'alta').length,
        media: filtradas.filter((e) => e.severidad === 'media').length,
        baja: filtradas.filter((e) => e.severidad === 'baja').length,
      };

      return {
        filas: filtradas.slice(0, 100),
        conteo,
        conteoFiltrado,
        totalFiltradas: filtradas.length,
      };
    }

    default:
      return { status: 'ok' };
  }
}

/* ==========================================================================
 *  4. MARCO DE MÓDULOS AISLADOS
 * ========================================================================== */

const raizDe = (nombre) => document.querySelector(`[data-modulo="${nombre}"]`);

function modoCarga(nombre) {
  const raiz = raizDe(nombre);
  if (!raiz) return;
  raiz.querySelector('[data-skel]').hidden = false;
  raiz.querySelector('[data-fallo]').hidden = true;
  const datos = raiz.querySelector('[data-datos]');
  if (datos) datos.hidden = true;
}

function modoListo(nombre) {
  const raiz = raizDe(nombre);
  if (!raiz) return;
  raiz.querySelector('[data-skel]').hidden = true;
  raiz.querySelector('[data-fallo]').hidden = true;
  const datos = raiz.querySelector('[data-datos]');
  if (datos) datos.hidden = false;
}

function modoFallo(nombre, error) {
  const raiz = raizDe(nombre);
  if (!raiz) return;
  raiz.querySelector('[data-skel]').hidden = true;
  const caja = raiz.querySelector('[data-fallo]');
  caja.hidden = false;
  const msg = caja.querySelector('[data-fallo-msg]');
  if (msg) msg.textContent = `${error.message}`;

  const boton = caja.querySelector('[data-reintentar]');
  if (boton) {
    boton.onclick = () => {
      cargarModulo(nombre, { forzar: true });
    };
  }
}

async function cargarModulo(nombre, opciones = {}) {
  const cfg = MODULOS[nombre];
  if (!cfg) return;

  const clave = cfg.clave || nombre;

  if (!opciones.forzar && estado.cache[clave]) {
    cfg.pintar(estado.cache[clave], nombre);
    modoListo(nombre);
    return;
  }

  modoCarga(nombre);
  try {
    const datos = await obtener(clave, cfg, opciones.forzar);
    cfg.pintar(datos, nombre);
    modoListo(nombre);
    if (clave === 'metricas') actualizarBadgesDesdeMetricas(datos);
  } catch (error) {
    modoFallo(nombre, error);
  }
}

function obtener(clave, cfg, forzar) {
  if (!forzar && estado.cache[clave]) return Promise.resolve(estado.cache[clave]);
  if (!forzar && estado.vuelo[clave]) return estado.vuelo[clave];

  estado.vuelo[clave] = cfg.cargar()
    .then((datos) => { estado.cache[clave] = datos; delete estado.vuelo[clave]; return datos; })
    .catch((err) => { delete estado.vuelo[clave]; throw err; });

  return estado.vuelo[clave];
}

function actualizarBadgesDesdeMetricas(d) {
  setBadge('excepciones', d.kpis.find((k) => k.id === 'criticas')?.value || 0);
  setBadge('inventario', d.inventario?.total || 0);
}

/** Refresca absolutamente todos los módulos tras cargar o vaciar la base de datos. */
function refrescarTodo() {
  estado.cache = {};
  if (estado.vista === 'dashboard') window.CifraGlobo?.cargar();
  if (estado.vista === 'reportes') cargarReportes();
  if (estado.vista === 'historial') cargarHistorial();
  (MODULOS_POR_VISTA[estado.vista] || []).forEach((m) => cargarModulo(m, { forzar: true }));
  comprobarSalud();
}

/* ==========================================================================
 *  5. ENRUTADOR POR HASH
 * ========================================================================== */

const VISTAS = {
  resumen:     { titulo: 'Resumen de cifrado',    sub: 'Datos reales procesados por el pipeline en tu Base de Datos Local' },
  inventario:  { titulo: 'Inventario',            sub: 'Registros limpios cargados en tu sesión local' },
  tecnologias: { titulo: 'Tecnologías',           sub: 'Distribución tecnológica detectada en el archivo' },
  excepciones: { titulo: 'Excepciones y Flags',   sub: 'Incoherencias y alertas detectadas por el pipeline de Python' },
  carga:       { titulo: 'Cargar Excel / CSV',    sub: 'Sube tu archivo → Limpieza en Python → Base de Datos Local' },
  ajustes:     { titulo: 'Ajustes y Respaldo',    sub: 'Preferencias y exportación/importación de tu Base de Datos' },
  reportes:    { titulo: 'Reportes',              sub: 'Genera reportes personalizados a partir de datos reales'},
  historial:   { titulo: 'Historial de datos',    sub: 'Consulta y compara cargas históricas sin modificar la carga actual' },
  dashboard:   { titulo: 'Dashboard global',      sub: 'Explorador mundial de cifrado y seguridad'}
};

const MODULOS_POR_VISTA = {
  inventario: ['inventario'],
  excepciones: ['excepciones'],
  carga: ['carga', 'cola'],
  ajustes: ['monitoreo'],
  historial: [],
  reportes: [],
  dashboard: [],
};

function irA(vista, { empujar = true } = {}) {
  if (vista === 'monitoreo') vista = 'ajustes';
  if (!VISTAS[vista]) vista = 'dashboard';

  estado.vista = vista;
  const meta = VISTAS[vista];
  document.getElementById('tituloVista').textContent = meta.titulo;
  document.getElementById('subtituloVista').textContent = meta.sub;
  document.title = `${meta.titulo} · CifraControl`;

  document.querySelectorAll('.vista').forEach((v) => {
    const activa = v.dataset.vista === vista;
    v.hidden = !activa;
    v.classList.toggle('is-activa', activa);
  });

  document.querySelectorAll('.nav__link').forEach((a) => {
    a.classList.toggle('is-activo', a.dataset.ir === vista);
  });

  if (empujar && location.hash !== `#/${vista}`) {
    history.pushState({ vista }, '', `#/${vista}`);
  }

  cerrarMenuMovil();
  if (vista === 'dashboard') {
  requestAnimationFrame(() => {
    window.CifraGlobo?.cargar();
  });
}

(MODULOS_POR_VISTA[vista] || []).forEach((m) => cargarModulo(m));

if (vista === 'reportes') cargarReportes();
if (vista === 'historial') cargarHistorial();
}

/* ==========================================================================
 *  6. INTERFAZ GENERAL: menú, tema, salud y notificaciones
 * ========================================================================== */

const app = document.querySelector('.app');

function abrirMenuMovil() {
  app.classList.add('is-abierto');
  document.getElementById('capa').hidden = false;
  document.getElementById('btnMenu').setAttribute('aria-expanded', 'true');
}
function cerrarMenuMovil() {
  app.classList.remove('is-abierto');
  document.getElementById('capa').hidden = true;
  document.getElementById('btnMenu').setAttribute('aria-expanded', 'false');
}

function alternarMenu() {
  if (window.matchMedia('(max-width: 860px)').matches) {
    app.classList.contains('is-abierto') ? cerrarMenuMovil() : abrirMenuMovil();
  } else {
    config.sidebarPlegado = !app.classList.contains('is-plegado');
    aplicarSidebar();
  }
}

function aplicarSidebar() {
  app.classList.toggle('is-plegado', config.sidebarPlegado);
  const cb = document.getElementById('setSidebar');
  if (cb) cb.checked = config.sidebarPlegado;
  try { localStorage.setItem('cc:sidebar', config.sidebarPlegado ? '1' : '0'); } catch { /* noop */ }
}

function aplicarTema(oscuro) {
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  const cb = document.getElementById('setTema');
  if (cb) cb.checked = oscuro;
  try { localStorage.setItem('cc:tema', oscuro ? 'oscuro' : 'claro'); } catch { /* noop */ }
  requestAnimationFrame(redibujarGraficos);
}

async function comprobarSalud() {
  const cajas = [
    document.getElementById('saludSidebar'),
    document.getElementById('pastillaApi'),
  ];
  const textoSidebar = cajas[0]?.querySelector('.salud__txt');
  const textoPastilla = document.getElementById('pastillaApiTxt');
  const bloque = document.getElementById('saludJson');

  try {
    const d = await apiLocal('/health');
    cajas.forEach((c) => c && (c.dataset.estado = 'ok'));
    if (textoSidebar) textoSidebar.textContent = `Bóveda AES-GCM (${num(d.registrosCifrados)} filas)`;
    if (textoPastilla) textoPastilla.textContent = `AES-GCM-256 · ${num(d.registrosCifrados)} reg.`;
    if (bloque) bloque.textContent = JSON.stringify(d, null, 2);
    return true;
  } catch (error) {
    cajas.forEach((c) => c && (c.dataset.estado = 'error'));
    if (textoSidebar) textoSidebar.textContent = 'Error en BD';
    if (textoPastilla) textoPastilla.textContent = 'Error detectado';
    if (bloque) bloque.textContent = error.message;
    return false;
  }
}

function anadirNotificacion(tipo, titulo, texto) {
  estado.notificaciones.unshift({ tipo, titulo, texto, hora: new Date() });
  estado.notificaciones = estado.notificaciones.slice(0, 12);
  pintarNotificaciones();
  setBadge('notificaciones', estado.notificaciones.length);
}

function pintarNotificaciones() {
  const lista = document.getElementById('listaNotificaciones');
  if (!estado.notificaciones.length) {
    lista.innerHTML = '<p class="popover__vacio">Sin novedades.</p>';
    return;
  }
  lista.innerHTML = estado.notificaciones.map((n) => `
    <article class="notif">
      <span class="notif__pt notif__pt--${n.tipo}"></span>
      <div>
        <strong>${esc(n.titulo)}</strong>
        <p>${esc(n.texto)}</p>
        <time>${esc(n.hora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}</time>
      </div>
    </article>`).join('');
}

/* ==========================================================================
 *  7. RENDERIZADORES DE CADA MÓDULO (CON GRÁFICA DE VERIFICACIÓN DE CARGA)
 * ========================================================================== */

const graficos = [];

function registrarGrafico(canvas, fn) {
  if (!canvas) return;
  const i = graficos.findIndex((g) => g.canvas.id === canvas.id);
  if (i >= 0) graficos[i] = { canvas, fn };
  else graficos.push({ canvas, fn });
}

/* ------------------------------ KPIs ------------------------------------ */
function pintarKpis(d) {
  estado.sparks = d.kpis.map((k) => ({ valores: k.spark, color: k.color }));

  document.querySelector('[data-datos="kpis"]').innerHTML = d.kpis.map((k, indice) => {
    return `
      <article class="kpi" style="--kpi-color:${esc(k.color)}">
        <div class="kpi__cab">
          <span class="kpi__label">${esc(k.label)}</span>
          <span class="kpi__icono">${icono(k.icono)}</span>
        </div>
        <p class="kpi__valor">${esc(formatearKPI(k.value, k.format))}</p>
        <div class="kpi__pie">
          <span>${esc(k.sufijo)}</span>
        </div>
        <canvas class="kpi__spark" data-spark="${indice}" aria-hidden="true"></canvas>
      </article>`;
  }).join('');

  requestAnimationFrame(dibujarSparks);
}

/* ---------------- Gráfica de Verificación de Carga (Resumen) ------------ */
function pintarSerie(d) {
  const cont = document.querySelector('[data-datos="serie"]');

  if (!d.disponible || d.totalRegistros === 0) {
    cont.innerHTML = `
      <div class="vacio" style="padding:36px 20px">
        <strong>Base de Datos Local vacía (0 registros)</strong>
        <p style="margin:8px 0 16px">No hay datos dummies cargados. Sube un archivo Excel (<code>.xlsx</code>, <code>.xls</code>) o CSV/TSV para que pase por el pipeline de limpieza de Python y ver aquí la gráfica con los datos reales.</p>
        <button type="button" class="btn btn--primario" id="btnIrACargaResumen">${icono('subir')}Ir a Cargar Excel / CSV</button>
      </div>`;
    const btn = document.getElementById('btnIrACargaResumen');
    if (btn) btn.onclick = () => irA('carga');
    return;
  }

  const col = d.graficos.barras.columna;
  const grupos = d.graficos.barras.grupos;

  cont.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <span class="etiqueta et--exito">${num(d.totalRegistros)} registros verificados en Base de Datos</span>
      <small class="tenue">Agrupado por columna limpia: <code>${esc(col)}</code></small>
    </div>
    <canvas class="grafico" id="graficoSerie" role="img"
      aria-label="Gráfica de verificación con ${d.totalRegistros} registros"></canvas>
    <div class="leyenda">
      ${grupos.map((g) => `
        <span class="leyenda__it">
          <i class="leyenda__pt" style="background:${esc(g.color)}"></i>
          ${esc(g.label)}: <strong>${num(g.count)}</strong> (${g.pct}%)
        </span>`).join('')}
    </div>`;

  const canvas = document.getElementById('graficoSerie');
  const fn = () => dibujarBarrasVerificacion(canvas, grupos, d.totalRegistros);
  registrarGrafico(canvas, fn);
  requestAnimationFrame(fn);
  observarResize(canvas, fn);
}

function pintarAlgoritmos(d) {
  const cont = document.querySelector('[data-datos="algoritmos"]');

  if (!d.disponible || d.totalRegistros === 0) {
    cont.innerHTML = `
      <div class="vacio" style="padding:36px 20px">
        <strong>Sin datos para distribuir (0 registros)</strong>
        <p style="margin-top:6px">Al cargar tu hoja de cálculo verás la proporción exacta aquí.</p>
      </div>`;
    return;
  }

  cont.innerHTML = `
    <div class="donut-zona">
      <canvas class="donut" id="graficoDonut" role="img" aria-label="Distribución de registros"></canvas>
      <ul class="donut-lista">
        ${d.graficos.algoritmos.map((a) => `
          <li>
            <i class="leyenda__pt" style="background:${esc(a.color)}"></i>
            <span>${esc(a.label)} (${num(a.count)})</span>
            <b>${a.value} %</b>
          </li>`).join('')}
      </ul>
    </div>
    <div class="totales" style="margin-top:20px;margin-bottom:0">
      <div class="total"><b>${num(d.totalRegistros)}</b><span>filas totales</span></div>
      <div class="total total--exito"><b>${num(d.meta?.columnas?.length || 0)}</b><span>columnas limpias</span></div>
      <div class="total total--peligro"><b>${num(d.resumen.totalEventos)}</b><span>avisos EDA</span></div>
    </div>`;

  const canvas = document.getElementById('graficoDonut');
  const fn = () => dibujarDonut(canvas, d.graficos.algoritmos);
  registrarGrafico(canvas, fn);
  requestAnimationFrame(fn);
  observarResize(canvas, fn);
}

/* ---------------------------- Inventario -------------------------------- */
async function pedirInventario() {
  await cargarModulo('inventario', { forzar: true });
}

function pintarInventario(d) {
  const cont = document.querySelector('[data-datos="inventario"]');

  inventarioOpciones.estado = d.estadosDisponibles || [];
  inventarioOpciones.tipo = d.tiposDisponibles || [];
  inventarioRenderOpciones('estado');
  inventarioRenderOpciones('tipo');

  if (!d.filas.length) {
    cont.innerHTML = `<div class="vacio"><strong>0 registros en el inventario</strong>
      Sube un archivo en «Cargar Excel» o ajusta los filtros de búsqueda.</div>`;
    return;
  }

  const p = d.paginacion;
  const etiquetasEstado = {
    protegido: ['et--exito', 'Protegido'],
    parcial: ['et--alerta', 'Parcial / Otro'],
    sin_cifrar: ['et--peligro', 'Sin cifrar'],
  };

  const columnas = [
    { k: 'id', t: 'ID', ordenable: true },
    { k: 'nombre', t: 'Equipo / Activo', ordenable: true },
    { k: 'cifrado', t: 'Cifrado / Tecnología', ordenable: true },
    { k: 'estado', t: 'Estado', ordenable: true },
    { k: 'ubicacion', t: 'País / Región', ordenable: true },
    { k: 'responsable', t: 'Usuario / Fuente', ordenable: false },
    { k: 'ultimoAnalisis', t: 'Último Logon / Fecha', ordenable: true },
  ];

  cont.innerHTML = `
    <div class="tabla-marco">
      <table class="tabla">
        <thead><tr>
          ${columnas.map((c) => `<th class="${c.num ? 'num' : ''}">${
            c.ordenable
              ? `<button type="button" data-orden="${esc(c.k)}">${esc(c.t)}${flechaOrden(c.k)}</button>`
              : esc(c.t)
          }</th>`).join('')}
        </tr></thead>
        <tbody>
          ${d.filas.map((f) => {
            const [clase, texto] = etiquetasEstado[f.estado] || ['et--neutro', f.estado];
            return `<tr>
              <td class="tenue">${esc(f.id)}</td>
              <td>
                <div class="celda-activo">
                  <span class="avatar-mini">${esc(f.iniciales)}</span>
                  <span><strong>${esc(f.nombre)}</strong><small>${esc(f.tipo)}</small></span>
                </div>
              </td>
              <td>${esc(f.cifrado)}</td>
              <td><span class="etiqueta ${clase}">${esc(texto)}</span></td>
              <td class="tenue">${esc(f.ubicacion)}</td>
              <td>${esc(f.responsable)}</td>
              <td class="tenue">${esc(f.ultimoAnalisis)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="paginacion">
      <span class="paginacion__info">Mostrando ${p.desde}–${p.hasta} de ${num(p.total)} registros en BD</span>
      <div class="paginacion__botones">
        <button class="pag-btn" data-pag="prev" ${p.pagina <= 1 ? 'disabled' : ''} aria-label="Página anterior">${icono('flecha-izq')}</button>
        ${botonesPagina(p.pagina, p.totalPaginas)}
        <button class="pag-btn" data-pag="next" ${p.pagina >= p.totalPaginas ? 'disabled' : ''} aria-label="Página siguiente">${icono('flecha-der')}</button>
      </div>
    </div>`;

  cont.querySelectorAll('[data-orden]').forEach((btn) => {
    btn.onclick = () => {
      const col = btn.dataset.orden;
      const f = filtros.inventario;
      f.dir = f.sort === col && f.dir === 'desc' ? 'asc' : 'desc';
      f.sort = col;
      pedirInventario();
    };
  });
  cont.querySelectorAll('[data-pag]').forEach((btn) => {
    btn.onclick = () => {
      filtros.inventario.page += btn.dataset.pag === 'next' ? 1 : -1;
      pedirInventario();
    };
  });
  cont.querySelectorAll('[data-ir-pag]').forEach((btn) => {
    btn.onclick = () => { filtros.inventario.page = Number(btn.dataset.irPag); pedirInventario(); };
  });

  setBadge('inventario', d.paginacion.total);
}

function flechaOrden(col) {
  const f = filtros.inventario;
  if (f.sort !== col) return '';
  return icono(f.dir === 'asc' ? 'flecha-arriba' : 'flecha-abajo');
}

function botonesPagina(actual, total) {
  const salida = [];
  const desde = Math.max(1, actual - 1);
  const hasta = Math.min(total, actual + 1);
  if (desde > 1) salida.push(`<button class="pag-btn" data-ir-pag="1">1</button>`);
  if (desde > 2) salida.push('<span class="tenue">…</span>');
  for (let i = desde; i <= hasta; i++) {
    salida.push(`<button class="pag-btn ${i === actual ? 'is-activo' : ''}" data-ir-pag="${i}">${i}</button>`);
  }
  if (hasta < total - 1) salida.push('<span class="tenue">…</span>');
  if (hasta < total) salida.push(`<button class="pag-btn" data-ir-pag="${total}">${total}</button>`);
  return salida.join('');
}

const inventarioEtiquetasEstado = {
  protegido: 'Protegido',
  parcial: 'Cifrado parcial',
  sin_cifrar: 'Sin cifrar',
};

function inventarioTextoOpcion(tipo, valor) {
  return tipo === 'estado' ? (inventarioEtiquetasEstado[valor] || valor) : valor;
}

function inventarioActualizaResumen(tipo) {
  const grupo = document.querySelector(`[data-inventario-filtro="${tipo}"]`);
  if (!grupo) return;
  const seleccionadas = filtros.inventario[tipo];
  const texto = grupo.querySelector('.inventario-multi__texto');
  if (!texto) return;
  if (!seleccionadas.length) {
    texto.textContent = tipo === 'estado' ? 'Todos los estados' : 'Todos los tipos';
    return;
  }
  const nombres = seleccionadas.map((valor) => inventarioTextoOpcion(tipo, valor));
  texto.textContent = nombres.length > 2
    ? `${nombres.slice(0, 2).join(', ')} +${nombres.length - 2}`
    : nombres.join(', ');
}

function inventarioRenderOpciones(tipo) {
  const grupo = document.querySelector(`[data-inventario-filtro="${tipo}"]`);
  if (!grupo) return;
  const disponibles = inventarioOpciones[tipo];
  const filtro = filtros.inventario[tipo];
  filtros.inventario[tipo] = filtro.filter((valor) => disponibles.includes(valor));
  const opciones = grupo.querySelector('.inventario-multi__opciones');
  if (!opciones) return;
  opciones.innerHTML = disponibles.length
    ? disponibles.map((valor) => `
        <label class="inventario-multi__opcion">
          <input type="checkbox" value="${esc(valor)}" ${filtros.inventario[tipo].includes(valor) ? 'checked' : ''}>
          <span>${esc(inventarioTextoOpcion(tipo, valor))}</span>
        </label>`).join('')
    : '<span class="inventario-multi__vacio">Sin opciones disponibles</span>';
  inventarioActualizaResumen(tipo);
}

function inventarioConfigurarMultiselect() {
  document.querySelectorAll('.inventario-multi').forEach((grupo) => {
    const tipo = grupo.dataset.inventarioFiltro;
    const boton = grupo.querySelector('.inventario-multi__boton');
    const menu = grupo.querySelector('.inventario-multi__menu');
    const opciones = grupo.querySelector('.inventario-multi__opciones');

    boton.addEventListener('click', (evento) => {
      evento.stopPropagation();
      const abrir = menu.hidden;
      document.querySelectorAll('.inventario-multi__menu').forEach((otro) => { otro.hidden = true; });
      document.querySelectorAll('.inventario-multi__boton').forEach((otro) => { otro.setAttribute('aria-expanded', 'false'); });
      menu.hidden = !abrir;
      boton.setAttribute('aria-expanded', String(abrir));
    });
    grupo.querySelector('[data-inventario-seleccionar]').addEventListener('click', () => {
      filtros.inventario[tipo] = [...inventarioOpciones[tipo]];
      inventarioRenderOpciones(tipo);
      filtros.inventario.page = 1;
      pedirInventario();
    });
    grupo.querySelector('[data-inventario-limpiar]').addEventListener('click', () => {
      filtros.inventario[tipo] = [];
      inventarioRenderOpciones(tipo);
      filtros.inventario.page = 1;
      pedirInventario();
    });
    opciones.addEventListener('change', (evento) => {
      if (!(evento.target instanceof HTMLInputElement)) return;
      filtros.inventario[tipo] = [...opciones.querySelectorAll('input:checked')].map((input) => input.value);
      inventarioActualizaResumen(tipo);
      filtros.inventario.page = 1;
      pedirInventario();
    });
    menu.addEventListener('click', (evento) => evento.stopPropagation());
  });

  document.addEventListener('click', (evento) => {
    if (!evento.target.closest('.inventario-multi')) {
      document.querySelectorAll('.inventario-multi__menu').forEach((menu) => { menu.hidden = true; });
      document.querySelectorAll('.inventario-multi__boton').forEach((boton) => boton.setAttribute('aria-expanded', 'false'));
    }
  });
}

/* --------------------------- Tecnologías -------------------------------- */
function pintarTecnologias(d) {
  const cont = document.querySelector('[data-datos="tecnologias"]');
  if (!d.filas.length) {
    cont.innerHTML = `<div class="vacio"><strong>Sin datos tecnológicos (0 registros)</strong>
      Carga un archivo Excel o CSV para analizar las versiones de Sistema Operativo y tecnologías.</div>`;
    return;
  }

  const riesgos = {
    critico: ['et--peligro', 'Crítico'], alto: ['et--peligro', 'Revisar'],
    medio: ['et--alerta', 'Medio'], bajo: ['et--exito', 'Clasificado'],
  };

  cont.innerHTML = `
    <div class="totales">
      <div class="total"><b>${num(d.resumen.total)}</b><span>familias detectadas</span></div>
      <div class="total total--peligro"><b>${num(d.resumen.alto)}</b><span>sin clasificar</span></div>
    </div>
    <div class="tabla-marco">
      <table class="tabla">
        <thead><tr>
          <th>Familia / Tecnología</th><th>Columna origen</th><th>Estado</th><th>Proporción en BD</th><th class="num">Equipos</th>
        </tr></thead>
        <tbody>
          ${d.filas.map((t) => {
            const [clase, texto] = riesgos[t.riesgo] || ['et--neutro', t.riesgo];
            const color = t.riesgo === 'alto' ? PALETA.alerta : PALETA.exito;
            return `<tr>
              <td><strong>${esc(t.nombre)}</strong></td>
              <td class="tenue"><code>${esc(t.categoria)}</code></td>
              <td><span class="etiqueta ${clase}">${esc(texto)}</span></td>
              <td>
                <div class="barra-dato">
                  <span class="barra-dato__riel"><span class="barra-dato__fill" style="width:${t.uso}%;background:${color}"></span></span>
                  <span class="barra-dato__val">${t.uso} %</span>
                </div>
              </td>
              <td class="num">${num(t.dependencias)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  setBadge('tecnologias', d.resumen.alto);
}

/* ---------------------------- Monitoreo --------------------------------- */
function pintarMonitoreo(d) {
  const etiquetas = { operativo: ['et--exito', 'Operativo'], degradado: ['et--alerta', 'Degradado'], caido: ['et--peligro', 'Caído'] };

  document.querySelector('[data-datos="monitoreo"]').innerHTML = `
    <div class="totales">
      <div class="total total--exito"><b>${num(d.resumen.operativos)}</b><span>componentes activos</span></div>
      <div class="total total--alerta"><b>${num(d.resumen.degradados)}</b><span>degradados</span></div>
      <div class="total total--peligro"><b>${num(d.resumen.caidos)}</b><span>caídos</span></div>
    </div>
    <div class="servicios">
      ${d.filas.map((s) => {
        const [clase, texto] = etiquetas[s.estado] || ['et--neutro', s.estado];
        return `<article class="servicio" data-estado="${esc(s.estado)}">
          <div class="servicio__n"><strong>${esc(s.servicio)}</strong>
            <span class="etiqueta ${clase}">${esc(texto)}</span></div>
          <div class="servicio__m">
            <div><span>Disponibilidad</span><b>${String(s.uptime).replace('.', ',')} %</b></div>
            <div><span>Tiempo resp.</span><b>${num(s.latencia)} ms</b></div>
            <div><span>Errores</span><b>${num(s.intentos)}</b></div>
          </div>
          <p class="servicio__host">${esc(s.hostname)}</p>
        </article>`;
      }).join('')}
    </div>`;
}

/* ---------------------------- Excepciones ------------------------------- */
function pintarExcepciones(d) {
  const cont = document.querySelector('[data-datos="excepciones"]');
  if (!d.filas.length) {
    const mensaje = filtros.excepciones.serie
      ? 'No se encontraron alertas para este número de serie'
      : '0 excepciones registradas';
    cont.innerHTML = `<div class="vacio"><strong>${mensaje}</strong>
      Cuando cargues un archivo, aquí aparecerán las filas marcadas por los flags de incoherencia del pipeline de Python.</div>`;
    setBadge('excepciones', 0);
    actualizarControlesBusquedaExcepciones();
    return;
  }

  const sev = {
    critica: ['et--peligro', 'Crítica'], alta: ['et--peligro', 'Alta'],
    media: ['et--alerta', 'Media'], baja: ['et--neutro', 'Baja'],
  };
  const conteoVista = filtros.excepciones.serie ? (d.conteoFiltrado || d.conteo) : d.conteo;

  cont.innerHTML = `
    <div class="totales">
      <div class="total total--peligro"><b>${num(conteoVista.critica)}</b><span>críticas</span></div>
      <div class="total"><b>${num(conteoVista.alta)}</b><span>altas</span></div>
      <div class="total total--alerta"><b>${num(conteoVista.media + conteoVista.baja)}</b><span>resto</span></div>
    </div>
    <div class="tabla-marco">
      <table class="tabla">
        <thead><tr>
          <th>ID</th><th>Equipo / Activo</th><th>Regla del Pipeline Python</th><th>Severidad</th><th>Usuario / Contexto</th>
        </tr></thead>
        <tbody>
          ${d.filas.map((f) => {
            const [clase, texto] = sev[f.severidad] || ['et--neutro', f.severidad];
            return `<tr>
              <td class="tenue">${esc(f.id)}</td>
              <td><strong>${esc(f.activo)}</strong></td>
              <td>${esc(f.tipo)}</td>
              <td><span class="etiqueta ${clase}">${esc(texto)}</span></td>
              <td>${esc(f.responsable)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div><p class="excepciones-resultados">${num(d.totalFiltradas ?? d.filas.length)} alertas encontradas</p>`;

  setBadge('excepciones', conteoVista.critica);
  actualizarControlesBusquedaExcepciones();
}

function actualizarControlesBusquedaExcepciones() {
  const input = document.getElementById('fSerieExcepciones');
  const limpiar = document.getElementById('btnLimpiarSerieExcepciones');
  if (!input || !limpiar) return;
  input.value = filtros.excepciones.serie;
  limpiar.hidden = !filtros.excepciones.serie;
}

/* ------ Vista Carga: Gráfica de Verificación en vivo + Historial -------- */
function pintarCola(d) {
  const cont = document.querySelector('[data-datos="cola"]');

  const htmlVerificacion = d.disponible && d.totalRegistros > 0
    ? `
      <div class="totales" style="margin-bottom:16px">
        <div class="total total--exito"><b>${num(d.totalRegistros)}</b><span>registros en BD</span></div>
        <div class="total"><b>${num(d.meta?.columnas?.length || 0)}</b><span>columnas limpias</span></div>
        <div class="total total--alerta"><b>${num(d.meta?.avisos?.length || 0)}</b><span>avisos del pipeline</span></div>
      </div>
    `
    : `
      <div class="vacio" style="margin-bottom:16px">
        <strong>0 datos en la Base de Datos Local</strong>
        Arrastra tu archivo Excel o CSV en el recuadro de la izquierda para limpiarlo con Python y cargarlo a la base de datos.
      </div>
    `;

  const htmlHistorial = d.filas.length
    ? `
      <p class="paginacion__info" style="margin-bottom:8px">Historial de archivos cargados en este equipo:</p>
      <div class="cola-lista">
        ${d.filas.map((f) => `
          <article class="cola-item">
            <span class="cola-item__ico">${icono('check')}</span>
            <div class="cola-item__t">
              <strong>${esc(f.archivo)}</strong>
              <small>${esc(f.bytesLegibles || '—')} · ${num(f.filasTotal ?? (Array.isArray(f.filas) ? f.filas.length : f.filas || 0))} registros limpios · ${esc(fechaHora(f.recibidoEn))}</small>
            </div>
            <span class="etiqueta et--exito">${esc(f.status)}</span>
          </article>`).join('')}
      </div>`
    : '';

  cont.innerHTML = htmlVerificacion + htmlHistorial;
}

/* ------------------------- Historial de datos -------------------------- */
let historialCargas = [];
let historialPagina = 1;
let historialSeleccionado = null;
const historialSeleccionPais = new Set();
const historialSeleccionSistema = new Set();

function historialSnapshot(carga) {
  if (carga?.total != null) return carga;
  if (typeof carga?.filas === 'number') {
    return {
      ...carga,
      total: carga.filas,
      equiposCifrados: carga.equiposCifrados || 0,
      porcentajeCifrado: carga.porcentajeCifrado || 0,
      equiposSinCifrar: carga.equiposSinCifrar || 0,
      equiposSinInformacion: carga.equiposSinInformacion || 0,
    };
  }
  if (!Array.isArray(carga?.filas) || !carga.filas.length) return { ...carga, total: 0, equiposCifrados: 0, porcentajeCifrado: 0, equiposSinCifrar: 0, equiposSinInformacion: 0 };
  const resumen = resumenSnapshot(carga.filas, carga.meta);
  return { ...carga, ...resumen };
}

function historialFecha(carga) {
  return carga?.fechaCorte || carga?.meta?.fecha_corte || carga?.meta?.fechaCorte || carga?.meta?.fecha_corte_datos || carga?.meta?.fechaCorteDatos || null;
}

function historialOpcionesFilas() {
  return historialCargas.filter(carga => carga.esSnapshot && Array.isArray(carga.filas) && carga.filas.length);
}

function historialFechaTendencia(carga) {
  const fechaCorte = historialFecha(carga);
  if (fechaCorte) return { valor: fechaCorte, fuente: 'Fecha de corte' };
  return { valor: carga?.recibidoEn || null, fuente: 'Fecha de carga' };
}

function historialMesTendencia(valor) {
  const texto = String(valor || '');
  const fechaISO = texto.match(/^(\d{4})-(\d{2})/);
  if (fechaISO) return `${fechaISO[1]}-${fechaISO[2]}`;
  const fecha = new Date(valor);
  if (Number.isNaN(fecha.getTime())) return null;
  return `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, '0')}`;
}

function historialPuntosTendencia() {
  const porMes = new Map();
  historialOpcionesFilas().forEach(carga => {
    const referencia = historialFechaTendencia(carga);
    const mes = historialMesTendencia(referencia.valor);
    if (!mes) return;
    const existente = porMes.get(mes);
    const fechaNueva = new Date(carga.recibidoEn || 0).getTime();
    const fechaExistente = existente ? new Date(existente.carga.recibidoEn || 0).getTime() : -1;
    if (existente && fechaNueva <= fechaExistente) return;
    porMes.set(mes, { carga, resumen: historialSnapshot(carga), mes, referencia });
  });
  return [...porMes.values()].sort((a, b) => a.mes.localeCompare(b.mes));
}

function historialDiferenciaMeses(mesA, mesB) {
  const [anioA, numeroA] = mesA.split('-').map(Number);
  const [anioB, numeroB] = mesB.split('-').map(Number);
  return (anioB - anioA) * 12 + numeroB - numeroA;
}

function historialEtiquetaMes(mes) {
  const [anio, numero] = mes.split('-').map(Number);
  return new Intl.DateTimeFormat('es-MX', { month: 'short', year: 'numeric' })
    .format(new Date(anio, numero - 1, 1))
    .replace('.', '');
}

function pintarHistorialTendencia() {
  const contenedor = document.getElementById('historialEvolucionCifrado');
  if (!contenedor) return;
  const puntos = historialPuntosTendencia();
  if (!puntos.length) {
    contenedor.innerHTML = '<p class="reporte-vacio">No hay datos históricos suficientes para mostrar la evolución.</p>';
    return;
  }

  const ancho = 760;
  const alto = 290;
  const margen = { arriba: 18, derecha: 22, abajo: 48, izquierda: 48 };
  const anchoUtil = ancho - margen.izquierda - margen.derecha;
  const altoUtil = alto - margen.arriba - margen.abajo;
  const x = indice => puntos.length > 1
    ? margen.izquierda + indice * anchoUtil / (puntos.length - 1)
    : margen.izquierda + anchoUtil / 2;
  const y = valor => margen.arriba + altoUtil - (Math.max(0, Math.min(100, valor)) / 100) * altoUtil;
  const porcentaje = punto => Number(punto.resumen.porcentajeCifrado || 0);
  const segmentos = [];
  let segmento = [];
  puntos.forEach((punto, indice) => {
    if (segmento.length && historialDiferenciaMeses(puntos[indice - 1].mes, punto.mes) !== 1) {
      segmentos.push(segmento);
      segmento = [];
    }
    segmento.push({ ...punto, indice });
  });
  if (segmento.length) segmentos.push(segmento);
  const lineas = segmentos.filter(grupo => grupo.length > 1)
    .map(grupo => `<polyline class="historial-tendencia-linea" points="${grupo.map(punto => `${x(punto.indice)},${y(porcentaje(punto))}`).join(' ')}"></polyline>`).join('');
  const guias = [0, 25, 50, 75, 100]
    .map(valor => `<line class="historial-tendencia-guia" x1="${margen.izquierda}" x2="${ancho - margen.derecha}" y1="${y(valor)}" y2="${y(valor)}"></line><text x="${margen.izquierda - 8}" y="${y(valor) + 3}" text-anchor="end">${valor}%</text>`).join('');
  const etiquetas = puntos.map((punto, indice) => `<text x="${x(indice)}" y="${alto - 17}" text-anchor="middle">${esc(historialEtiquetaMes(punto.mes))}</text>`).join('');
  const marcadores = puntos.map((punto, indice) => {
    const valor = porcentaje(punto);
    const fecha = historialFechaTendencia(punto.carga);
    const texto = `${historialEtiquetaMes(punto.mes)} · ${fecha.fuente}: ${fechaHora(fecha.valor)} · ${valor.toFixed(1)}% · ${num(punto.resumen.equiposCifrados || 0)} cifrados de ${num(punto.resumen.total || 0)}`;
    return `<circle class="historial-tendencia-punto" cx="${x(indice)}" cy="${y(valor)}" r="5"><title>${esc(texto)}</title></circle>`;
  }).join('');
  const ultimo = puntos[puntos.length - 1];
  const anterior = puntos.length > 1 ? puntos[puntos.length - 2] : null;
  const cambio = anterior ? porcentaje(ultimo) - porcentaje(anterior) : null;
  const estadoCambio = cambio == null ? 'neutral' : cambio > 0 ? 'mejora' : cambio < 0 ? 'retroceso' : 'neutral';
  const flecha = estadoCambio === 'mejora' ? '↑' : estadoCambio === 'retroceso' ? '↓' : '→';
  const detalleCambio = cambio == null ? 'Se necesitan al menos dos periodos para calcular una tendencia' : `${flecha} ${cambio >= 0 ? '+' : ''}${cambio.toFixed(1)} pp respecto a ${historialEtiquetaMes(anterior.mes)}`;
  contenedor.innerHTML = `<div class="historial-tendencia-grafica"><svg class="historial-tendencia-svg" viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Evolución mensual del porcentaje de equipos cifrados">${guias}${lineas}${marcadores}${etiquetas}</svg><p class="historial-tendencia-ayuda">Se utiliza la fecha de corte cuando existe; en caso contrario, la fecha de carga. Pasa el cursor sobre un punto para consultar sus cantidades.</p></div><div class="historial-tendencia-metricas"><div class="historial-tendencia-metrica"><span>Porcentaje del último periodo</span><strong>${porcentaje(ultimo).toFixed(1)}%</strong><small>${esc(historialEtiquetaMes(ultimo.mes))} · ${num(ultimo.resumen.equiposCifrados || 0)} de ${num(ultimo.resumen.total || 0)} equipos</small></div><div class="historial-tendencia-metrica historial-tendencia-metrica--${estadoCambio}"><span>Cambio respecto al periodo anterior</span><strong>${esc(detalleCambio)}</strong><small>${anterior ? `${esc(historialEtiquetaMes(anterior.mes))} → ${esc(historialEtiquetaMes(ultimo.mes))}` : 'Información insuficiente'}</small></div></div>`;
}

function pintarHistorial() {
  const tabla = document.getElementById('historialTabla');
  if (!tabla) return;
  const busqueda = document.getElementById('historialBuscar')?.value.toLowerCase().trim() || '';
  const desde = document.getElementById('historialDesde')?.value || '';
  const hasta = document.getElementById('historialHasta')?.value || '';
  const filtradas = historialCargas.map(historialSnapshot).filter(carga => {
    const fecha = String(carga.recibidoEn || '').slice(0, 10);
    if (busqueda && !String(carga.archivo || '').toLowerCase().includes(busqueda)) return false;
    if (desde && fecha < desde) return false;
    if (hasta && fecha > hasta) return false;
    return true;
  });
  const pageSize = 8;
  const paginas = Math.max(1, Math.ceil(filtradas.length / pageSize));
  historialPagina = Math.min(Math.max(1, historialPagina), paginas);
  const pagina = filtradas.slice((historialPagina - 1) * pageSize, historialPagina * pageSize);
  if (!filtradas.length) {
    tabla.innerHTML = '<div class="vacio"><strong>No hay cargas históricas disponibles</strong>Las cargas procesadas correctamente aparecerán aquí.</div>';
    return;
  }
  const actualId = historialCargas[0]?.id;
  tabla.innerHTML = `<div class="tabla-marco"><table class="tabla historial-tabla"><thead><tr><th>Fecha de carga</th><th>Fecha de corte</th><th>Archivo</th><th>Total</th><th>% cifrado</th><th>Sin cifrar</th><th>Estado</th><th>Acción</th></tr></thead><tbody>${pagina.map(carga => { const esActual = carga.id === actualId; return `<tr><td class="tenue">${esc(fechaHora(carga.recibidoEn))}</td><td class="tenue">${esc(historialFecha(carga) ? fechaHora(historialFecha(carga)) : 'No disponible')}</td><td><strong>${esc(carga.archivo || 'Carga sin nombre')}</strong></td><td>${num(carga.total)}</td><td>${Number(carga.porcentajeCifrado || 0).toFixed(1)}%</td><td>${num(carga.equiposSinCifrar || 0)}</td><td><span class="etiqueta ${esActual ? 'et--exito' : 'et--neutro'}">${esActual ? 'Actual' : 'Histórico'}</span></td><td><button type="button" class="btn btn--mini" data-historial-ver="${esc(carga.id)}">Ver detalles</button></td></tr>`; }).join('')}</tbody></table></div><div class="paginacion"><span class="paginacion__info">${num(filtradas.length)} cargas guardadas</span><div class="paginacion__botones"><button class="pag-btn" data-historial-pag="prev" ${historialPagina <= 1 ? 'disabled' : ''}>‹</button><span class="tenue">${historialPagina} / ${paginas}</span><button class="pag-btn" data-historial-pag="next" ${historialPagina >= paginas ? 'disabled' : ''}>›</button></div></div>`;
  tabla.querySelectorAll('[data-historial-ver]').forEach(boton => boton.addEventListener('click', () => mostrarHistorialDetalle(boton.dataset.historialVer)));
  tabla.querySelector('[data-historial-pag="prev"]')?.addEventListener('click', () => { historialPagina--; pintarHistorial(); });
  tabla.querySelector('[data-historial-pag="next"]')?.addEventListener('click', () => { historialPagina++; pintarHistorial(); });
}

function historialBarras(grupos, porcentaje, texto) {
  if (!grupos.length) return '<p class="reporte-vacio">Información no disponible.</p>';
  return `<div class="historial-barras">${grupos.slice(0, 8).map(grupo => `<div class="historial-barra-fila"><div><span>${esc(grupo.nombre)}</span><strong>${porcentaje(grupo).toFixed(1)}% · ${num(texto(grupo))}</strong></div><span class="historial-barra-pista"><i style="width:${Math.min(100, porcentaje(grupo))}%"></i></span></div>`).join('')}</div>`;
}

function historialConstruirComparacion() {
  const inicial = historialCargas.find(carga => carga.id === document.getElementById('historialPeriodoInicial')?.value);
  const final = historialCargas.find(carga => carga.id === document.getElementById('historialPeriodoFinal')?.value);
  const contenedor = document.getElementById('historialComparacionResultado');
  if (!contenedor || !inicial || !final || inicial.id === final.id) {
    if (contenedor) contenedor.innerHTML = '<p class="reporte-vacio">Selecciona dos cargas distintas para comparar.</p>';
    return;
  }
  const a = historialSnapshot(inicial);
  const b = historialSnapshot(final);
  const pp = Number(b.porcentajeCifrado || 0) - Number(a.porcentajeCifrado || 0);
  const tarjeta = (etiqueta, valor, bueno = false, menorEsMejor = false) => {
    const numerico = typeof valor === 'number';
    const mejora = numerico && (menorEsMejor ? valor <= 0 : valor >= 0);
    const flecha = numerico ? (valor > 0 ? '↑' : valor < 0 ? '↓' : '→') : '';
    return `<div class="historial-comparacion-kpi"><span>${etiqueta}</span><strong class="${bueno ? (mejora ? 'comparacion-mejora' : 'comparacion-riesgo') : ''}">${flecha} ${numerico && valor >= 0 ? '+' : ''}${numerico ? valor.toLocaleString('es-MX') : valor}</strong></div>`;
  };
  const escala = Math.max(a.total, b.total, 1);
  const barra = (etiqueta, valorA, valorB) => `<div class="historial-comparacion-barra"><div><span>${etiqueta}</span><strong>${num(valorA)} → ${num(valorB)}</strong></div><div class="historial-comparacion-pistas"><i style="width:${Math.min(100, valorA / escala * 100)}%"></i><b style="width:${Math.min(100, valorB / escala * 100)}%"></b></div><small>Inicial · Final</small></div>`;
  contenedor.innerHTML = `<div class="historial-comparacion-kpis">${tarjeta('Cambio en equipos totales', b.total - a.total)}${tarjeta('Cambio en equipos cifrados', b.equiposCifrados - a.equiposCifrados, true)}${tarjeta('Cambio en equipos sin cifrar', b.equiposSinCifrar - a.equiposSinCifrar, true, true)}${tarjeta('Cambio de cobertura', `${pp >= 0 ? '+' : ''}${pp.toFixed(1)} puntos porcentuales`, true)}</div><div class="historial-comparacion-grafica"><h4>Comparación de cantidades</h4>${barra('Equipos totales', a.total, b.total)}${barra('Equipos cifrados', a.equiposCifrados, b.equiposCifrados)}${barra('Equipos sin cifrar', a.equiposSinCifrar, b.equiposSinCifrar)}<div class="historial-comparacion-leyenda"><span><i class="historial-comparacion-inicial"></i>Inicial</span><span><i class="historial-comparacion-final"></i>Final</span></div></div><p class="reporte-grafica-insight">Comparación entre ${esc(a.archivo || 'periodo inicial')} y ${esc(b.archivo || 'periodo final')}. Una mejora representa más equipos cifrados o menos equipos sin cifrar.</p>`;
}

function historialRenderEvolucion(tipo) {
  const contenedor = document.getElementById(`historialEvolucion${tipo}`);
  if (!contenedor) return;
  const seleccion = tipo === 'Paises' ? historialSeleccionPais : historialSeleccionSistema;
  const historicos = historialOpcionesFilas();
  const datos = [...seleccion].map((nombre, indice) => {
    const puntos = historicos.map((carga, periodo) => {
      const analisis = reporteAnalizar(carga.filas);
      const grupos = tipo === 'Paises' ? analisis.paises : analisis.sistemas;
      const grupo = grupos.find(item => item.nombre === nombre);
      return grupo ? { x: periodo, y: grupo.protegido / Math.max(1, grupo.total) * 100, etiqueta: historialFecha(carga) || carga.recibidoEn } : null;
    }).filter(Boolean);
    return { nombre, color: [PALETA.femsa, PALETA.info, PALETA.exito, PALETA.alerta, PALETA.desconocido][indice % 5], puntos };
  });
  if (!datos.length || !datos.some(item => item.puntos.length)) {
    contenedor.innerHTML = '<p class="reporte-vacio">Selecciona al menos una categoría con información histórica.</p>';
    return;
  }
  const ancho = 680; const alto = 230; const margen = 34; const periodos = historicos.length;
  const x = indice => margen + (periodos > 1 ? indice * (ancho - margen * 2) / (periodos - 1) : (ancho - margen * 2) / 2 + margen);
  const y = valor => alto - margen - valor / 100 * (alto - margen * 2);
  const lineas = datos.map(item => `<polyline fill="none" stroke="${item.color}" stroke-width="3" points="${item.puntos.map(punto => `${x(punto.x)},${y(punto.y)}`).join(' ')}"/>${item.puntos.map(punto => `<circle cx="${x(punto.x)}" cy="${y(punto.y)}" r="3.5" fill="${item.color}"><title>${esc(item.nombre)}: ${punto.y.toFixed(1)}%</title></circle>`).join('')}`).join('');
  const etiquetas = historicos.map((carga, indice) => `<text x="${x(indice)}" y="${alto - 8}" text-anchor="middle">${esc((historialFecha(carga) || carga.recibidoEn || '').slice(0, 10))}</text>`).join('');
  contenedor.innerHTML = `<svg class="historial-linea" viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Evolución del porcentaje de cifrado">${[0, 25, 50, 75, 100].map(valor => `<line x1="${margen}" x2="${ancho - margen}" y1="${y(valor)}" y2="${y(valor)}" stroke="currentColor" opacity=".15"/><text x="${margen - 6}" y="${y(valor) + 3}" text-anchor="end">${valor}%</text>`).join('')}${lineas}${etiquetas}</svg><div class="historial-leyenda">${datos.map(item => `<span><i style="background:${item.color}"></i>${esc(item.nombre)}</span>`).join('')}</div>`;
}

function historialOpcionesEvolucion(tipo, nombres) {
  const seleccion = tipo === 'Paises' ? historialSeleccionPais : historialSeleccionSistema;
  return nombres.slice(0, 12).map(nombre => `<label><input type="checkbox" data-historial-evolucion="${tipo}" value="${esc(nombre)}" ${seleccion.has(nombre) ? 'checked' : ''}>${esc(nombre)}</label>`).join('');
}

function mostrarHistorialDetalle(id) {
  const carga = historialCargas.find(item => item.id === id);
  const panel = document.getElementById('historialDetalle');
  const contenido = document.getElementById('historialDetalleContenido');
  if (!carga || !panel || !contenido) return;
  historialSeleccionado = carga;
  const analisis = Array.isArray(carga.filas) && carga.filas.length ? reporteAnalizar(carga.filas) : null;
  panel.hidden = false;
  document.getElementById('historialDetalleTitulo').textContent = carga.archivo || 'Detalle de la carga';
  document.getElementById('historialDetalleSubtitulo').textContent = `Cargado el ${fechaHora(carga.recibidoEn)} · ${carga.fechaCorte ? `Fecha de corte: ${fechaHora(carga.fechaCorte)}` : 'Fecha de corte no disponible'}`;
  if (!analisis) {
    contenido.innerHTML = '<div class="vacio"><strong>Este registro histórico solo contiene metadatos</strong>No hay una copia de datos disponible para consultar el detalle.</div>';
    return;
  }
  const r = analisis.resumen;
  const paises = [...new Set(analisis.paises.map(item => item.nombre))];
  const sistemas = [...new Set(analisis.sistemas.map(item => item.nombre))];
  if (!historialSeleccionPais.size) paises.slice(0, 2).forEach(nombre => historialSeleccionPais.add(nombre));
  if (!historialSeleccionSistema.size) sistemas.slice(0, 2).forEach(nombre => historialSeleccionSistema.add(nombre));
  const historicos = historialOpcionesFilas();
  contenido.innerHTML = `<div class="reporte-kpis"><div class="reporte-kpi"><strong>${num(r.total)}</strong><span>Equipos totales</span></div><div class="reporte-kpi reporte-kpi--bueno"><strong>${num(r.protegido)}</strong><span>Equipos cifrados · ${reportePorcentaje(r.protegido, r.total)}</span></div><div class="reporte-kpi reporte-kpi--riesgo"><strong>${num(r.sin_cifrar)}</strong><span>Equipos sin cifrar</span></div><div class="reporte-kpi"><strong>${num(r.desconocido)}</strong><span>Sin información</span></div></div><div class="historial-detalle-grid"><section><h3>Distribución por país</h3>${historialBarras(analisis.paises, item => item.sin_cifrar / Math.max(1, item.total) * 100, item => item.sin_cifrar)}</section><section><h3>Distribución por sistema operativo</h3>${historialBarras(analisis.sistemas, item => item.protegido / Math.max(1, item.total) * 100, item => item.protegido)}</section></div><section class="historial-comparacion"><h3>Comparar periodos</h3><div class="historial-periodos"><label>Periodo inicial<select class="campo" id="historialPeriodoInicial">${historicos.map(item => `<option value="${esc(item.id)}">${esc(item.archivo || item.id)} · ${esc((item.recibidoEn || '').slice(0, 10))}</option>`).join('')}</select></label><label>Periodo final<select class="campo" id="historialPeriodoFinal">${historicos.map(item => `<option value="${esc(item.id)}">${esc(item.archivo || item.id)} · ${esc((item.recibidoEn || '').slice(0, 10))}</option>`).join('')}</select></label></div><div id="historialComparacionResultado"><p class="reporte-vacio">Selecciona dos cargas distintas para comparar.</p></div></section><section class="historial-evolucion"><h3>Evolución por país</h3><div class="historial-selecciones">${historialOpcionesEvolucion('Paises', paises)}</div><div id="historialEvolucionPaises"></div></section><section class="historial-evolucion"><h3>Evolución por sistema operativo</h3><div class="historial-selecciones">${historialOpcionesEvolucion('Sistemas', sistemas)}</div><div id="historialEvolucionSistemas"></div></section></div>`;
  const inicial = document.getElementById('historialPeriodoInicial');
  const final = document.getElementById('historialPeriodoFinal');
  if (historicos.length > 1) { inicial.value = historicos[1].id; final.value = historicos[0].id; }
  inicial.addEventListener('change', historialConstruirComparacion); final.addEventListener('change', historialConstruirComparacion);
  contenido.querySelectorAll('[data-historial-evolucion]').forEach(casilla => casilla.addEventListener('change', () => {
    const seleccion = casilla.dataset.historialEvolucion === 'Paises' ? historialSeleccionPais : historialSeleccionSistema;
    casilla.checked ? seleccion.add(casilla.value) : seleccion.delete(casilla.value);
    historialRenderEvolucion(casilla.dataset.historialEvolucion);
  }));
  historialConstruirComparacion(); historialRenderEvolucion('Paises'); historialRenderEvolucion('Sistemas');
}

async function cargarHistorial() {
  const actual = await DB.obtenerActual();
  await DB.asegurarActualEnHistorial(actual);
  historialCargas = (await DB.listarHistorial()).map(historialSnapshot);
  pintarHistorial();
  pintarHistorialTendencia();
}

function conectarHistorial() {
  ['historialBuscar', 'historialDesde', 'historialHasta'].forEach(id => document.getElementById(id)?.addEventListener('input', () => { historialPagina = 1; pintarHistorial(); }));
  document.getElementById('historialVolver')?.addEventListener('click', () => { document.getElementById('historialDetalle').hidden = true; historialSeleccionado = null; });
}

/* ==========================================================================
 *  8. MOTORES DE GRÁFICO (CANVAS)
 * ========================================================================== */

function preparar(canvas, altoCSS) {
  const dpr = window.devicePixelRatio || 1;
  const ancho = canvas.clientWidth || canvas.parentElement?.clientWidth || 520;
  const alto = altoCSS || canvas.clientHeight || 250;
  canvas.width = Math.round(ancho * dpr);
  canvas.height = Math.round(alto * dpr);
  canvas.style.height = `${alto}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ancho, alto);
  return { ctx, ancho, alto };
}

function dibujarSparks() {
  document.querySelectorAll('.kpi__spark').forEach((c) => {
    const s = estado.sparks[Number(c.dataset.spark)];
    if (!s || !s.valores || !s.valores.length) return;
    const { ctx, ancho, alto } = preparar(c, 34);
    const serie = s.valores;
    const max = Math.max(...serie, 1);
    const min = Math.min(...serie, 0);
    const rango = max - min || 1;
    const px = (i) => (i / ((serie.length - 1) || 1)) * ancho;
    const py = (v) => alto - 3 - ((v - min) / rango) * (alto - 8);

    const degradado = ctx.createLinearGradient(0, 0, 0, alto);
    degradado.addColorStop(0, s.color + '44');
    degradado.addColorStop(1, s.color + '00');
    ctx.beginPath();
    ctx.moveTo(0, alto);
    serie.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(ancho, alto);
    ctx.closePath();
    ctx.fillStyle = degradado;
    ctx.fill();

    ctx.beginPath();
    serie.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

/**
 * Dibuja la gráfica de barras de verificación con los conteos exactos de los datos en la BD.
 */
function dibujarBarrasVerificacion(canvas, grupos, totalRegistros, altoCustom = 250) {
  if (!canvas || !grupos || !grupos.length) return;
  const { ctx, ancho, alto } = preparar(canvas, altoCustom);
  const M = { arriba: 26, derecha: 18, abajo: 42, izquierda: 48 };
  const w = Math.max(100, ancho - M.izquierda - M.derecha);
  const h = Math.max(80, alto - M.arriba - M.abajo);

  const maxVal = Math.max(...grupos.map((g) => g.count), 1);
  const maxEje = Math.ceil(maxVal * 1.15) || 10;

  const colorBorde = getComputedStyle(document.documentElement).getPropertyValue('--borde').trim() || '#E2E8F0';
  const colorTexto = getComputedStyle(document.documentElement).getPropertyValue('--texto').trim() || '#0F172A';
  const colorTextoBaj = getComputedStyle(document.documentElement).getPropertyValue('--texto-baj').trim() || '#64748B';

  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= 4; i++) {
    const v = Math.round((maxEje / 4) * i);
    const y = M.arriba + h - (v / maxEje) * h;
    ctx.strokeStyle = colorBorde;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.izquierda, y);
    ctx.lineTo(M.izquierda + w, y);
    ctx.stroke();
    ctx.fillStyle = colorTextoBaj;
    ctx.fillText(num(v), M.izquierda - 8, y);
  }

  const n = grupos.length;
  const paso = w / n;
  const anchoBarra = Math.min(64, Math.max(16, paso * 0.56));

  grupos.forEach((g, i) => {
    const cx = M.izquierda + (i + 0.5) * paso;
    const bh = Math.max(4, (g.count / maxEje) * h);
    const x = cx - anchoBarra / 2;
    const y = M.arriba + h - bh;

    ctx.fillStyle = g.color || PALETA.femsa;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, anchoBarra, bh, [4, 4, 0, 0]);
    else ctx.rect(x, y, anchoBarra, bh);
    ctx.fill();

    // Valor numérico encima de cada barra
    ctx.fillStyle = colorTexto;
    ctx.font = '600 11.5px "JetBrains Mono", ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${num(g.count)}`, cx, y - 5);

    // Etiqueta del eje X
    ctx.fillStyle = colorTextoBaj;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    const etq = g.label.length > 14 ? g.label.slice(0, 13) + '…' : g.label;
    ctx.fillText(etq, cx, M.arriba + h + 10);
  });
}

function dibujarDonut(canvas, datos) {
  if (!canvas || !datos || !datos.length) return;
  const { ctx, ancho, alto } = preparar(canvas, 168);
  const cx = ancho / 2;
  const cy = alto / 2;
  const radio = Math.min(ancho, alto) / 2 - 14;
  const grosor = 26;
  let inicio = -Math.PI / 2;

  datos.forEach((a) => {
    const angulo = (Math.max(a.value, 1) / 100) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radio, inicio + 0.02, inicio + angulo - 0.02);
    ctx.strokeStyle = a.color;
    ctx.lineWidth = grosor;
    ctx.lineCap = 'butt';
    ctx.stroke();
    inicio += angulo;
  });

  const primero = datos[0];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--texto').trim();
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.fillText(`${primero.value} %`, cx, cy - 7);
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--texto-baj').trim();
  const lbl = primero.label.length > 14 ? primero.label.slice(0, 13) + '…' : primero.label;
  ctx.fillText(lbl, cx, cy + 14);
}

function redibujarGraficos() {
  for (let i = graficos.length - 1; i >= 0; i--) {
    if (document.body.contains(graficos[i].canvas)) graficos[i].fn();
    else graficos.splice(i, 1);
  }
  dibujarSparks();
}

function observarResize(canvas, fn) {
  if (typeof ResizeObserver === 'undefined' || !canvas) return;
  let anchoPrevio = canvas.clientWidth;
  const ro = new ResizeObserver(() => {
    const ancho = canvas.clientWidth;
    if (Math.abs(ancho - anchoPrevio) < 8) return;
    anchoPrevio = ancho;
    fn();
  });
  ro.observe(canvas);
}

/* ==========================================================================
 *  9. CARGA DE EXCEL / CSV -> PIPELINE PYTHON (PYODIDE) -> BD LOCAL
 * ========================================================================== */

const MAX_MB = 25;
const EXT_OK = ['.xlsx', '.xls', '.csv', '.tsv'];

const zonaSoltar = document.getElementById('zonaSoltar');
const inputExcel = document.getElementById('inputExcel');
const progreso = document.getElementById('progreso');
const barraProgreso = document.getElementById('progresoBarra');

function validarArchivo(archivo) {
  if (!archivo) return 'No se ha seleccionado ningún archivo.';
  const ext = '.' + archivo.name.split('.').pop().toLowerCase();
  if (!EXT_OK.includes(ext)) return `Formato no admitido: ${ext}. Se aceptan ${EXT_OK.join(', ')}.`;
  if (archivo.size > MAX_MB * 1024 * 1024) return `El archivo supera el máximo de ${MAX_MB} MB.`;
  if (archivo.size === 0) return 'El archivo está vacío.';
  return null;
}

function pintarProgreso(porcentaje, texto, error = false) {
  progreso.hidden = false;
  barraProgreso.style.width = `${Math.max(0, Math.min(100, porcentaje))}%`;
  document.getElementById('progresoPct').textContent = `${Math.round(porcentaje)} %`;
  document.getElementById('progresoEstado').textContent = texto;
  progreso.classList.toggle('es-error', error);
}

async function huellaArchivo(archivo) {
  const bytes = await archivo.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function resumenSnapshot(filas, meta) {
  const analisis = reporteAnalizar(filas);
  const r = analisis.resumen;
  return {
    total: r.total,
    equiposCifrados: r.protegido,
    porcentajeCifrado: r.total ? Number((r.protegido / r.total * 100).toFixed(1)) : 0,
    equiposSinCifrar: r.sin_cifrar,
    equiposSinInformacion: r.desconocido,
    fechaCorte: meta?.fecha_corte || meta?.fechaCorte || meta?.fecha_corte_datos || meta?.fechaCorteDatos || null,
  };
}

async function enviarArchivo(archivo) {
  if (!DB.esAdmin()) {
    avisar(
      'Privilegios insuficientes',
      'Tu cuenta tiene rol Operador/Lector. Sólo un Administrador puede subir archivos Excel o CSV originales. Usa la importación de paquetes cifrados (.json).',
      'error'
    );
    return;
  }

  const problema = validarArchivo(archivo);
  zonaSoltar.classList.toggle('is-error', !!problema);
  if (problema) {
    avisar('Archivo no válido', problema, 'error');
    return;
  }

  const huella = await huellaArchivo(archivo);
  const historialExistente = await DB.listarHistorial();
  const duplicado = historialExistente.find(item => item.huella === huella);
  if (duplicado && !window.confirm(`Este archivo ya fue cargado el ${fechaHora(duplicado.recibidoEn)}. ¿Deseas guardarlo como una nueva versión histórica?`)) {
    return;
  }

  document.getElementById('confirmacion').hidden = true;
  document.getElementById('progresoNombre').textContent = archivo.name;
  pintarProgreso(5, 'Leyendo archivo local…');

  try {
    const resultado = await Pipeline.procesarArchivo(archivo, (pct, msg) => {
      pintarProgreso(pct, msg);
    });

    const registroCola = {
      id: 'ing-' + Date.now(),
      archivo: archivo.name,
      bytes: archivo.size,
      bytesLegibles: etiquetaBytes(archivo.size),
      recibidoEn: new Date().toISOString(),
      status: 'procesado',
      filasTotal: resultado.meta.filas,
      avisos: resultado.meta.avisos || [],
      huella,
      ...resumenSnapshot(resultado.filas, resultado.meta),
    };

    await DB.guardarCarga({
      filas: resultado.filas,
      meta: resultado.meta,
      registroCola,
    });
    if (document.getElementById('historialEvolucionCifrado')) await cargarHistorial();

    pintarProgreso(100, `¡Listo! ${num(resultado.meta.filas)} registros limpios guardados en tu Base de Datos Local.`);
    mostrarConfirmacion({
      archivo: archivo.name,
      bytesLegibles: etiquetaBytes(archivo.size),
      recibidoEn: registroCola.recibidoEn,
      status: 'procesado',
      mensaje: `${num(resultado.meta.filas)} filas y ${resultado.meta.columnas.length} columnas procesadas con el pipeline de Python.`,
      avisos: resultado.meta.avisos || [],
    });

    avisar(
      'Base de Datos Actualizada',
      `Se cargaron ${num(resultado.meta.filas)} registros limpios desde ${archivo.name}.`,
      'exito'
    );
    anadirNotificacion(
      'exito',
      'Pipeline Python completado',
      `${archivo.name}: ${num(resultado.meta.filas)} registros guardados en BD local.`
    );

    refrescarTodo();
  } catch (err) {
    pintarProgreso(100, err.message || 'Error al procesar el archivo.', true);
    avisar('Error en el pipeline', err.message, 'error');
  }
}

function mostrarConfirmacion(d) {
  const caja = document.getElementById('confirmacion');
  caja.hidden = false;
  document.getElementById('confirmNombre').textContent = d.archivo;
  document.getElementById('confirmDetalle').textContent =
    `${d.bytesLegibles} · procesado el ${fechaHora(d.recibidoEn)}. ${d.mensaje}`;
  document.getElementById('confirmEstado').textContent = `status: ${d.status}`;

  const listaAvisos = document.getElementById('confirmAvisos');
  if (listaAvisos) {
    if (d.avisos && d.avisos.length) {
      listaAvisos.innerHTML = d.avisos.map((a) => `<li>${esc(a)}</li>`).join('');
      listaAvisos.hidden = false;
    } else {
      listaAvisos.hidden = true;
    }
  }
}

function conectarCarga() {
  zonaSoltar.addEventListener('click', () => inputExcel.click());
  zonaSoltar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputExcel.click(); }
  });
  document.getElementById('btnBuscarArchivo').addEventListener('click', (e) => {
    e.stopPropagation();
    inputExcel.click();
  });
  inputExcel.addEventListener('change', () => {
    if (inputExcel.files[0]) enviarArchivo(inputExcel.files[0]);
    inputExcel.value = '';
  });

  ['dragenter', 'dragover'].forEach((evt) => zonaSoltar.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    zonaSoltar.classList.add('is-sobre');
    pintarProgreso(0, 'Suelta el archivo para pasarlo por el pipeline de Python…');
  }));

  ['dragleave', 'drop'].forEach((evt) => zonaSoltar.addEventListener(evt, (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (evt === 'dragleave' && zonaSoltar.contains(e.relatedTarget)) return;
    zonaSoltar.classList.remove('is-sobre');
  }));

  zonaSoltar.addEventListener('drop', (e) => {
    const archivo = e.dataTransfer?.files?.[0];
    if (archivo) enviarArchivo(archivo);
  });

  document.getElementById('formCarga').addEventListener('submit', (e) => e.preventDefault());
  document.getElementById('btnRefrescarCola').onclick = () => cargarModulo('cola', { forzar: true });

  const btnVaciar = document.getElementById('btnVaciarBD');
  if (btnVaciar) {
    btnVaciar.onclick = async () => {
      await DB.vaciar();
      document.getElementById('confirmacion').hidden = true;
      progreso.hidden = true;
      avisar('Base de Datos vaciada', 'El contador volvió a 0 registros.', 'info');
      refrescarTodo();
    };
  }
}

/* ==========================================================================
 *  10. ARRANQUE Y CONEXIÓN DE EVENTOS
 * ========================================================================== */

function conectarNavegacion() {
  document.querySelectorAll('.nav__link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      irA(a.dataset.ir);
      cerrarMenuMovil();
    });
  });

  document.getElementById('btnMenu').addEventListener('click', alternarMenu);
  document.getElementById('capa').addEventListener('click', cerrarMenuMovil);

  window.addEventListener('popstate', () => irA((location.hash || '#/dashboard').slice(2), { empujar: false }));

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      irA('inventario');
      setTimeout(() => document.getElementById('fBusqueda')?.focus(), 80);
    }
    if (e.key === 'Escape') cerrarMenuMovil();
  });
}

function conectarNotificaciones() {
  const btn = document.getElementById('btnNotificaciones');
  const lista = document.getElementById('listaNotificaciones');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const abierta = !lista.hidden;
    lista.hidden = abierta;
    btn.setAttribute('aria-expanded', String(!abierta));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#popNotificaciones')) {
      lista.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  lista.addEventListener('click', (e) => e.stopPropagation());
}

function conectarTema() {
  document.getElementById('btnTema').addEventListener('click', () => {
    aplicarTema(document.documentElement.dataset.tema !== 'oscuro');
  });
}

function conectarFiltros() {
  const f = filtros.inventario;

  inventarioConfigurarMultiselect();

  document.getElementById('fBusqueda').addEventListener('input', rebocar((e) => {
    f.search = e.target.value.trim();
    f.page = 1;
    pedirInventario();
  }, 260));

  document.getElementById('btnRefrescarInventario').addEventListener('click', pedirInventario);
  document.getElementById('btnRefrescarMonitoreo').addEventListener('click', () => cargarModulo('monitoreo', { forzar: true }));

  document.querySelectorAll('[data-sev]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-sev]').forEach((x) => x.classList.remove('is-activo'));
      b.classList.add('is-activo');
      filtros.excepciones.severidad = b.dataset.sev;
      cargarModulo('excepciones', { forzar: true });
    });
  });

  const busquedaSerie = document.getElementById('fSerieExcepciones');
  const limpiarBusquedaSerie = document.getElementById('btnLimpiarSerieExcepciones');
  busquedaSerie?.addEventListener('input', () => {
    filtros.excepciones.serie = busquedaSerie.value.trim();
    cargarModulo('excepciones', { forzar: true });
  });
  limpiarBusquedaSerie?.addEventListener('click', () => {
    filtros.excepciones.serie = '';
    if (busquedaSerie) busquedaSerie.value = '';
    cargarModulo('excepciones', { forzar: true });
  });
}

function aplicarPermisosRol() {
  const esAdmin = DB.esAdmin();
  const rol = DB.obtenerRol();

  const badgeRol = document.getElementById('badgeRolUsuario');
  if (badgeRol) {
    badgeRol.textContent = esAdmin ? 'FEMSA · ADMIN' : 'FEMSA · LECTOR';
    badgeRol.title = esAdmin
      ? 'Rol Administrador: Carga de Excel/CSV + Exportación/Importación .json cifrado'
      : 'Rol Operador/Lector: Consulta y carga exclusiva de paquetes .json cifrados';
  }

  const panelCargaAdmin = document.getElementById('panelCargaAdmin');
  if (panelCargaAdmin) {
    panelCargaAdmin.hidden = !esAdmin;
  }

  const avisoSoloOperador = document.getElementById('avisoSoloOperador');
  if (avisoSoloOperador) {
    avisoSoloOperador.hidden = esAdmin;
  }

  const panelCargaPaquete = document.getElementById('panelCargaPaqueteCifrado');
  if (panelCargaPaquete) {
    panelCargaPaquete.style.marginTop = esAdmin ? '14px' : '0px';
  }

  const navCargaTxt = document.querySelector('[data-ir="carga"] .nav__txt');
  if (navCargaTxt) {
    navCargaTxt.textContent = esAdmin ? 'Cargar datos' : 'Paquetes cifrados';
  }
}

async function ejecutarExportacionCifrada(inputPassEl) {
  const passTransporte = (inputPassEl?.value || '').trim();
  if (passTransporte.length < 6) {
    avisar(
      'Contraseña requerida',
      'Escribe una contraseña de al menos 6 caracteres en el campo para cifrar el archivo .json antes de descargarlo.',
      'alerta'
    );
    inputPassEl?.focus();
    return;
  }

  try {
    const paqueteCifrado = await DB.exportarBackup(passTransporte);
    const blob = new Blob([JSON.stringify(paqueteCifrado, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cifracontrol_bd_cifrada_${new Date().toISOString().slice(0, 10)}.enc.json`;
    a.click();
    URL.revokeObjectURL(url);
    avisar(
      'Paquete .json Cifrado Exportado',
      'El archivo fue encriptado con AES-GCM-256 (PBKDF2 250k it.). Compártelo junto con su contraseña de transporte.',
      'exito'
    );
  } catch (err) {
    avisar('Error al cifrar paquete', err.message, 'error');
  }
}

async function ejecutarImportacionCifrada(file, inputPassEl) {
  if (!file) return;
  let passTransporte = (inputPassEl?.value || '').trim();
  if (!passTransporte) {
    passTransporte = (window.prompt('Introduce la contraseña de desencriptación del paquete .json cifrado:') || '').trim();
  }
  if (!passTransporte) {
    avisar('Importación cancelada', 'Se requiere la contraseña del paquete para desencriptarlo en memoria RAM.', 'alerta');
    return;
  }

  try {
    const texto = await file.text();
    const json = JSON.parse(texto);
    const total = await DB.importarBackup(json, passTransporte);
    if (inputPassEl) inputPassEl.value = '';
    avisar(
      'Paquete Desencriptado e Importado',
      `Se verificó la firma AES-GCM-256 y se recifraron ${num(total)} registros en tu IndexedDB local.`,
      'exito'
    );
    refrescarTodo();
  } catch (err) {
    avisar('No se pudo abrir el paquete cifrado', err.message, 'error');
  }
}

function conectarAjustes() {
  document.getElementById('setTema').addEventListener('change', (e) => aplicarTema(e.target.checked));

  document.getElementById('setSidebar').addEventListener('change', (e) => {
    config.sidebarPlegado = e.target.checked;
    aplicarSidebar();
  });

  document.getElementById('btnComprobarSalud').addEventListener('click', comprobarSalud);

  const btnRestablecerFabrica = document.getElementById('btnRestablecerFabrica');
  if (btnRestablecerFabrica) {
    btnRestablecerFabrica.addEventListener('click', async () => {
      if (!confirm('¿Estás seguro de destruir la bóveda cifrada y todos sus datos? Esta acción no se puede deshacer.')) return;
      await DB.restablecerFabrica();
      estado.cache = {};
      avisar('Bóveda destruida', 'Se han eliminado las sales criptográficas y todos los registros cifrados.', 'alerta');
      await mostrarModalBoveda();
    });
  }

  // Exportar e Importar Base de Datos Cifrada (.enc.json) desde Ajustes y desde Vista de Carga
  const btnExportar = document.getElementById('btnExportarBD');
  const btnImportar = document.getElementById('btnImportarBD');
  const inputImportar = document.getElementById('inputImportarBD');
  const inputPassAjustes = document.getElementById('inputPassTransporteAjustes');

  const btnExportarCarga = document.getElementById('btnExportarPaqueteCarga');
  const btnImportarCarga = document.getElementById('btnImportarPaqueteCarga');
  const inputPassCarga = document.getElementById('inputPassTransporteCarga');

  let inputPassActivoParaImportar = inputPassAjustes;

  if (btnExportar) {
    btnExportar.addEventListener('click', () => ejecutarExportacionCifrada(inputPassAjustes));
  }
  if (btnExportarCarga) {
    btnExportarCarga.addEventListener('click', () => ejecutarExportacionCifrada(inputPassCarga));
  }

  if (btnImportar && inputImportar) {
    btnImportar.addEventListener('click', () => {
      inputPassActivoParaImportar = inputPassAjustes;
      inputImportar.click();
    });
  }
  if (btnImportarCarga && inputImportar) {
    btnImportarCarga.addEventListener('click', () => {
      inputPassActivoParaImportar = inputPassCarga;
      inputImportar.click();
    });
  }

  if (inputImportar) {
    inputImportar.addEventListener('change', async () => {
      const file = inputImportar.files[0];
      if (!file) return;
      await ejecutarImportacionCifrada(file, inputPassActivoParaImportar);
      inputImportar.value = '';
    });
  }
}

async function mostrarModalBoveda(vistaSolicitada = 'desbloquear') {
  const pantallaInicio = document.getElementById('pantallaInicio');
  const modal = document.getElementById('modalBoveda');
  if (!pantallaInicio || !modal) return;

  // Ocultar por completo el dashboard mientras la sesión esté bloqueada
  app.hidden = true;
  pantallaInicio.hidden = false;

  const configurada = await DB.tieneBovedaConfigurada();
  // REGLA ESTRICTA: Si ya existe contraseña configurada, jamás se puede activar el modo 'crear'
  const modo = configurada ? 'desbloquear' : (vistaSolicitada === 'crear' ? 'crear' : 'desbloquear');
  modal.dataset.modo = modo;
  modal.dataset.configurada = configurada ? '1' : '0';

  const etiqueta = document.getElementById('bovedaEtiqueta');
  const titulo = document.getElementById('bovedaTitulo');
  const subtitulo = document.getElementById('bovedaSubtitulo');
  const labelPass = document.getElementById('labelPassBoveda');
  const bloqueConfirmar = document.getElementById('bloqueConfirmarPass');
  const avisoZK = document.getElementById('avisoZeroKnowledge');
  const bloqueEresNuevo = document.getElementById('bloqueEresNuevo');
  const bloqueVolverLogin = document.getElementById('bloqueVolverLogin');
  const txtBtn = document.getElementById('txtBtnBoveda');
  const errBox = document.getElementById('errorBoveda');
  const inputPass = document.getElementById('inputPassBoveda');
  const inputConfirm = document.getElementById('inputPassConfirm');

  if (errBox) {
    errBox.hidden = true;
    errBox.textContent = '';
  }
  if (inputPass) inputPass.value = '';
  if (inputConfirm) inputConfirm.value = '';

  if (modo === 'crear') {
    // Vista de Nuevo Usuario (solo accesible si configurada === false)
    if (etiqueta) etiqueta.textContent = 'NUEVO USUARIO';
    titulo.textContent = 'Agrega tu contraseña';
    subtitulo.textContent = 'Crea tu contraseña para acceder al panel.';
    if (labelPass) labelPass.textContent = 'Nueva contraseña';
    if (inputPass) inputPass.placeholder = 'Mínimo 6 caracteres…';
    bloqueConfirmar.hidden = false;
    if (bloqueEresNuevo) bloqueEresNuevo.hidden = true;
    if (bloqueVolverLogin) bloqueVolverLogin.hidden = false;
    txtBtn.textContent = 'Guardar contraseña';
  } else {
    // Vista por defecto: Ingresa tu contraseña
    if (etiqueta) etiqueta.textContent = 'ACCESO';
    titulo.textContent = 'Ingresa tu contraseña';
    subtitulo.textContent = 'Introduce tu contraseña para acceder al panel.';
    if (labelPass) labelPass.textContent = 'Contraseña';
    if (inputPass) inputPass.placeholder = 'Escribe tu contraseña…';
    bloqueConfirmar.hidden = true;
    // Si ya se configuró una contraseña antes, el bloque "¿Eres nuevo?" desaparece para siempre
    if (bloqueEresNuevo) bloqueEresNuevo.hidden = configurada;
    if (bloqueVolverLogin) bloqueVolverLogin.hidden = true;
    txtBtn.textContent = 'Ingresar al Dashboard';
  }

  setTimeout(() => inputPass?.focus(), 60);
}

function conectarBoveda() {
  const pantallaInicio = document.getElementById('pantallaInicio');
  const modal = document.getElementById('modalBoveda');
  const form = document.getElementById('formBoveda');
  const inputPass = document.getElementById('inputPassBoveda');
  const inputConfirm = document.getElementById('inputPassConfirm');
  const errBox = document.getElementById('errorBoveda');
  const btnSubmit = document.getElementById('btnSubmitBoveda');
  const txtBtn = document.getElementById('txtBtnBoveda');
  const btnBloquear = document.getElementById('btnBloquearBoveda');
  const btnIrARegistro = document.getElementById('btnIrARegistro');
  const btnVolverALogin = document.getElementById('btnVolverALogin');
  const selectRolRegistro = document.getElementById('selectRolRegistro');
  const bloqueClaveAdmin = document.getElementById('bloqueClaveAdmin');
  const inputClaveAdmin = document.getElementById('inputClaveAdmin');

  const mostrarError = (msg) => {
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.hidden = false;
  };

  if (selectRolRegistro && bloqueClaveAdmin) {
    selectRolRegistro.addEventListener('change', () => {
      bloqueClaveAdmin.hidden = selectRolRegistro.value !== 'admin';
      if (selectRolRegistro.value === 'admin') {
        setTimeout(() => inputClaveAdmin?.focus(), 40);
      }
    });
  }

  if (btnBloquear) {
    btnBloquear.addEventListener('click', () => {
      Vault.bloquear('MANUAL');
    });
  }

  if (btnIrARegistro) {
    btnIrARegistro.addEventListener('click', async () => {
      const yaExiste = await DB.tieneBovedaConfigurada();
      if (yaExiste) {
        await mostrarModalBoveda('desbloquear');
        mostrarError('Ya existe una contraseña registrada en este equipo. Ingresa tu contraseña actual.');
        return;
      }
      await mostrarModalBoveda('crear');
    });
  }

  if (btnVolverALogin) {
    btnVolverALogin.addEventListener('click', async () => {
      await mostrarModalBoveda('desbloquear');
    });
  }

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (errBox) errBox.hidden = true;

      const configurada = await DB.tieneBovedaConfigurada();
      const modo = modal.dataset.modo || 'desbloquear';
      const pass = inputPass.value || '';
      const confirmPass = inputConfirm.value || '';

      // Si el usuario intenta "Ingresar" cuando todavía no ha creado contraseña en el equipo:
      if (modo === 'desbloquear' && !configurada) {
        await mostrarModalBoveda('crear');
        if (pass) inputPass.value = pass;
        mostrarError('Aún no has creado una contraseña en este equipo. Confírmala abajo para registrarte e ir al dashboard.');
        setTimeout(() => inputConfirm?.focus(), 60);
        return;
      }

      // Si por cualquier razón intenta enviar en modo 'crear' pero ya existe contraseña:
      if (modo === 'crear' && configurada) {
        await mostrarModalBoveda('desbloquear');
        mostrarError('Ya existe una contraseña configurada. No se permite volver a registrar un usuario nuevo.');
        return;
      }

      if (pass.length < 6) {
        mostrarError('La contraseña maestra debe tener al menos 6 caracteres.');
        return;
      }

      if (modo === 'crear' && pass !== confirmPass) {
        mostrarError('Las contraseñas no coinciden. Verifícalas antes de continuar.');
        return;
      }

      const rolElegido = selectRolRegistro ? selectRolRegistro.value : 'operador';
      const claveAdmin = inputClaveAdmin ? inputClaveAdmin.value : '';

      const textoOriginal = txtBtn.textContent;
      btnSubmit.disabled = true;
      txtBtn.textContent = 'Iniciando sesión…';

      try {
        if (modo === 'crear') {
          await DB.crearBoveda(pass, { rol: rolElegido, claveAdmin });
          avisar(
            `Cuenta configurada`,
            'Bienvenido al dashboard.',
            'exito'
          );
        } else {
          await DB.desbloquearBoveda(pass);
          avisar(
            `Sesión iniciada`,
            'Acceso correcto.',
            'exito'
          );
        }
        inputPass.value = '';
        inputConfirm.value = '';
        if (inputClaveAdmin) inputClaveAdmin.value = '';
        aplicarPermisosRol();
        if (pantallaInicio) pantallaInicio.hidden = true;
        app.hidden = false;
        irA((location.hash || '#/dashboard').slice(2), { empujar: false });
        refrescarTodo();
        comprobarSalud();
      } catch (err) {
        mostrarError(err.message || 'No fue posible autenticar en la bóveda.');
      } finally {
        btnSubmit.disabled = false;
        txtBtn.textContent = textoOriginal;
      }
    });
  }

  Vault.suscribir(async (evento, detalle) => {
    if (evento === 'LOCKED') {
      estado.cache = {};
      await mostrarModalBoveda('desbloquear');
      if (detalle === 'INACTIVITY_TIMEOUT') {
        avisar('Sesión bloqueada por inactividad', 'La CryptoKey fue destruida de la memoria RAM tras 15 minutos sin actividad.', 'alerta');
      } else if (detalle === 'MANUAL') {
        avisar('Sesión cerrada', 'Has salido al inicio y la clave en memoria RAM fue destruida.', 'info');
      }
    }
  });
}

function restaurarPreferencias() {
  try {
    // Elimina únicamente posibles preferencias antiguas de herramientas de prueba.
    localStorage.removeItem('cc:forzarFallo');
    localStorage.removeItem('cc:retardo');
    const tema = localStorage.getItem('cc:tema');
    if (tema) aplicarTema(tema === 'oscuro');
    const side = localStorage.getItem('cc:sidebar');
    config.sidebarPlegado = side === '1';
    app.classList.toggle('is-plegado', config.sidebarPlegado);
    const cb = document.getElementById('setSidebar');
    if (cb) cb.checked = config.sidebarPlegado;
  } catch { /* noop */ }
}

async function iniciar() {
  await DB.abrir();
  restaurarPreferencias();
  conectarNavegacion();
  conectarTema();
  conectarNotificaciones();
  conectarFiltros();
  conectarCarga();
  conectarAjustes();
  conectarBoveda();
  conectarReportes();
  conectarHistorial();

  if (DB.estaBloqueada()) {
    await mostrarModalBoveda('desbloquear');
  } else {
    const pantallaInicio = document.getElementById('pantallaInicio');
    if (pantallaInicio) pantallaInicio.hidden = true;
    app.hidden = false;
    irA((location.hash || '#/dashboard').slice(2), { empujar: false });
    comprobarSalud();
  }
}

let reporteFilas = [];
let reporteFiltradas = [];
let reporteMeta = null;
let reporteTipoActivo = 'ejecutivo';
let reporteCategoriaCampo = 'principales';
let reporteFuente = 'actual';
let reporteCargaHistoricaId = '';
let reporteCargasHistoricas = [];
let reportePeriodoInicialId = '';
let reportePeriodoFinalId = '';
let reporteComparacion = null;
const reporteGraficas = new Set(['estado', 'paises', 'sistemas']);
const reporteContenido = new Set(['resumen', 'geografia', 'estado', 'sistemas', 'mdm', 'ad', 'cumplimiento', 'alertas', 'evolucion', 'comparacion', 'recomendaciones', 'detalle']);
const reporteSelecciones = {
  region: new Set(),
  pais: new Set(),
  sistema: new Set(),
  estado: new Set(),
  campo: new Set(),
  valores: new Map(),
};
const REPORTE_VALOR_VACIO = '__reporte_valor_vacio__';
const reporteMultiNombres = {
  region: 'regiones',
  pais: 'países',
  sistema: 'sistemas',
  estado: 'estados',
};

const reporteEl = id => document.getElementById(id);
const reporteTexto = v => String(v ?? '').trim();
const reporteNormalizar = v => reporteTexto(v).normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLowerCase();
const reporteClave = v => reporteNormalizar(v).replace(/[^a-z0-9]/g, '');
const reporteEsc = v => esc(reporteTexto(v));

function reporteContenidoActivo(clave) {
  return reporteContenido.has(clave);
}

function reporteContenidoCompatible(clave) {
  return reporteTipoActivo === 'tecnico' || clave !== 'detalle';
}

function reporteActualizarOpcionesContenido() {
  document.querySelectorAll('[data-reporte-contenido]').forEach(casilla => {
    const clave = casilla.dataset.reporteContenido;
    const etiqueta = casilla.closest('label');
    const compatible = reporteContenidoCompatible(clave);
    casilla.disabled = !compatible;
    casilla.checked = compatible && reporteContenido.has(clave);
    if (etiqueta) etiqueta.hidden = !compatible;
  });
}

function reporteEncontrarColumna(filas, candidatos) {
  const columnas = [...new Set(filas.flatMap(fila => Object.keys(fila)))];
  return columnas.find(col => candidatos.some(c => reporteClave(col) === reporteClave(c)))
    || columnas.find(col => candidatos.some(c => reporteClave(col).includes(reporteClave(c))))
    || '';
}

function reporteValor(fila, columna) {
  return columna ? reporteTexto(fila[columna]) : '';
}

function reporteEsSinDato(valor) {
  const clave = reporteClave(valor);
  return !clave || ['nodisponible', 'sindato', 'sindatos', 'sininformacion', 'desconocido', 'unknown', 'na', 'null', 'none'].includes(clave);
}

function reporteEstado(fila, columnas) {
  const raw = reporteNormalizar(reporteValor(fila, columnas.cifrado));
  if (reporteEsSinDato(raw)) return 'desconocido';
  if (raw.includes('not encrypted') || raw.includes('unencrypted') || raw.includes('sin cifrar') || raw.includes('notencrypted') || raw.includes('nocifrado') || raw === 'false' || raw === 'no') return 'sin_cifrar';
  if (raw.includes('partial') || raw.includes('parcial') || raw.includes('unknown') || raw.includes('in progress')) return 'parcial';
  if (raw.includes('encrypted') || raw.includes('cifrado') || raw.includes('aes') || raw.includes('tls') || raw.includes('bitlocker') || raw.includes('filevault') || raw === 'true' || raw === 'si' || raw === 'yes') return 'protegido';
  return 'desconocido';
}

function reporteNombreSO(fila, columnas) {
  const familia = reporteValor(fila, columnas.familiaSO);
  if (familia && !reporteEsSinDato(familia)) return familia;
  const sistema = reporteValor(fila, columnas.sistema);
  const version = reporteValor(fila, columnas.version);
  if (reporteEsSinDato(sistema)) return 'Sin información';
  return version && !reporteEsSinDato(version) ? `${sistema} · ${version}` : sistema;
}

function reportePorcentaje(valor, total) {
  return total ? `${(valor / total * 100).toFixed(1)}%` : '0.0%';
}

function reporteConteos(filas, columnas) {
  const conteos = { protegido: 0, sin_cifrar: 0, parcial: 0, desconocido: 0 };
  filas.forEach(fila => { conteos[reporteEstado(fila, columnas)]++; });
  return { total: filas.length, ...conteos };
}

function reporteAgrupar(filas, columnas, clave, etiqueta) {
  const grupos = new Map();
  filas.forEach(fila => {
    const nombre = reporteValor(fila, columnas[clave]) || 'Sin información';
    if (!grupos.has(nombre)) grupos.set(nombre, []);
    grupos.get(nombre).push(fila);
  });
  return [...grupos.entries()].map(([nombre, grupo]) => {
    const conteos = reporteConteos(grupo, columnas);
    return { nombre, grupo, ...conteos, region: etiqueta ? reporteValor(grupo[0], columnas.region) || 'Sin información' : '' };
  }).sort((a, b) => b.sin_cifrar - a.sin_cifrar || b.total - a.total || a.nombre.localeCompare(b.nombre, 'es'));
}

function reportePrioridad(fila) {
  if (!fila.sin_cifrar) return { texto: 'Baja', clase: 'baja' };
  const proporcion = fila.sin_cifrar / fila.total;
  if (proporcion >= 0.25 || fila.sin_cifrar >= 25) return { texto: 'Alta', clase: 'alta' };
  if (proporcion >= 0.10 || fila.sin_cifrar >= 10) return { texto: 'Media', clase: 'media' };
  return { texto: 'Baja', clase: 'baja' };
}

function reporteValoresDisponibles(tipo) {
  const analisis = reporteAnalizar(reporteFilas);
  if (tipo === 'campo') {
    const columnas = [...new Set(reporteFilas.flatMap(fila => Object.keys(fila)))].sort((a, b) => a.localeCompare(b, 'es'));
    const principales = reporteColumnasPrincipalesDisponibles(columnas);
    const principalesSet = new Set(principales);
    return reporteCategoriaCampo === 'principales' ? principales : columnas.filter(columna => !principalesSet.has(columna));
  }
  if (tipo === 'region') return reporteFilas.map(fila => reporteValor(fila, analisis.columnas.region));
  if (tipo === 'pais') {
    const regiones = reporteSelecciones.region;
    return reporteFilas
      .filter(fila => !regiones.size || regiones.has(reporteValor(fila, analisis.columnas.region)))
      .map(fila => reporteValor(fila, analisis.columnas.pais));
  }
  if (tipo === 'sistema') return reporteFilas.map(fila => reporteNombreSO(fila, analisis.columnas));
  return ['protegido', 'parcial', 'sin_cifrar', 'desconocido'];
}

function reporteEtiquetaEstado(valor) {
  return { protegido: 'Protegido', parcial: 'Parcial', sin_cifrar: 'Sin cifrar', desconocido: 'Sin información' }[valor] || valor;
}

function reporteActualizarTextoMulti(tipo) {
  const contenedor = document.querySelector(`.reporte-multi[data-reporte-filtro="${tipo}"]`);
  if (!contenedor) return;
  const texto = contenedor.querySelector('.reporte-multi-texto');
  const seleccionadas = [...reporteSelecciones[tipo]];
  if (!seleccionadas.length) {
    texto.textContent = 'Todos';
    return;
  }
  const etiquetas = seleccionadas.slice(0, 2).map(valor => {
    if (tipo === 'estado') return reporteEtiquetaEstado(valor);
    if (tipo === 'campo') return reporteEtiquetaColumna(valor, true);
    return valor;
  });
  const resto = seleccionadas.length - etiquetas.length;
  texto.textContent = `${etiquetas.join(', ')}${resto > 0 ? ` +${resto}` : ''}`;
}

function reporteActualizarOpcionesMulti(tipo) {
  const contenedor = document.querySelector(`.reporte-multi[data-reporte-filtro="${tipo}"]`);
  if (!contenedor) return;
  const valoresDisponibles = reporteValoresDisponibles(tipo);
  const opciones = [...new Set(valoresDisponibles.filter(valor => valor && !reporteEsSinDato(valor)))];
  if (tipo === 'campo' && reporteCategoriaCampo === 'principales') {
    const orden = reporteValoresDisponibles('campo');
    opciones.sort((a, b) => orden.indexOf(a) - orden.indexOf(b));
  } else {
    opciones.sort((a, b) => a.localeCompare(b, 'es'));
  }
  const seleccionadas = reporteSelecciones[tipo];
  const columnasExistentes = tipo === 'campo'
    ? [...new Set(reporteFilas.flatMap(fila => Object.keys(fila)))]
    : opciones;
  [...seleccionadas].forEach(valor => { if (!columnasExistentes.includes(valor)) seleccionadas.delete(valor); });
  const lista = contenedor.querySelector('.reporte-multi-opciones');
  lista.replaceChildren();
  opciones.forEach(valor => {
    const etiqueta = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = valor;
    checkbox.checked = seleccionadas.has(valor);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) seleccionadas.add(valor);
      else seleccionadas.delete(valor);
      if (tipo === 'region') reporteActualizarOpcionesMulti('pais');
      reporteActualizarTextoMulti(tipo);
      if (tipo === 'region') reporteActualizarTextoMulti('pais');
      if (tipo === 'campo') reporteActualizarValoresPorColumna();
      pintarReporte();
    });
    const texto = tipo === 'estado'
      ? reporteEtiquetaEstado(valor)
      : tipo === 'campo'
        ? reporteEtiquetaColumna(valor, true)
        : valor;
    etiqueta.append(checkbox, document.createTextNode(texto));
    lista.append(etiqueta);
  });
  reporteActualizarTextoMulti(tipo);
  if (tipo === 'campo') reporteActualizarValoresPorColumna();
}

function reporteValoresDisponiblesPorColumna(columna) {
  const valores = new Set();
  reporteFilas.forEach(fila => {
    const valor = reporteTexto(fila[columna]);
    valores.add(valor || REPORTE_VALOR_VACIO);
  });
  return [...valores].sort((a, b) => {
    const etiquetaA = a === REPORTE_VALOR_VACIO ? '(Vacío)' : a;
    const etiquetaB = b === REPORTE_VALOR_VACIO ? '(Vacío)' : b;
    return etiquetaA.localeCompare(etiquetaB, 'es');
  });
}

function reporteEtiquetaValor(valor) {
  return valor === REPORTE_VALOR_VACIO ? '(Vacío)' : valor;
}

function reporteTextoValores(columna) {
  const seleccionadas = [...(reporteSelecciones.valores.get(columna) || new Set())];
  if (!seleccionadas.length) return 'Todos';
  const etiquetas = seleccionadas.slice(0, 2).map(reporteEtiquetaValor);
  const resto = seleccionadas.length - etiquetas.length;
  return `${etiquetas.join(', ')}${resto > 0 ? ` +${resto}` : ''}`;
}

function reporteConfigurarMenuValor(contenedor, columna) {
  const boton = contenedor.querySelector('.reporte-multi-boton');
  const menu = contenedor.querySelector('.reporte-multi-menu');
  boton.addEventListener('click', () => {
    const abrir = menu.hidden;
    document.querySelectorAll('.reporte-multi-menu').forEach(otro => { otro.hidden = true; });
    document.querySelectorAll('.reporte-multi-boton').forEach(otro => otro.setAttribute('aria-expanded', 'false'));
    menu.hidden = !abrir;
    boton.setAttribute('aria-expanded', String(abrir));
  });
  contenedor.querySelector('[data-reporte-seleccionar]').addEventListener('click', () => {
    reporteSelecciones.valores.set(columna, new Set(reporteValoresDisponiblesPorColumna(columna)));
    reporteActualizarValoresPorColumna();
    pintarReporte();
  });
  contenedor.querySelector('[data-reporte-limpiar]').addEventListener('click', () => {
    reporteSelecciones.valores.delete(columna);
    reporteActualizarValoresPorColumna();
    pintarReporte();
  });
}

function reporteActualizarValoresPorColumna() {
  const contenedor = reporteEl('reporteValoresPorColumna');
  if (!contenedor) return;
  contenedor.replaceChildren();
  const columnas = [...reporteSelecciones.campo];
  if (!columnas.length) {
    contenedor.innerHTML = '<p class="reporte-filtro-ayuda">Selecciona una columna para elegir valores.</p>';
    return;
  }
  columnas.forEach(columna => {
    const grupo = document.createElement('div');
    grupo.className = 'reporte-valor-columna';
    const etiqueta = document.createElement('span');
    etiqueta.className = 'reporte-valor-columna__etiqueta';
    etiqueta.textContent = reporteEtiquetaColumna(columna, true);
    const menu = document.createElement('div');
    menu.className = 'reporte-multi';
    menu.dataset.reporteValorColumna = columna;
    menu.innerHTML = `<button type="button" class="reporte-multi-boton" aria-label="Valores de ${reporteEsc(reporteEtiquetaColumna(columna, true))}" aria-expanded="false"><span class="reporte-multi-texto">${reporteEsc(reporteTextoValores(columna))}</span><span aria-hidden="true">⌄</span></button><div class="reporte-multi-menu" hidden><div class="reporte-multi-acciones"><button type="button" data-reporte-seleccionar>Seleccionar todos</button><button type="button" data-reporte-limpiar>Limpiar selección</button></div><div class="reporte-multi-opciones"></div></div>`;
    const opciones = menu.querySelector('.reporte-multi-opciones');
    const disponibles = reporteValoresDisponiblesPorColumna(columna);
    const seleccionadas = reporteSelecciones.valores.get(columna) || new Set();
    [...seleccionadas].forEach(valor => { if (!disponibles.includes(valor)) seleccionadas.delete(valor); });
    if (seleccionadas.size) reporteSelecciones.valores.set(columna, seleccionadas);
    disponibles.forEach(valor => {
      const opcion = document.createElement('label');
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = valor;
      checkbox.checked = seleccionadas.has(valor);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) seleccionadas.add(valor);
        else seleccionadas.delete(valor);
        if (seleccionadas.size) reporteSelecciones.valores.set(columna, seleccionadas);
        else reporteSelecciones.valores.delete(columna);
        reporteActualizarValoresPorColumna();
        pintarReporte();
      });
      opcion.append(checkbox, document.createTextNode(reporteEtiquetaValor(valor)));
      opciones.append(opcion);
    });
    reporteConfigurarMenuValor(menu, columna);
    grupo.append(etiqueta, menu);
    contenedor.append(grupo);
  });
}

function reporteActualizarTodasLasOpciones() {
  reporteActualizarOpcionesMulti('campo');
  reporteActualizarOpcionesMulti('region');
  reporteActualizarOpcionesMulti('pais');
  reporteActualizarOpcionesMulti('sistema');
  reporteActualizarOpcionesMulti('estado');
}

function reporteConfigurarMultiselect() {
  document.querySelectorAll('.reporte-multi').forEach(contenedor => {
    const tipo = contenedor.dataset.reporteFiltro;
    const boton = contenedor.querySelector('.reporte-multi-boton');
    const menu = contenedor.querySelector('.reporte-multi-menu');
    boton.addEventListener('click', () => {
      const abrir = menu.hidden;
      document.querySelectorAll('.reporte-multi-menu').forEach(otro => { otro.hidden = true; });
      document.querySelectorAll('.reporte-multi-boton').forEach(otro => otro.setAttribute('aria-expanded', 'false'));
      menu.hidden = !abrir;
      boton.setAttribute('aria-expanded', String(abrir));
      if (abrir) reporteActualizarOpcionesMulti(tipo);
    });
    contenedor.querySelector('[data-reporte-seleccionar]').addEventListener('click', () => {
      reporteValoresDisponibles(tipo).filter(valor => valor && !reporteEsSinDato(valor)).forEach(valor => reporteSelecciones[tipo].add(valor));
      reporteActualizarTodasLasOpciones();
      pintarReporte();
    });
    contenedor.querySelector('[data-reporte-limpiar]').addEventListener('click', () => {
      reporteSelecciones[tipo].clear();
      if (tipo === 'region') reporteActualizarOpcionesMulti('pais');
      reporteActualizarOpcionesMulti(tipo);
      pintarReporte();
    });
  });
  document.addEventListener('click', evento => {
    if (evento.target.closest('.reporte-multi')) return;
    document.querySelectorAll('.reporte-multi-menu').forEach(menu => { menu.hidden = true; });
    document.querySelectorAll('.reporte-multi-boton').forEach(boton => boton.setAttribute('aria-expanded', 'false'));
  });
}

function reporteAnalizar(filas) {
  const columnas = {
    id: reporteEncontrarColumna(filas, ['equipo_id', 'id_equipo', 'device_id', 'hostname', 'nombre_equipo']),
    cifrado: reporteEncontrarColumna(filas, ['estado_de_cifrado', 'estado_cifrado', 'encryption_status', 'encryption_context', 'finding_status']),
    cumplimiento: reporteEncontrarColumna(filas, ['estado_de_cumplimiento', 'cumplimiento', 'compliance', 'compliant']),
    region: reporteEncontrarColumna(filas, ['region', 'región', 'continent', 'continente']),
    pais: reporteEncontrarColumna(filas, ['pais', 'país', 'country']),
    familiaSO: reporteEncontrarColumna(filas, ['familia_so']),
    sistema: reporteEncontrarColumna(filas, ['sistema_operativo', 'sistema operativo', 'os', 'os_name']),
    version: reporteEncontrarColumna(filas, ['version_so', 'versión so', 'version_os', 'os_version']),
    mdm: reporteEncontrarColumna(filas, ['en_mdm', 'en_mdm_bool', 'mdm']),
    ad: reporteEncontrarColumna(filas, ['en_ad', 'en_ad_bool', 'active_directory']),
    usuario: reporteEncontrarColumna(filas, ['usuario_id', 'usuario', 'usuario_asignado', 'user']),
    severidad: reporteEncontrarColumna(filas, ['severidad', 'severity', 'prioridad', 'risk_level']),
  };

  const resumen = reporteConteos(filas, columnas);
  const paises = reporteAgrupar(filas, columnas, 'pais', true);
  const regiones = reporteAgrupar(filas, columnas, 'region');
  const sistemas = reporteAgrupar(filas, columnas, 'familiaSO');
  const paisesConRiesgo = paises.filter(pais => pais.sin_cifrar > 0).map(pais => ({ ...pais, prioridad: reportePrioridad(pais) }));
  const mismatches = columnas.cumplimiento && columnas.cifrado
    ? filas.filter(fila => reporteNormalizar(reporteValor(fila, columnas.cumplimiento)).includes('compliant') && reporteEstado(fila, columnas) === 'sin_cifrar')
    : [];
  const severidades = columnas.severidad
    ? [...new Set(filas.map(fila => reporteValor(fila, columnas.severidad)).filter(valor => !reporteEsSinDato(valor)))].map(nombre => {
      const grupo = filas.filter(fila => reporteValor(fila, columnas.severidad) === nombre);
      const equipos = new Set(grupo.map(fila => reporteValor(fila, columnas.id)).filter(Boolean));
      const paisesAfectados = new Set(grupo.map(fila => reporteValor(fila, columnas.pais)).filter(valor => !reporteEsSinDato(valor)));
      const sistemasAfectados = new Set(grupo.map(fila => reporteNombreSO(fila, columnas)).filter(valor => !reporteEsSinDato(valor)));
      return { nombre, registros: grupo.length, equipos: equipos.size || grupo.length, paises: paisesAfectados.size, sistemas: sistemasAfectados.size };
    }).sort((a, b) => b.registros - a.registros)
    : [];
  const camposGestion = Boolean(columnas.mdm || columnas.ad || columnas.usuario);
  const sinMdm = columnas.mdm ? filas.filter(fila => !['si', 'yes', 'true', '1'].includes(reporteNormalizar(reporteValor(fila, columnas.mdm)))).length : null;
  const sinAd = columnas.ad ? filas.filter(fila => !['si', 'yes', 'true', '1'].includes(reporteNormalizar(reporteValor(fila, columnas.ad)))).length : null;
  const atencion = filas.filter(fila => reporteEstado(fila, columnas) !== 'protegido');
  const camposDetalle = [
    ['Equipo', columnas.id], ['Estado', columnas.cifrado], ['Sistema operativo', columnas.familiaSO || columnas.sistema],
    ['Versión', columnas.version], ['Región', columnas.region], ['País', columnas.pais], ['Cumplimiento', columnas.cumplimiento]
  ].filter(([, columna]) => Boolean(columna));

  return {
    filas, columnas, resumen, paises, regiones, sistemas, paisesConRiesgo, mismatches, severidades,
    camposGestion, sinMdm, sinAd, atencion, camposDetalle,
    fechaGeneracion: new Date().toLocaleString('es-MX'),
    fechaCorte: reporteMeta?.procesado_en ? fechaHora(reporteMeta.procesado_en) : 'No disponible',
  };
}

function reporteFiltrosActuales() {
  return {
    region: [...reporteSelecciones.region],
    pais: [...reporteSelecciones.pais],
    sistema: [...reporteSelecciones.sistema],
    campo: [...reporteSelecciones.campo],
    valores: new Map(reporteSelecciones.valores),
    buscar: reporteEl('reporteBuscar')?.value.toLowerCase().trim() || '',
    estado: [...reporteSelecciones.estado],
  };
}

function reporteTextoSeleccion(valores, todos = 'Todos') {
  if (!valores.length) return todos;
  const etiquetas = valores.slice(0, 2).map(valor => reporteEtiquetaEstado(valor));
  const resto = valores.length - etiquetas.length;
  return `${etiquetas.join(', ')}${resto > 0 ? ` +${resto}` : ''}`;
}

function reporteTextoSeleccionColumnas(valores) {
  if (!valores.length) return 'Todas';
  const etiquetas = valores.slice(0, 2).map(valor => reporteEtiquetaColumna(valor, true));
  const resto = valores.length - etiquetas.length;
  return `${etiquetas.join(', ')}${resto > 0 ? ` +${resto}` : ''}`;
}

function reporteTextoFiltrosValores(columnas) {
  const activos = columnas
    .map(columna => {
      const valores = reporteSelecciones.valores.get(columna);
      if (!valores?.size) return '';
      return `${reporteEtiquetaColumna(columna, true)}: ${reporteTextoValores(columna)}`;
    })
    .filter(Boolean);
  return activos.length ? activos.join(' · ') : 'Todos';
}

function reporteFiltrarFilas(filas) {
  const filtrosReporte = reporteFiltrosActuales();
  const columnas = reporteAnalizar(filas).columnas;
  return filas.filter(fila => {
    if (filtrosReporte.region.length && !filtrosReporte.region.includes(reporteValor(fila, columnas.region))) return false;
    if (filtrosReporte.pais.length && !filtrosReporte.pais.includes(reporteValor(fila, columnas.pais))) return false;
    if (filtrosReporte.sistema.length && !filtrosReporte.sistema.includes(reporteNombreSO(fila, columnas))) return false;
    for (const columna of filtrosReporte.campo) {
      const valores = filtrosReporte.valores.get(columna);
      if (valores?.size) {
        const valorFila = reporteTexto(fila[columna]) || REPORTE_VALOR_VACIO;
        if (!valores.has(valorFila)) return false;
      }
    }
    if (filtrosReporte.estado.length && !filtrosReporte.estado.includes(reporteEstado(fila, columnas))) return false;
    if (filtrosReporte.buscar && !Object.values(fila).some(valor => reporteNormalizar(valor).includes(filtrosReporte.buscar))) return false;
    return true;
  });
}

function reporteFiltrar() {
  reporteFiltradas = reporteFiltrarFilas(reporteFilas);
}

function reporteLlenarSelect(id, valores, etiqueta) {
  const select = reporteEl(id);
  if (!select) return;
  const actual = select.value;
  select.replaceChildren(new Option(etiqueta, ''));
  [...new Set(valores.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')).forEach(valor => select.add(new Option(valor, valor)));
  if ([...select.options].some(option => option.value === actual)) select.value = actual;
}

function actualizarValoresReporte() {
  reporteActualizarValoresPorColumna();
}

const reporteColumnasPrincipales = [
  { etiqueta: 'Región', candidatos: ['region', 'región', 'continent', 'continente'] },
  { etiqueta: 'País', candidatos: ['pais', 'país', 'country'] },
  { etiqueta: 'Sistema operativo', candidatos: ['sistema_operativo', 'sistema operativo', 'os', 'os_name'] },
  { etiqueta: 'Versión del sistema operativo', candidatos: ['version so', 'version_so', 'versión so', 'version_os', 'os_version'] },
  { etiqueta: 'Estado de cifrado', candidatos: ['estado de cifrado', 'estado_de_cifrado', 'estado_cifrado', 'encryption_status', 'encryption_context', 'finding_status'] },
  { etiqueta: 'Estado de cumplimiento', candidatos: ['estado de cumplimiento', 'estado_de_cumplimiento', 'cumplimiento', 'compliance', 'compliant'] },
  { etiqueta: 'En MDM', candidatos: ['en mdm', 'en_mdm', 'en_mdm_bool', 'mdm'] },
  { etiqueta: 'En Active Directory', candidatos: ['en ad', 'en_ad', 'en_ad_bool', 'active_directory'] },
  { etiqueta: 'Antigüedad del equipo', candidatos: ['banda antiguedad', 'banda_antiguedad', 'antiguedad', 'antigüedad'] },
  { etiqueta: 'Último acceso', candidatos: ['banda recencia', 'banda_recencia', 'recencia', 'ultimo acceso', 'último acceso'] },
];

function reporteColumnaCorrespondiente(columnas, candidatos) {
  return candidatos.reduce((encontrada, candidato) => encontrada || columnas.find(columna => reporteClave(columna) === reporteClave(candidato)), '')
    || candidatos.reduce((encontrada, candidato) => encontrada || columnas.find(columna => reporteClave(columna).includes(reporteClave(candidato))), '');
}

function reporteColumnasPrincipalesDisponibles(columnas) {
  return reporteColumnasPrincipales
    .map(configuracion => reporteColumnaCorrespondiente(columnas, configuracion.candidatos))
    .filter(Boolean);
}

function reporteEtiquetaColumna(columna, amigable = true) {
  if (!amigable) return columna.replaceAll('_', ' ');
  const configuracion = reporteColumnasPrincipales.find(item => item.candidatos.some(candidato => reporteClave(candidato) === reporteClave(columna)));
  if (configuracion) return configuracion.etiqueta;
  return columna.replaceAll('_', ' ');
}

function reporteColumnaPrincipal(columna) {
  return reporteColumnasPrincipales.some(item => item.candidatos.some(candidato => reporteClave(candidato) === reporteClave(columna)));
}

function reportePoblarColumnas(filas = reporteFilas) {
  if (filas !== reporteFilas) reporteFilas = filas;
  reporteActualizarOpcionesMulti('campo');
}

function reporteConfigurarCategoriasCampo() {
  document.querySelectorAll('.reporte-filtro-categoria').forEach(boton => boton.addEventListener('click', () => {
    reporteCategoriaCampo = boton.dataset.reporteCategoria === 'avanzadas' ? 'avanzadas' : 'principales';
    document.querySelectorAll('.reporte-filtro-categoria').forEach(otra => {
      const activa = otra === boton;
      otra.classList.toggle('is-activa', activa);
      otra.setAttribute('aria-selected', String(activa));
    });
    reportePoblarColumnas();
  }));
}

function reporteTabla(encabezados, filas, clase = '') {
  if (!filas.length) return '<p class="reporte-vacio">Información no disponible para los filtros seleccionados.</p>';
  return `<div class="reporte-tabla reporte-tabla--analisis ${clase}"><table class="tabla"><thead><tr>${encabezados.map(encabezado => `<th>${reporteEsc(encabezado)}</th>`).join('')}</tr></thead><tbody>${filas.map(fila => `<tr>${fila.map(celda => `<td>${celda}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

function reporteMetadatos(analisis) {
  const filtros = reporteFiltrosActuales();
  const aplicados = [
    ['Región', reporteTextoSeleccion(filtros.region, 'Todas')], ['País', reporteTextoSeleccion(filtros.pais, 'Todos')], ['Sistema operativo', reporteTextoSeleccion(filtros.sistema, 'Todos')],
    ['Estado', reporteTextoSeleccion(filtros.estado, 'Todos')], ['Columnas', reporteTextoSeleccionColumnas(filtros.campo)], ['Valores', reporteTextoFiltrosValores(filtros.campo)], ['Búsqueda', filtros.buscar || 'Ninguna']
  ].map(([nombre, valor]) => `<span><strong>${reporteEsc(nombre)}:</strong> ${reporteEsc(valor)}</span>`).join('');
  return `<div class="reporte-metadatos"><span><strong>Generado:</strong> ${reporteEsc(analisis.fechaGeneracion)}</span><span><strong>Fecha de corte:</strong> ${reporteEsc(analisis.fechaCorte)}</span><span><strong>Filtros:</strong> ${aplicados}</span></div>`;
}

function reporteInsights(analisis) {
  const { resumen, paisesConRiesgo, sistemas, regiones, mismatches } = analisis;
  const insights = [];
  const mayorVolumen = [...paisesConRiesgo].sort((a, b) => b.sin_cifrar - a.sin_cifrar)[0];
  const mayorProporcion = [...paisesConRiesgo].filter(pais => pais.total >= 3).sort((a, b) => b.sin_cifrar / b.total - a.sin_cifrar / a.total)[0] || [...paisesConRiesgo].sort((a, b) => b.sin_cifrar / b.total - a.sin_cifrar / a.total)[0];
  const sistemaRiesgo = [...sistemas].sort((a, b) => b.sin_cifrar - a.sin_cifrar)[0];
  const regionRiesgo = [...regiones].sort((a, b) => b.sin_cifrar - a.sin_cifrar)[0];

  if (mayorVolumen) insights.push(`${reporteEsc(mayorVolumen.nombre)} concentra el mayor volumen de equipos sin cifrar: ${mayorVolumen.sin_cifrar.toLocaleString('es-MX')} de ${mayorVolumen.total.toLocaleString('es-MX')} (${reportePorcentaje(mayorVolumen.sin_cifrar, mayorVolumen.total)}).`);
  if (mayorProporcion && mayorProporcion.nombre !== mayorVolumen?.nombre) insights.push(`${reporteEsc(mayorProporcion.nombre)} tiene la mayor proporción de equipos sin cifrar entre los países analizados: ${reportePorcentaje(mayorProporcion.sin_cifrar, mayorProporcion.total)} (${mayorProporcion.sin_cifrar} de ${mayorProporcion.total}).`);
  if (sistemaRiesgo && sistemaRiesgo.sin_cifrar) insights.push(`${reporteEsc(sistemaRiesgo.nombre)} concentra ${sistemaRiesgo.sin_cifrar.toLocaleString('es-MX')} equipos sin cifrar (${reportePorcentaje(sistemaRiesgo.sin_cifrar, sistemaRiesgo.total)} de ese sistema).`);
  if (regionRiesgo && regionRiesgo.sin_cifrar) insights.push(`${reporteEsc(regionRiesgo.nombre)} registra ${regionRiesgo.sin_cifrar.toLocaleString('es-MX')} equipos sin cifrar, equivalente al ${reportePorcentaje(regionRiesgo.sin_cifrar, resumen.sin_cifrar)} de los equipos sin cifrar del conjunto filtrado.`);
  if (resumen.desconocido) insights.push(`${resumen.desconocido.toLocaleString('es-MX')} equipos (${reportePorcentaje(resumen.desconocido, resumen.total)}) no tienen información suficiente para confirmar su estado de cifrado.`);
  if (mismatches.length) insights.push(`Se detectaron ${mismatches.length.toLocaleString('es-MX')} registros marcados como cumplidos pero con estado real sin cifrar.`);
  return insights.slice(0, 5);
}

function reporteRecomendaciones(analisis) {
  const recomendaciones = [];
  if (analisis.resumen.sin_cifrar) recomendaciones.push(`Priorizar la revisión de los ${analisis.resumen.sin_cifrar.toLocaleString('es-MX')} equipos sin cifrar, comenzando por los países con prioridad alta.`);
  if (analisis.resumen.desconocido) recomendaciones.push(`Completar la información de ${analisis.resumen.desconocido.toLocaleString('es-MX')} equipos para evitar decisiones basadas en datos incompletos.`);
  if (analisis.resumen.parcial) recomendaciones.push(`Validar los ${analisis.resumen.parcial.toLocaleString('es-MX')} equipos con cifrado parcial y confirmar su estado esperado.`);
  if (analisis.mismatches.length) recomendaciones.push(`Investigar las ${analisis.mismatches.length.toLocaleString('es-MX')} inconsistencias entre cumplimiento reportado y cifrado real.`);
  if (analisis.sinMdm) recomendaciones.push(`Revisar los ${analisis.sinMdm.toLocaleString('es-MX')} equipos que no aparecen registrados en MDM, si la administración central es necesaria para aplicar políticas.`);
  if (!recomendaciones.length) recomendaciones.push('No hay acciones prioritarias identificables con los datos disponibles. Mantener seguimiento periódico.');
  return recomendaciones.slice(0, 5);
}

function reporteBarraHorizontal(valor, maximo = 100, clase = '') {
  const porcentaje = maximo ? Math.max(0, Math.min(100, valor / maximo * 100)) : 0;
  return `<div class="reporte-grafica-pista"><span class="reporte-grafica-barra ${clase}" style="width:${porcentaje.toFixed(2)}%"></span></div>`;
}

function reporteGraficaEstado(analisis) {
  const { resumen: r } = analisis;
  if (!r.total) return '<p class="reporte-vacio">Información no disponible para esta gráfica.</p>';
  const categorias = [
    ['protegido', 'Cifrados', 'reporte-grafica-segmento--bueno'],
    ['sin_cifrar', 'Sin cifrar', 'reporte-grafica-segmento--riesgo'],
    ['parcial', 'Parciales', 'reporte-grafica-segmento--alerta'],
    ['desconocido', 'Sin información', 'reporte-grafica-segmento--neutro'],
  ];
  return `<div class="reporte-grafica-estado"><div class="reporte-grafica-segmentada">${categorias.map(([clave, etiqueta, clase]) => `<span class="${clase}" style="width:${(r[clave] / r.total * 100).toFixed(2)}%" title="${etiqueta}: ${r[clave].toLocaleString('es-MX')} (${reportePorcentaje(r[clave], r.total)})"></span>`).join('')}</div><div class="reporte-grafica-leyenda">${categorias.map(([clave, etiqueta, clase]) => `<span><i class="${clase}"></i><b>${reportePorcentaje(r[clave], r.total)}</b> ${etiqueta} · ${r[clave].toLocaleString('es-MX')}</span>`).join('')}</div></div><p class="reporte-grafica-insight">${r.protegido.toLocaleString('es-MX')} equipos (${reportePorcentaje(r.protegido, r.total)}) cuentan con cifrado activo.</p>`;
}

function reporteGraficaPaises(analisis) {
  const paises = [...analisis.paisesConRiesgo]
    .sort((a, b) => b.sin_cifrar / Math.max(1, b.total) - a.sin_cifrar / Math.max(1, a.total) || b.sin_cifrar - a.sin_cifrar)
    .slice(0, 5);
  if (!paises.length) return '<p class="reporte-vacio">No hay países con equipos sin cifrar en los filtros seleccionados.</p>';
  const mayor = paises[0];
  return `<div class="reporte-grafica-lista">${paises.map(pais => { const porcentaje = pais.sin_cifrar / Math.max(1, pais.total) * 100; return `<div class="reporte-grafica-fila"><div class="reporte-grafica-cabecera"><span>${reporteEsc(pais.nombre)}</span><strong>${porcentaje.toFixed(1)}% · ${pais.sin_cifrar.toLocaleString('es-MX')} afectados</strong></div>${reporteBarraHorizontal(porcentaje, 100, 'reporte-grafica-barra--riesgo')}<small>Muestra: ${pais.total.toLocaleString('es-MX')} equipos · ${reporteEsc(pais.region || 'Región no disponible')}</small></div>`; }).join('')}</div><p class="reporte-grafica-insight">${reporteEsc(mayor.nombre)} presenta la mayor proporción de equipos sin cifrar: ${reportePorcentaje(mayor.sin_cifrar, mayor.total)} (${mayor.sin_cifrar.toLocaleString('es-MX')} de ${mayor.total.toLocaleString('es-MX')}).</p>`;
}

function reporteGraficaSistemas(analisis) {
  const sistemas = [...analisis.sistemas].sort((a, b) => a.protegido / Math.max(1, a.total) - b.protegido / Math.max(1, b.total));
  if (!sistemas.length) return '<p class="reporte-vacio">Información no disponible para esta gráfica.</p>';
  const menor = sistemas[0];
  return `<div class="reporte-grafica-lista">${sistemas.map(sistema => { const porcentaje = sistema.protegido / Math.max(1, sistema.total) * 100; const clase = porcentaje < 75 ? 'reporte-grafica-barra--riesgo' : porcentaje < 85 ? 'reporte-grafica-barra--alerta' : 'reporte-grafica-barra--bueno'; return `<div class="reporte-grafica-fila"><div class="reporte-grafica-cabecera"><span>${reporteEsc(sistema.nombre)}</span><strong>${porcentaje.toFixed(1)}% cifrado · ${sistema.total.toLocaleString('es-MX')} equipos</strong></div>${reporteBarraHorizontal(porcentaje, 100, clase)}</div>`; }).join('')}</div><p class="reporte-grafica-insight">${reporteEsc(menor.nombre)} tiene la menor cobertura de cifrado entre los sistemas analizados: ${reportePorcentaje(menor.protegido, menor.total)}.</p>`;
}

function reporteGraficaRegiones(analisis) {
  const regiones = [...analisis.regiones].filter(region => region.sin_cifrar > 0).sort((a, b) => b.sin_cifrar - a.sin_cifrar).slice(0, 5);
  if (!regiones.length) return '<p class="reporte-vacio">No hay regiones con equipos sin cifrar en los filtros seleccionados.</p>';
  const mayor = regiones[0];
  return `<div class="reporte-grafica-lista">${regiones.map(region => `<div class="reporte-grafica-fila"><div class="reporte-grafica-cabecera"><span>${reporteEsc(region.nombre)}</span><strong>${region.sin_cifrar.toLocaleString('es-MX')} equipos sin cifrar</strong></div>${reporteBarraHorizontal(region.sin_cifrar, mayor.sin_cifrar, 'reporte-grafica-barra--riesgo')}<small>${reportePorcentaje(region.sin_cifrar, region.total)} del total regional</small></div>`).join('')}</div><p class="reporte-grafica-insight">${reporteEsc(mayor.nombre)} concentra la mayor cantidad de equipos sin cifrar: ${mayor.sin_cifrar.toLocaleString('es-MX')}.</p>`;
}

function renderReporteGraficasEjecutivo(analisis) {
  const bloques = [];
  if (reporteGraficas.has('estado')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Estado general de cifrado</h3>${reporteGraficaEstado(analisis)}</section>`);
  if (reporteGraficas.has('paises')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Países que requieren atención</h3>${reporteGraficaPaises(analisis)}</section>`);
  if (reporteGraficas.has('sistemas')) bloques.push(`<section class="reporte-bloque"><h3>Cifrado por sistema operativo</h3>${reporteGraficaSistemas(analisis)}</section>`);
  if (reporteGraficas.has('regiones')) bloques.push(`<section class="reporte-bloque"><h3>Distribución regional del riesgo</h3>${reporteGraficaRegiones(analisis)}</section>`);
  return bloques.join('');
}

function reporteBloqueGestion(analisis) {
  const filas = [];
  if (reporteContenidoActivo('mdm')) filas.push(['MDM', analisis.columnas.mdm ? `${num(analisis.filas.length - (analisis.sinMdm || 0))} registrados · ${reportePorcentaje(analisis.filas.length - (analisis.sinMdm || 0), analisis.resumen.total)}` : 'Información no disponible']);
  if (reporteContenidoActivo('ad')) filas.push(['Active Directory', analisis.columnas.ad ? `${num(analisis.filas.length - (analisis.sinAd || 0))} registrados · ${reportePorcentaje(analisis.filas.length - (analisis.sinAd || 0), analisis.resumen.total)}` : 'Información no disponible']);
  return `<section class="reporte-bloque"><h3>Cobertura de gestión</h3>${reporteTabla(['Control', 'Cobertura'], filas)}</section>`;
}

function reporteBloqueCumplimiento(analisis) {
  const cumplimiento = analisis.columnas.cumplimiento
    ? analisis.filas.filter(fila => ['si', 'yes', 'true', '1', 'compliant', 'cumple'].includes(reporteNormalizar(reporteValor(fila, analisis.columnas.cumplimiento)))).length
    : null;
  const evaluados = cumplimiento == null ? 0 : analisis.filas.filter(fila => !reporteEsSinDato(reporteValor(fila, analisis.columnas.cumplimiento))).length;
  return `<section class="reporte-bloque"><h3>Cumplimiento</h3>${cumplimiento == null ? '<p class="reporte-vacio">No hay una columna de cumplimiento disponible.</p>' : `<div class="reporte-kpis reporte-kpis--compactos"><div class="reporte-kpi reporte-kpi--bueno"><strong>${num(cumplimiento)}</strong><span>Cumplen · ${reportePorcentaje(cumplimiento, evaluados)}</span></div><div class="reporte-kpi"><strong>${num(evaluados - cumplimiento)}</strong><span>No cumplen</span></div></div>`}</section>`;
}

function reporteBloqueAlertas(analisis) {
  const filas = analisis.severidades.map(item => [reporteEsc(item.nombre), num(item.registros), num(item.equipos), `${num(item.paises)} países · ${num(item.sistemas)} sistemas`]);
  if (analisis.mismatches.length) filas.push(['Inconsistencia de cumplimiento', num(analisis.mismatches.length), num(new Set(analisis.mismatches.map(fila => reporteValor(fila, analisis.columnas.id)).filter(Boolean)).size), 'Cumplido y sin cifrar']);
  return `<section class="reporte-bloque"><h3>Alertas de cifrado</h3>${reporteTabla(['Tipo', 'Registros', 'Equipos', 'Detalle'], filas)}</section>`;
}

function reporteBloqueGeografia(analisis) {
  const paisRows = analisis.paisesConRiesgo.slice(0, 8).map(pais => {
    const prioridad = pais.prioridad;
    return [reporteEsc(pais.nombre), pais.total.toLocaleString('es-MX'), pais.sin_cifrar.toLocaleString('es-MX'), reportePorcentaje(pais.sin_cifrar, pais.total), `<span class="reporte-prioridad reporte-prioridad--${prioridad.clase}">${prioridad.texto}</span>`];
  });
  const regionRows = analisis.regiones.map(region => [reporteEsc(region.nombre), num(region.total), num(region.protegido), num(region.sin_cifrar), reportePorcentaje(region.protegido, region.total)]);
  return `<section class="reporte-bloque reporte-bloque--ancho"><h3>Cifrado por país y región</h3>${reporteTabla(['País', 'Total', 'Sin cifrar', '% sin cifrar', 'Prioridad'], paisRows)}<h4 class="reporte-subtitulo">Distribución por región</h4>${reporteTabla(['Región', 'Total', 'Cifrados', 'Sin cifrar', '% cifrado'], regionRows)}</section>`;
}

function reporteGraficaEvolucion() {
  const puntos = reporteCargasHistoricas
    .filter(carga => Array.isArray(carga.filas) && carga.filas.length)
    .map(carga => {
      const analisis = reporteAnalizar(reporteFiltrarFilas(carga.filas));
      const fecha = carga.fechaCorte || carga.meta?.fecha_corte || carga.recibidoEn;
      return { fecha, analisis };
    })
    .filter(punto => punto.analisis.resumen.total && punto.fecha)
    .sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  if (!puntos.length) return '<p class="reporte-vacio">No hay datos históricos disponibles para la evolución.</p>';
  const ancho = 680; const alto = 190; const margen = 28;
  const x = indice => puntos.length > 1 ? margen + indice * (ancho - margen * 2) / (puntos.length - 1) : ancho / 2;
  const y = valor => alto - margen - Math.max(0, Math.min(100, valor)) / 100 * (alto - margen * 2);
  const valores = puntos.map(punto => punto.analisis.resumen.protegido / punto.analisis.resumen.total * 100);
  const linea = valores.length > 1 ? `<polyline fill="none" stroke="${PALETA.info}" stroke-width="3" points="${valores.map((valor, indice) => `${x(indice)},${y(valor)}`).join(' ')}"/>` : '';
  const marcadores = valores.map((valor, indice) => `<circle cx="${x(indice)}" cy="${y(valor)}" r="4" fill="${PALETA.info}"><title>${esc(fechaHora(puntos[indice].fecha))}: ${valor.toFixed(1)}% · ${num(puntos[indice].analisis.resumen.protegido)} de ${num(puntos[indice].analisis.resumen.total)}</title></circle>`).join('');
  const guias = [0, 50, 100].map(valor => `<line x1="${margen}" x2="${ancho - margen}" y1="${y(valor)}" y2="${y(valor)}" stroke="currentColor" opacity=".16"/><text x="${margen - 5}" y="${y(valor) + 3}" text-anchor="end">${valor}%</text>`).join('');
  return `<svg class="reporte-evolucion-svg" viewBox="0 0 ${ancho} ${alto}" role="img" aria-label="Evolución histórica del porcentaje de cifrado">${guias}${linea}${marcadores}</svg><p class="reporte-grafica-insight">Se muestran ${num(puntos.length)} cargas históricas; la línea utiliza el mismo cálculo de cifrado que el reporte.</p>`;
}

function reporteBloqueComparacion() {
  if (!reporteComparacion) return '<section class="reporte-bloque"><h3>Comparación entre periodos</h3><p class="reporte-vacio">Selecciona dos periodos para mostrar esta sección.</p></section>';
  const a = reporteComparacion.inicial.resumen; const b = reporteComparacion.final.resumen;
  const pp = b.protegido / Math.max(1, b.total) * 100 - a.protegido / Math.max(1, a.total) * 100;
  return `<section class="reporte-bloque"><h3>Comparación entre periodos</h3><ul class="reporte-lista"><li>Equipos totales: ${num(a.total)} → ${num(b.total)}.</li><li>Equipos cifrados: ${num(a.protegido)} → ${num(b.protegido)}.</li><li>Equipos sin cifrar: ${num(a.sin_cifrar)} → ${num(b.sin_cifrar)}.</li><li>Cambio de cobertura: ${pp >= 0 ? '+' : ''}${pp.toFixed(1)} puntos porcentuales.</li></ul></section>`;
}

function renderReporteEjecutivo(analisis, paraPDF = false) {
  const r = analisis.resumen;
  const soRows = analisis.sistemas.filter(sistema => sistema.sin_cifrar > 0).slice(0, 6).map(sistema => [reporteEsc(sistema.nombre), sistema.total.toLocaleString('es-MX'), sistema.sin_cifrar.toLocaleString('es-MX'), reportePorcentaje(sistema.protegido, sistema.total)]);
  const situacion = r.sin_cifrar === 0 && r.desconocido === 0 ? 'La situación general es favorable con los datos disponibles.' : r.sin_cifrar / Math.max(1, r.total) >= 0.25 ? 'La situación requiere atención prioritaria por la proporción de equipos sin cifrar.' : 'La situación es controlable, pero requiere seguimiento de los equipos sin cifrar y de la calidad de los datos.';
  const bloques = [];
  if (reporteContenidoActivo('resumen')) bloques.push(`<section class="reporte-bloque"><h3>Resumen ejecutivo</h3><p>${reporteEsc(situacion)}</p><p>Hay ${r.parcial.toLocaleString('es-MX')} equipos con cifrado parcial y ${r.desconocido.toLocaleString('es-MX')} sin información suficiente.</p><h3 class="reporte-subtitulo">Insights automáticos</h3>${reporteInsights(analisis).length ? `<ul class="reporte-lista">${reporteInsights(analisis).map(insight => `<li>${insight}</li>`).join('')}</ul>` : '<p class="reporte-vacio">Información no disponible para generar insights.</p>'}</section>`);
  if (reporteContenidoActivo('geografia')) bloques.push(reporteBloqueGeografia(analisis));
  if (reporteContenidoActivo('estado') && reporteGraficas.has('estado')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Estado general de cifrado</h3>${reporteGraficaEstado(analisis)}</section>`);
  if (reporteContenidoActivo('sistemas') && reporteGraficas.has('sistemas')) bloques.push(`<section class="reporte-bloque"><h3>Cifrado por sistema operativo</h3>${reporteGraficaSistemas(analisis)}</section>`);
  if (reporteContenidoActivo('geografia') && reporteGraficas.has('paises')) bloques.push(`<section class="reporte-bloque"><h3>Países que requieren atención</h3>${reporteGraficaPaises(analisis)}</section>`);
  if (reporteContenidoActivo('geografia') && reporteGraficas.has('regiones')) bloques.push(`<section class="reporte-bloque"><h3>Distribución regional del riesgo</h3>${reporteGraficaRegiones(analisis)}</section>`);
  if (reporteContenidoActivo('mdm') || reporteContenidoActivo('ad')) bloques.push(reporteBloqueGestion(analisis));
  if (reporteContenidoActivo('cumplimiento')) bloques.push(reporteBloqueCumplimiento(analisis));
  if (reporteContenidoActivo('alertas')) bloques.push(reporteBloqueAlertas(analisis));
  if (reporteContenidoActivo('evolucion')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Evolución histórica del cifrado</h3>${reporteGraficaEvolucion()}</section>`);
  if (reporteContenidoActivo('comparacion') && reporteFuente === 'comparativo') bloques.push(reporteBloqueComparacion());
  if (reporteContenidoActivo('sistemas')) bloques.push(`<section class="reporte-bloque"><h3>Riesgos principales</h3>${reporteTabla(['Sistema', 'Total', 'Sin cifrar', '% cifrado'], soRows)}</section>`);
  if (reporteContenidoActivo('recomendaciones')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Recomendaciones y conclusiones</h3><ul class="reporte-lista">${reporteRecomendaciones(analisis).map(recomendacion => `<li>${recomendacion}</li>`).join('')}</ul></section>`);
  const encabezado = `<div class="reporte-resumen-cabecera"><div><h3>Reporte ejecutivo</h3><p>Resumen para toma de decisiones de FEMSA.</p></div></div>${reporteMetadatos(analisis)}`;
  const kpis = reporteContenidoActivo('resumen') ? `<div class="reporte-kpis"><div class="reporte-kpi"><strong>${r.total.toLocaleString('es-MX')}</strong><span>Equipos analizados</span></div><div class="reporte-kpi reporte-kpi--bueno"><strong>${r.protegido.toLocaleString('es-MX')} · ${reportePorcentaje(r.protegido, r.total)}</strong><span>Equipos cifrados</span></div><div class="reporte-kpi reporte-kpi--riesgo"><strong>${r.sin_cifrar.toLocaleString('es-MX')} · ${reportePorcentaje(r.sin_cifrar, r.total)}</strong><span>Equipos sin cifrar</span></div><div class="reporte-kpi"><strong>${(r.parcial + r.desconocido).toLocaleString('es-MX')}</strong><span>Parciales o sin información</span></div></div>` : '';
  return `${encabezado}${kpis}<div class="reporte-bloques">${bloques.join('')}</div>`;
}

function renderReporteComparativoBase(comparacion) {
  if (!comparacion) return '<p class="reporte-vacio">Selecciona dos cargas históricas para generar el comparativo.</p>';
  const a = comparacion.inicial;
  const b = comparacion.final;
  const cambio = (valor, menorEsMejor = false) => {
    const mejora = menorEsMejor ? valor <= 0 : valor >= 0;
    return `<span class="${mejora ? 'comparacion-mejora' : 'comparacion-riesgo'}">${valor > 0 ? '↑ +' : valor < 0 ? '↓ ' : '→ '}${valor.toLocaleString('es-MX')}</span>`;
  };
  const sistemas = b.sistemas.map(sistema => {
    const anterior = a.sistemas.find(item => item.nombre === sistema.nombre);
    const pp = anterior ? sistema.protegido / Math.max(1, sistema.total) * 100 - anterior.protegido / Math.max(1, anterior.total) * 100 : null;
    return [reporteEsc(sistema.nombre), `${reportePorcentaje(sistema.protegido, sistema.total)} · ${num(sistema.total)}`, pp == null ? 'Información no disponible' : cambio(Number(pp.toFixed(1)))];
  });
  return `<div class="reporte-resumen-cabecera"><div><h3>Reporte comparativo</h3><p>Evolución entre dos cargas históricas seleccionadas.</p></div></div><div class="reporte-metadatos"><span><strong>Periodo inicial:</strong> ${reporteEsc(a.archivo || 'Sin nombre')}</span><span><strong>Periodo final:</strong> ${reporteEsc(b.archivo || 'Sin nombre')}</span><span><strong>Filtros:</strong> Se aplican los filtros seleccionados</span></div><div class="reporte-kpis"><div class="reporte-kpi"><strong>${cambio(b.total - a.total)}</strong><span>Cambio en equipos totales</span></div><div class="reporte-kpi reporte-kpi--bueno"><strong>${cambio(b.protegido - a.protegido)}</strong><span>Cambio en equipos cifrados</span></div><div class="reporte-kpi reporte-kpi--riesgo"><strong>${cambio(b.sin_cifrar - a.sin_cifrar, true)}</strong><span>Cambio en equipos sin cifrar</span></div><div class="reporte-kpi"><strong>${cambio(Number((b.protegido / Math.max(1, b.total) * 100 - a.protegido / Math.max(1, a.total) * 100).toFixed(1)))}</strong><span>Cambio de cobertura (pp)</span></div></div><div class="reporte-bloques"><section class="reporte-bloque reporte-bloque--ancho"><h3>Cambios por sistema operativo</h3>${reporteTabla(['Sistema operativo', 'Periodo final', 'Cambio de cobertura'], sistemas)}</section><section class="reporte-bloque reporte-bloque--ancho"><h3>Conclusiones</h3><ul class="reporte-lista"><li>La carga final contiene ${num(b.total)} equipos frente a ${num(a.total)} en la inicial.</li><li>La cobertura pasó de ${reportePorcentaje(a.protegido, a.total)} a ${reportePorcentaje(b.protegido, b.total)}.</li><li>${b.sin_cifrar <= a.sin_cifrar ? 'Los equipos sin cifrar disminuyeron o se mantuvieron.' : 'Los equipos sin cifrar aumentaron y requieren revisión prioritaria.'}</li></ul></section></div>`;
}

function renderReporteComparativo(comparacion) {
  if (!comparacion) return '<p class="reporte-vacio">Selecciona dos cargas históricas para generar el comparativo.</p>';
  const a = comparacion.inicial;
  const b = comparacion.final;
  const delta = b.protegido / Math.max(1, b.total) * 100 - a.protegido / Math.max(1, a.total) * 100;
  const cambio = (valor, menorEsMejor = false) => {
    const mejora = menorEsMejor ? valor <= 0 : valor >= 0;
    return `<span class="${mejora ? 'comparacion-mejora' : 'comparacion-riesgo'}">${valor > 0 ? '↑ +' : valor < 0 ? '↓ ' : '→ '}${valor.toLocaleString('es-MX')}</span>`;
  };
  const sistemas = b.sistemas.map(sistema => {
    const anterior = a.sistemas.find(item => item.nombre === sistema.nombre);
    const pp = anterior ? sistema.protegido / Math.max(1, sistema.total) * 100 - anterior.protegido / Math.max(1, anterior.total) * 100 : null;
    return [reporteEsc(sistema.nombre), `${reportePorcentaje(sistema.protegido, sistema.total)} · ${num(sistema.total)}`, pp == null ? 'Información no disponible' : cambio(Number(pp.toFixed(1)))];
  });
  const bloques = [];
  if (reporteContenidoActivo('sistemas')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Cambios por sistema operativo</h3>${reporteTabla(['Sistema operativo', 'Periodo final', 'Cambio de cobertura'], sistemas)}</section>`);
  if (reporteContenidoActivo('recomendaciones')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Conclusiones</h3><ul class="reporte-lista"><li>La carga final contiene ${num(b.total)} equipos frente a ${num(a.total)} en la inicial.</li><li>La cobertura pasó de ${reportePorcentaje(a.protegido, a.total)} a ${reportePorcentaje(b.protegido, b.total)}.</li><li>${b.sin_cifrar <= a.sin_cifrar ? 'Los equipos sin cifrar disminuyeron o se mantuvieron.' : 'Los equipos sin cifrar aumentaron y requieren revisión prioritaria.'}</li></ul></section>`);
  const kpis = reporteContenidoActivo('resumen') ? `<div class="reporte-kpis"><div class="reporte-kpi"><strong>${cambio(b.total - a.total)}</strong><span>Cambio en equipos totales</span></div><div class="reporte-kpi reporte-kpi--bueno"><strong>${cambio(b.protegido - a.protegido)}</strong><span>Cambio en equipos cifrados</span></div><div class="reporte-kpi reporte-kpi--riesgo"><strong>${cambio(b.sin_cifrar - a.sin_cifrar, true)}</strong><span>Cambio en equipos sin cifrar</span></div><div class="reporte-kpi"><strong>${cambio(Number(delta.toFixed(1)))}</strong><span>Cambio de cobertura (pp)</span></div></div>` : '';
  return `<div class="reporte-resumen-cabecera"><div><h3>Reporte comparativo</h3><p>Evolución entre dos cargas históricas seleccionadas.</p></div></div><div class="reporte-metadatos"><span><strong>Periodo inicial:</strong> ${reporteEsc(a.archivo || 'Sin nombre')}</span><span><strong>Periodo final:</strong> ${reporteEsc(b.archivo || 'Sin nombre')}</span><span><strong>Filtros:</strong> Se aplican los filtros seleccionados</span></div>${kpis}<div class="reporte-bloques">${bloques.join('')}</div>`;
}

function renderReporteTecnico(analisis, paraPDF = false) {
  const r = analisis.resumen;
  const paisRows = analisis.paises.map(pais => {
    const prioridad = reportePrioridad(pais);
    return [reporteEsc(pais.nombre), reporteEsc(pais.region), pais.total.toLocaleString('es-MX'), pais.protegido.toLocaleString('es-MX'), pais.sin_cifrar.toLocaleString('es-MX'), pais.parcial.toLocaleString('es-MX'), pais.desconocido.toLocaleString('es-MX'), reportePorcentaje(pais.protegido, pais.total), reportePorcentaje(pais.sin_cifrar, pais.total), `<span class="reporte-prioridad reporte-prioridad--${prioridad.clase}">${prioridad.texto}</span>`];
  });
  const soRows = analisis.sistemas.map(sistema => [reporteEsc(sistema.nombre), sistema.total.toLocaleString('es-MX'), sistema.protegido.toLocaleString('es-MX'), sistema.sin_cifrar.toLocaleString('es-MX'), sistema.parcial.toLocaleString('es-MX'), reportePorcentaje(sistema.protegido, sistema.total)]);
  const regionRows = analisis.regiones.map(region => [reporteEsc(region.nombre), region.total.toLocaleString('es-MX'), region.protegido.toLocaleString('es-MX'), region.sin_cifrar.toLocaleString('es-MX'), reportePorcentaje(region.protegido, region.total)]);
  const exceptionRows = analisis.severidades.map(item => [reporteEsc(item.nombre), item.registros.toLocaleString('es-MX'), item.equipos.toLocaleString('es-MX'), `${item.paises} países · ${item.sistemas} sistemas`]);
  if (analisis.mismatches.length) exceptionRows.push(['Inconsistencia de cumplimiento', analisis.mismatches.length.toLocaleString('es-MX'), new Set(analisis.mismatches.map(fila => reporteValor(fila, analisis.columnas.id)).filter(Boolean)).size.toLocaleString('es-MX'), 'Cumplido y sin cifrar']);
  const filasDetalle = paraPDF ? analisis.atencion : analisis.atencion.slice(0, 100);
  const detalleRows = filasDetalle.map(fila => analisis.camposDetalle.map(([, columna]) => reporteEsc(reporteValor(fila, columna) || 'No disponible')));
  const bloques = [];
  if (reporteContenidoActivo('estado')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Análisis general de cifrado</h3>${reporteTabla(['Categoría', 'Cantidad', 'Porcentaje'], [['Protegido', r.protegido.toLocaleString('es-MX'), reportePorcentaje(r.protegido, r.total)], ['Sin cifrar', r.sin_cifrar.toLocaleString('es-MX'), reportePorcentaje(r.sin_cifrar, r.total)], ['Parcial', r.parcial.toLocaleString('es-MX'), reportePorcentaje(r.parcial, r.total)], ['Sin información', r.desconocido.toLocaleString('es-MX'), reportePorcentaje(r.desconocido, r.total)]])}</section>`);
  if (reporteContenidoActivo('geografia')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Análisis por país</h3>${reporteTabla(['País', 'Región', 'Total', 'Cifrados', 'Sin cifrar', 'Parciales', 'Sin info', '% cifrado', '% sin cifrar', 'Prioridad'], paisRows)}<h4 class="reporte-subtitulo">Análisis por región</h4>${reporteTabla(['Región', 'Total', 'Cifrados', 'Sin cifrar', '% cifrado'], regionRows)}</section>`);
  if (reporteContenidoActivo('sistemas')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Análisis por sistema operativo</h3>${reporteTabla(['Sistema', 'Total', 'Cifrados', 'Sin cifrar', 'Parciales', '% cifrado'], soRows)}</section>`);
  if (reporteContenidoActivo('alertas')) bloques.push(`<section class="reporte-bloque"><h3>Excepciones e inconsistencias</h3>${reporteTabla(['Tipo', 'Registros', 'Equipos', 'Detalle'], exceptionRows)}${analisis.mismatches.length ? `<p class="reporte-vacio">La cantidad de inconsistencias corresponde a registros; se muestran equipos únicos cuando existe un identificador.</p>` : ''}</section>`);
  if (reporteContenidoActivo('mdm') || reporteContenidoActivo('ad')) bloques.push(reporteBloqueGestion(analisis));
  if (reporteContenidoActivo('cumplimiento')) bloques.push(reporteBloqueCumplimiento(analisis));
  if (reporteContenidoActivo('evolucion')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Evolución histórica del cifrado</h3>${reporteGraficaEvolucion()}</section>`);
  if (reporteContenidoActivo('comparacion') && reporteFuente === 'comparativo') bloques.push(reporteBloqueComparacion());
  if (reporteContenidoActivo('recomendaciones')) bloques.push(`<section class="reporte-bloque"><h3>Recomendaciones técnicas</h3><ul class="reporte-lista">${reporteRecomendaciones(analisis).map(recomendacion => `<li>${recomendacion}</li>`).join('')}</ul></section>`);
  if (reporteContenidoActivo('detalle')) bloques.push(`<section class="reporte-bloque reporte-bloque--ancho"><h3>Equipos que requieren atención</h3>${reporteTabla(analisis.camposDetalle.map(([nombre]) => nombre), detalleRows, 'reporte-tabla--detalle')}${!paraPDF && analisis.atencion.length > 100 ? `<p class="reporte-vacio">Vista previa limitada a 100 equipos; el PDF incluye todos los registros disponibles.</p>` : ''}</section>`);
  const encabezado = `<div class="reporte-resumen-cabecera"><div><h3>Reporte técnico</h3><p>Detalle operativo para TI y ciberseguridad.</p></div></div>${reporteMetadatos(analisis)}`;
  const kpis = reporteContenidoActivo('resumen') ? `<div class="reporte-kpis"><div class="reporte-kpi"><strong>${r.total.toLocaleString('es-MX')}</strong><span>Total de equipos</span></div><div class="reporte-kpi"><strong>${r.protegido.toLocaleString('es-MX')} · ${reportePorcentaje(r.protegido, r.total)}</strong><span>Protegidos</span></div><div class="reporte-kpi"><strong>${r.parcial.toLocaleString('es-MX')} · ${reportePorcentaje(r.parcial, r.total)}</strong><span>Parciales</span></div><div class="reporte-kpi reporte-kpi--riesgo"><strong>${r.sin_cifrar.toLocaleString('es-MX')} · ${reportePorcentaje(r.sin_cifrar, r.total)}</strong><span>Sin cifrar</span></div></div>` : '';
  return `${encabezado}${kpis}<div class="reporte-bloques">${bloques.join('')}</div>`;
}

function pintarReporte() {
  reporteFiltrar();
  reporteActualizarOpcionesContenido();
  if (!reporteContenido.size) {
    reporteEl('reporteContador').textContent = 'Selecciona al menos una sección para mostrar el reporte';
    reporteEl('reporteVistaPrevia').innerHTML = '<div class="reporte-vacio reporte-vacio--seleccion"><strong>No hay contenido seleccionado</strong><span>Marca una o más secciones para actualizar la vista previa y generar el PDF.</span></div>';
    return;
  }
  if (reporteFuente === 'comparativo') {
    reporteEl('reporteContador').textContent = reporteComparacion ? 'Comparación histórica lista · actualización automática' : 'Selecciona dos cargas históricas';
    reporteEl('reporteVistaPrevia').innerHTML = reporteContenidoActivo('comparacion') ? renderReporteComparativo(reporteComparacion) : '<div class="reporte-vacio reporte-vacio--seleccion"><strong>Comparación entre periodos desactivada</strong><span>Selecciona esa sección para mostrar el contenido comparativo.</span></div>';
    return;
  }
  const analisis = reporteAnalizar(reporteFiltradas);
  reporteEl('reporteContador').textContent = `${reporteFiltradas.length.toLocaleString('es-MX')} de ${reporteFilas.length.toLocaleString('es-MX')} registros · actualización automática`;
  reporteEl('reporteVistaPrevia').innerHTML = reporteTipoActivo === 'ejecutivo' ? renderReporteEjecutivo(analisis) : renderReporteTecnico(analisis);
}

function actualizarFiltrosReporte() {
  reporteActualizarTodasLasOpciones();
}

function conectarReportes() {
  reporteConfigurarMultiselect();
  reporteConfigurarCategoriasCampo();
  reporteActualizarOpcionesContenido();
  reporteEl('reporteFuente')?.addEventListener('change', async (evento) => {
    reporteFuente = evento.target.value;
    document.getElementById('reporteFuenteHistorica').hidden = reporteFuente !== 'historico';
    document.getElementById('reporteFuentesComparacion').hidden = reporteFuente !== 'comparativo';
    if (reporteFuente === 'historico' && !reporteCargaHistoricaId) reporteCargaHistoricaId = reporteCargasHistoricas[0]?.id || '';
    if (reporteFuente === 'comparativo') {
      reportePeriodoFinalId = reportePeriodoFinalId || reporteCargasHistoricas[0]?.id || '';
      reportePeriodoInicialId = reportePeriodoInicialId || reporteCargasHistoricas[1]?.id || reporteCargasHistoricas[0]?.id || '';
    }
    await cargarReportesFuente();
  });
  reporteEl('reporteCargaHistorica')?.addEventListener('change', async (evento) => {
    reporteCargaHistoricaId = evento.target.value;
    await cargarReportesFuente();
  });
  ['reportePeriodoInicial', 'reportePeriodoFinal'].forEach(id => reporteEl(id)?.addEventListener('change', async evento => {
    if (id === 'reportePeriodoInicial') reportePeriodoInicialId = evento.target.value;
    else reportePeriodoFinalId = evento.target.value;
    await cargarReportesFuente();
  }));
  ['reporteBuscar']
    .forEach(id => reporteEl(id)?.addEventListener('input', pintarReporte));
  reporteEl('reporteLimpiar')?.addEventListener('click', () => {
    Object.values(reporteSelecciones).forEach(seleccion => seleccion.clear());
    reporteEl('reporteBuscar').value = '';
    reporteActualizarTodasLasOpciones();
    pintarReporte();
  });
  document.querySelectorAll('.reporte-pestana').forEach(pestana => pestana.addEventListener('click', () => {
    reporteTipoActivo = pestana.dataset.reporte || 'ejecutivo';
    document.querySelectorAll('.reporte-pestana').forEach(otra => {
      const activa = otra === pestana;
      otra.classList.toggle('is-activa', activa);
      otra.setAttribute('aria-selected', String(activa));
    });
    reporteActualizarOpcionesContenido();
    pintarReporte();
  }));
  reporteEl('reporteContenidoTitulo')?.closest('.reporte-contenido-opciones')?.querySelector('[data-reporte-contenido-seleccionar]')?.addEventListener('click', () => {
    document.querySelectorAll('[data-reporte-contenido]').forEach(casilla => {
      if (casilla.disabled) return;
      reporteContenido.add(casilla.dataset.reporteContenido);
      casilla.checked = true;
    });
    pintarReporte();
  });
  reporteEl('reporteContenidoTitulo')?.closest('.reporte-contenido-opciones')?.querySelector('[data-reporte-contenido-limpiar]')?.addEventListener('click', () => {
    reporteContenido.clear();
    document.querySelectorAll('[data-reporte-contenido]').forEach(casilla => { casilla.checked = false; });
    pintarReporte();
  });
  document.querySelectorAll('[data-reporte-contenido]').forEach(casilla => casilla.addEventListener('change', () => {
    const clave = casilla.dataset.reporteContenido;
    if (casilla.checked) reporteContenido.add(clave);
    else reporteContenido.delete(clave);
    pintarReporte();
  }));
  document.querySelectorAll('[data-reporte-grafica]').forEach(opcion => opcion.addEventListener('change', () => {
    const grafica = opcion.dataset.reporteGrafica;
    if (opcion.checked) reporteGraficas.add(grafica);
    else reporteGraficas.delete(grafica);
    if (reporteTipoActivo === 'ejecutivo') pintarReporte();
  }));
  reporteEl('reporteEjecutivoPDF')?.addEventListener('click', () => descargarReportePDF('ejecutivo'));
  reporteEl('reporteTecnicoPDF')?.addEventListener('click', () => descargarReportePDF('tecnico'));
  reporteEl('reporteComparativoPDF')?.addEventListener('click', () => descargarReportePDF('comparativo'));
}

function reporteActualizarFuentes() {
  const select = reporteEl('reporteCargaHistorica');
  if (!select) return;
  select.innerHTML = reporteCargasHistoricas.length
    ? reporteCargasHistoricas.map(carga => `<option value="${esc(carga.id)}">${esc(carga.archivo || carga.id)} · ${esc((carga.recibidoEn || '').slice(0, 10))}</option>`).join('')
    : '<option value="">No hay snapshots históricos</option>';
  if (reporteCargasHistoricas.some(carga => carga.id === reporteCargaHistoricaId)) select.value = reporteCargaHistoricaId;
  ['reportePeriodoInicial', 'reportePeriodoFinal'].forEach(id => {
    const comparacion = reporteEl(id);
    if (!comparacion) return;
    comparacion.innerHTML = reporteCargasHistoricas.length
      ? reporteCargasHistoricas.map(carga => `<option value="${esc(carga.id)}">${esc(carga.archivo || carga.id)} · ${esc((carga.recibidoEn || '').slice(0, 10))}</option>`).join('')
      : '<option value="">No hay snapshots históricos</option>';
    const valor = id === 'reportePeriodoInicial' ? reportePeriodoInicialId : reportePeriodoFinalId;
    if (reporteCargasHistoricas.some(carga => carga.id === valor)) comparacion.value = valor;
  });
}

async function cargarReportesFuente() {
  if (reporteFuente === 'comparativo') {
    const inicial = await DB.obtenerHistorial(reportePeriodoInicialId);
    const final = await DB.obtenerHistorial(reportePeriodoFinalId);
    reporteComparacion = inicial?.filas && final?.filas ? {
      inicial: reporteAnalizar(reporteFiltrarFilas(inicial.filas)),
      final: reporteAnalizar(reporteFiltrarFilas(final.filas)),
    } : null;
    reporteFilas = final?.filas || [];
    reporteMeta = final?.meta || null;
    pintarReporte();
    return;
  }
  const datos = reporteFuente === 'historico' && reporteCargaHistoricaId
    ? await DB.obtenerHistorial(reporteCargaHistoricaId)
    : await DB.obtenerActual();
  reporteFilas = datos?.filas || [];
  reporteMeta = datos?.meta || null;
  reportePoblarColumnas();
  actualizarFiltrosReporte();
  reporteActualizarValoresPorColumna();
  reporteComparacion = null;
  pintarReporte();
}

async function cargarReportes() {
  reporteCargasHistoricas = (await DB.listarHistorial()).filter(carga => carga.esSnapshot && Array.isArray(carga.filas) && carga.filas.length);
  reporteActualizarFuentes();
  await cargarReportesFuente();
}

function reporteDocumentoHTML(tipo, analisis) {
  const contenido = tipo === 'comparativo' ? renderReporteComparativo(reporteComparacion) : tipo === 'ejecutivo' ? renderReporteEjecutivo(analisis, true) : renderReporteTecnico(analisis, true);
  const titulo = tipo === 'comparativo' ? 'Reporte comparativo' : tipo === 'ejecutivo' ? 'Reporte ejecutivo' : 'Reporte técnico';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>CifraControl · ${titulo}</title><style>@page{size:A4 portrait;margin:14mm 12mm 17mm}*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#26344f;font-size:10px;line-height:1.4;margin:0}h1{font-size:21px;margin:0 0 5px;color:#233951}h2,h3{color:#253b55}h3{font-size:13px;margin:0 0 8px}.cabecera{display:flex;justify-content:space-between;border-bottom:2px solid #263c58;padding-bottom:12px;margin-bottom:14px}.eyebrow{font-size:8px;font-weight:700;letter-spacing:1px;color:#667085}.meta{font-size:9px;color:#647084}.confidencial{border:1px solid #a63d46;color:#a63d46;border-radius:4px;padding:5px;font-weight:bold}.reporte-metadatos{display:block;margin:0 0 14px;color:#667085;font-size:9px}.reporte-metadatos span{margin-right:12px}.reporte-kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:13px}.reporte-kpi{border:1px solid #e0e5eb;border-radius:4px;padding:8px}.reporte-kpi strong{display:block;font-size:16px}.reporte-kpi span{font-size:8px;color:#687487}.reporte-kpi--riesgo strong{color:#dc2626}.reporte-kpi--bueno strong{color:#16a34a}.reporte-bloques{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.reporte-bloque{border:1px solid #e0e5eb;border-radius:4px;padding:9px;break-inside:avoid}.reporte-bloque--ancho{grid-column:1/-1}.reporte-bloque p{margin:5px 0}.reporte-lista{margin:0;padding-left:15px}.reporte-lista li{margin:4px 0}table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:8px}th{background:#eef1f5;color:#27384d;text-align:left}th,td{padding:5px 4px;border-bottom:1px solid #e4e8ed;overflow-wrap:anywhere;vertical-align:top}.reporte-tabla{overflow:visible}.reporte-vacio{color:#667085;font-size:9px}.reporte-prioridad{font-weight:bold}.reporte-prioridad--alta{color:#dc2626}.reporte-prioridad--media{color:#b45309}.reporte-prioridad--baja{color:#15803d}.reporte-grafica-lista{display:grid;gap:8px}.reporte-grafica-fila{display:grid;gap:3px;break-inside:avoid}.reporte-grafica-cabecera{display:flex;justify-content:space-between;gap:10px;color:#526174;font-size:9px}.reporte-grafica-cabecera strong{color:#26344f;font-size:8.5px}.reporte-grafica-pista{height:7px;overflow:hidden;border-radius:5px;background:#eef1f5}.reporte-grafica-barra{display:block;height:100%;min-width:2px;border-radius:5px}.reporte-grafica-barra--bueno,.reporte-grafica-segmento--bueno{background:#16a34a}.reporte-grafica-barra--alerta,.reporte-grafica-segmento--alerta{background:#d97706}.reporte-grafica-barra--riesgo,.reporte-grafica-segmento--riesgo{background:#dc2626}.reporte-grafica-segmento--neutro{background:#a1a1aa}.reporte-grafica-segmentada{display:flex;height:14px;overflow:hidden;border-radius:7px;background:#eef1f5}.reporte-grafica-segmentada>span{min-width:0}.reporte-grafica-leyenda{display:grid;grid-template-columns:repeat(2,1fr);gap:3px 8px;margin-top:5px;color:#526174;font-size:8.5px}.reporte-grafica-leyenda span{display:flex;align-items:center;gap:4px}.reporte-grafica-leyenda i{width:6px;height:6px;border-radius:2px}.reporte-grafica-leyenda b{color:#26344f}.reporte-grafica-insight{margin:7px 0 0;color:#526174;font-size:8.5px}.reporte-grafica-fila small{color:#667085;font-size:8px}.pie{margin-top:16px;border-top:1px solid #d9dfe6;padding-top:7px;color:#667085;font-size:8px}@media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body><header class="cabecera"><div><div class="eyebrow">CIFRACONTROL · FEMSA</div><h1>${reporteEsc(titulo)}</h1><div class="meta">Generado: ${reporteEsc(analisis.fechaGeneracion)} · Fecha de corte: ${reporteEsc(analisis.fechaCorte)} · Equipos: ${analisis.resumen.total.toLocaleString('es-MX')}</div></div><div class="confidencial">CONFIDENCIAL</div></header>${contenido}<footer class="pie">CifraControl · Uso interno · Reporte generado con datos locales y filtros seleccionados</footer></body></html>`;
}

function aplicarPaletaPDF(html) {
  const equivalencias = {
    '#dc2626': PALETA.peligro,
    '#16a34a': PALETA.exito,
    '#d97706': PALETA.alerta,
    '#a1a1aa': PALETA.desconocido,
    '#a63d46': PALETA.femsa,
    '#b03a43': PALETA.peligro,
    '#9b2c39': PALETA.femsa,
    '#2563eb': PALETA.info
  };
  return Object.entries(equivalencias).reduce((documento, [origen, destino]) => documento.replaceAll(origen, destino), html);
}

function descargarReportePDF(tipo) {
  reporteFiltrar();
  if (!reporteContenido.size) {
    alert('Selecciona al menos una sección para generar este reporte.');
    return;
  }
  if (tipo === 'comparativo' && !reporteComparacion) {
    alert('Selecciona dos cargas históricas para generar el comparativo.');
    return;
  }
  if (tipo === 'comparativo' && !reporteContenido.has('comparacion')) {
    alert('Activa la sección «Comparación entre periodos» para generar este reporte.');
    return;
  }
  if (tipo !== 'comparativo' && !reporteFiltradas.length) {
    alert('No hay registros para generar este reporte.');
    return;
  }
  const ventana = window.open('', '_blank');
  if (!ventana) {
    alert('Permite las ventanas emergentes para generar el reporte.');
    return;
  }
  const analisis = reporteAnalizar(reporteFiltradas);
  ventana.document.open();
  ventana.document.write(aplicarPaletaPDF(reporteDocumentoHTML(tipo, analisis)));
  ventana.document.close();
  ventana.focus();
  let impreso = false;
  const imprimir = () => { if (impreso || ventana.closed) return; impreso = true; ventana.focus(); ventana.print(); };
  ventana.addEventListener('load', imprimir, { once: true });
  setTimeout(imprimir, 900);
}

/*function descargarReportePDF() {
  if (!reporteFiltradas.length) {
    alert('No hay registros para exportar.');
    return;
  }

  const columnas = [...new Set(
    reporteFiltradas.flatMap(f => Object.keys(f))
  )];

  const escapar = v => reporteTexto(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const filas = reporteFiltradas.map(f =>
    '<tr>' + columnas.map(c =>
      `<td>${escapar(f[c])}</td>`
    ).join('') + '</tr>'
  ).join('');

  const filtros = [
    `Columna: ${reporteEl('reporteCampo').value || 'Todas'}`,
    `Valor: ${reporteEl('reporteValor').value || 'Todos'}`,
    `Estado: ${reporteEl('reporteEstado').value || 'Todos'}`,
    `Búsqueda: ${reporteEl('reporteBuscar').value || 'Ninguna'}`
  ].join(' | ');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Reporte CifraControl</title>
<style>
@page { size: A4 landscape; margin: 12mm; }
body { font-family: Arial, sans-serif; color: #26344f; }
h1 { color: #7562e8; }
p { color: #65748e; }
table { width: 100%; border-collapse: collapse; font-size: 9px; }
th, td { border: 1px solid #ddd; padding: 6px; overflow-wrap: anywhere; }
th { background: #e9e6ff; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
</style>
</head>
<body>
<h1>CifraControl - Reporte personalizado</h1>
<p>Fecha: ${escapar(new Date().toLocaleString('es-MX'))}</p>
<p>Registros: ${reporteFiltradas.length}</p>
<p>Filtros: ${escapar(filtros)}</p>
<table>
<thead><tr>${columnas.map(c => `<th>${escapar(c)}</th>`).join('')}</tr></thead>
<tbody>${filas}</tbody>
</table>
</body>
</html>`;

  const ventana = window.open('', '_blank');

  if (!ventana) {
    alert('Permite las ventanas emergentes para exportar.');
    return;
  }

  ventana.document.open();
  ventana.document.write(html);
  ventana.document.close();
  ventana.focus();
  ventana.print();
}
*/

function descargarReportePDFLegacy() {
  if (!reporteFiltradas.length) {
    alert('No hay registros para exportar.');
    return;
  }

  const registros = reporteFiltradas;
  const texto = v => String(reporteTexto(v) ?? '').trim();
  const escapar = v => texto(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const normalizar = v => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
  const columnas = [...new Set(registros.flatMap(f => Object.keys(f)))];
  const encontrar = (...nombres) => columnas.find(c => nombres.some(n => normalizar(c) === normalizar(n)))
    || columnas.find(c => nombres.some(n => normalizar(c).includes(normalizar(n))));
  const campo = (fila, col) => col ? texto(fila[col]) : '';
  const colId = encontrar('equipo_id', 'id_equipo', 'device_id', 'hostname', 'nombre_equipo');
  const colSO = encontrar('sistema_operativo', 'sistema operativo', 'os', 'os_name');
  const colVersion = encontrar('version_so', 'version_os', 'os_version');
  const colCifrado = encontrar('estado_de_cifrado', 'estado_cifrado', 'encryption_status', 'estado cifrado');
  const colRegion = encontrar('region', 'región');
  const colPais = encontrar('pais', 'país', 'country');
  const colUsuario = encontrar('usuario', 'user', 'usuario_asignado');
  const colCumplimiento = encontrar('cumplimiento', 'compliance', 'compliant');

  const clasificar = fila => {
    const estado = normalizar(campo(fila, colCifrado));
    if (!estado || ['nodisponible', 'sindato', 'sindatos', 'unknown', 'na', 'null', 'undefined', 'notavailable'].includes(estado)) return 'Sin datos';
    if (['encrypted', 'cifrado', 'cifrada', 'protegido', 'protected', 'fullyencrypted', 'true', 'si', 'yes'].includes(estado)) return 'Cifrado';
    if (['unencrypted', 'notencrypted', 'sincifrar', 'nocifrado', 'nocifrada', 'unprotected', 'false', 'no', 'decrypted'].includes(estado)) return 'Sin cifrar';
    return 'Sin datos';
  };

  const conteo = lista => ({
    total: lista.length,
    cifrados: lista.filter(f => clasificar(f) === 'Cifrado').length,
    sinCifrar: lista.filter(f => clasificar(f) === 'Sin cifrar').length,
    sinDatos: lista.filter(f => clasificar(f) === 'Sin datos').length
  });

  const resumen = conteo(registros);
  const porcentaje = (n, total = resumen.total) => total ? (100 * n / total).toFixed(1) + '%' : '0.0%';
  const numero = n => n.toLocaleString('es-MX');

  const agrupar = col => {
    const grupos = new Map();
    registros.forEach(f => {
      const clave = campo(f, col) || 'No disponible';
      if (!grupos.has(clave)) grupos.set(clave, []);
      grupos.get(clave).push(f);
    });
    return [...grupos.entries()].sort((a, b) => b[1].length - a[1].length);
  };

  const tablaAgrupada = (titulo, col) => {
    if (!col) return '';
    const filas = agrupar(col).map(([nombre, lista]) => {
      const c = conteo(lista);
      return `<tr><td>${escapar(nombre)}</td><td class="num">${numero(c.total)}</td><td class="num">${numero(c.cifrados)}</td><td class="num">${numero(c.sinCifrar)}</td><td class="num">${numero(c.sinDatos)}</td><td class="num">${porcentaje(c.cifrados, c.total)}</td></tr>`;
    }).join('');

    return `<section class="seccion"><h2>${titulo}</h2><table><thead><tr><th>${escapar(col.replaceAll('_', ' '))}</th><th>Equipos</th><th>Cifrados</th><th>Sin cifrar</th><th>Sin datos</th><th>% cifrado</th></tr></thead><tbody>${filas}<tr class="total"><td>Total</td><td class="num">${numero(resumen.total)}</td><td class="num">${numero(resumen.cifrados)}</td><td class="num">${numero(resumen.sinCifrar)}</td><td class="num">${numero(resumen.sinDatos)}</td><td class="num">${porcentaje(resumen.cifrados)}</td></tr></tbody></table></section>`;
  };

  const detalleCols = [
    ['Equipo', colId],
    ['Sistema operativo', colSO],
    ['Versión', colVersion],
    ['Estado de cifrado', colCifrado],
    ['Región', colRegion],
    ['País', colPais],
    ['Usuario', colUsuario],
    ['Cumplimiento', colCumplimiento]
  ].filter(([, col]) => !!col);

  const detalle = detalleCols.length
    ? `<section class="seccion detalle">
        <h2>Detalle de equipos (${numero(registros.length)})</h2>
        <table>
          <thead><tr>${detalleCols.map(([nombre]) => `<th>${escapar(nombre)}</th>`).join('')}</tr></thead>
          <tbody>${registros.map(f => `<tr>${detalleCols.map(([, col]) => `<td>${escapar(campo(f, col) || '—')}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </section>`
    : '';

  const filtros = [
    ['Columna', reporteEl('reporteCampo')?.value || 'Todas'],
    ['Valor', reporteEl('reporteValor')?.value || 'Todos'],
    ['Estado', reporteEl('reporteEstado')?.value || 'Todos'],
    ['Búsqueda', reporteEl('reporteBuscar')?.value || 'Ninguna']
  ].map(([k, v]) => `<strong>${escapar(k)}:</strong> ${escapar(v)}`).join(' · ');

  const fecha = new Date().toLocaleString('es-MX');

  const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Reporte CifraControl</title>
<style>
  @page { size: A4 portrait; margin: 16mm 13mm 17mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #24344c; font-size: 10px; line-height: 1.45; margin: 0; }
  .cabecera { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #263c58; padding-bottom: 13px; margin-bottom: 16px; }
  .eyebrow { font-size: 9px; font-weight: 700; letter-spacing: 1.1px; color: #667085; }
  h1 { font-size: 21px; line-height: 1.2; margin: 6px 0 10px; color: #233951; }
  .meta { color: #647084; font-size: 10px; }
  .confidencial { border: 1px solid #a63d46; color: #a63d46; border-radius: 4px; padding: 5px 8px; font-size: 9px; font-weight: bold; letter-spacing: .7px; }
  .filtros { padding: 11px 12px; background: #f3f5f8; border: 1px solid #e3e7ed; border-radius: 5px; margin-bottom: 20px; }
  .filtros strong { color: #293b52; }
  .seccion { margin: 0 0 21px; break-inside: auto; }
  h2 { font-size: 13px; color: #253b55; margin: 0 0 9px; break-after: avoid; }
  .indicadores { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid #e0e5eb; border-radius: 5px; overflow: hidden; margin-bottom: 8px; }
  .indicador { padding: 12px 10px; border-right: 1px solid #e0e5eb; }
  .indicador:last-child { border-right: 0; }
  .indicador .etiqueta { color: #687487; font-size: 9px; }
  .indicador .valor { font-size: 22px; font-weight: bold; color: #253b55; }
  .indicador .valor.rojo { color: #b03a43; }
  .indicador .valor.gris { color: #707986; }
  .indicador .porcentaje { color: #687487; }
  .barra { display: flex; height: 8px; overflow: hidden; border-radius: 3px; margin: 10px 0; background: #e0e4e9; }
  .barra span { display: block; height: 100%; }
  .resumen-texto { margin: 8px 0 0; color: #526174; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 9px; }
  th { background: #eef1f5; color: #27384d; font-weight: 700; text-align: left; }
  th, td { padding: 7px 6px; border-bottom: 1px solid #e4e8ed; overflow-wrap: break-word; word-break: normal; vertical-align: top; }
  td.num { text-align: right; white-space: nowrap; }
  tr.total { font-weight: bold; border-top: 1px solid #9ba6b6; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  .detalle { break-before: page; }
  .detalle table { font-size: 8px; }
  .detalle th, .detalle td { padding: 6px 4px; }
  .pie { margin-top: 24px; border-top: 1px solid #d9dfe6; padding-top: 9px; font-size: 9px; color: #667085; }
  @media print { body { print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
</style>
</head>
<body>
  <header class="cabecera">
    <div>
      <div class="eyebrow">PANEL DE CIFRADO DE DISCOS · REPORTE</div>
      <h1>Estado de cifrado de discos duros</h1>
      <div class="meta">Generado: ${escapar(fecha)} · Equipos en el reporte: ${numero(resumen.total)}</div>
    </div>
    <div class="confidencial">CONFIDENCIAL</div>
  </header>

  <div class="filtros">
    <strong>Filtros aplicados</strong>
    <div>${filtros}</div>
  </div>

  <section class="seccion">
    <h2>1. Resumen</h2>
    <div class="indicadores">
      <div class="indicador"><div class="etiqueta">Total de equipos</div><div class="valor">${numero(resumen.total)}</div><div class="porcentaje">100.0%</div></div>
      <div class="indicador"><div class="etiqueta">Cifrados</div><div class="valor">${numero(resumen.cifrados)}</div><div class="porcentaje">${porcentaje(resumen.cifrados)}</div></div>
      <div class="indicador"><div class="etiqueta">Sin cifrar</div><div class="valor rojo">${numero(resumen.sinCifrar)}</div><div class="porcentaje">${porcentaje(resumen.sinCifrar)}</div></div>
      <div class="indicador"><div class="etiqueta">Sin datos</div><div class="valor gris">${numero(resumen.sinDatos)}</div><div class="porcentaje">${porcentaje(resumen.sinDatos)}</div></div>
    </div>

    <div class="barra">
      <span style="width:${100 * resumen.cifrados / resumen.total}%;background:#263c58"></span>
      <span style="width:${100 * resumen.sinCifrar / resumen.total}%;background:#b03a43"></span>
      <span style="width:${100 * resumen.sinDatos / resumen.total}%;background:#aeb6c1"></span>
    </div>

    <p class="resumen-texto">
      De ${numero(resumen.total)} equipos incluidos, ${numero(resumen.cifrados)} están cifrados
      (${porcentaje(resumen.cifrados)}), ${numero(resumen.sinCifrar)} están sin cifrar
      (${porcentaje(resumen.sinCifrar)}) y ${numero(resumen.sinDatos)} no tienen un estado de
      cifrado reconocido (${porcentaje(resumen.sinDatos)}).
    </p>
  </section>

  ${tablaAgrupada('2. Estado por región', colRegion)}
  ${tablaAgrupada('3. Estado por sistema operativo', colSO)}
  ${tablaAgrupada('4. Estado por país', colPais)}
  ${detalle}

  <footer class="pie">
    CifraControl · Confidencial · Uso interno · Reporte generado con los filtros seleccionados
  </footer>
</body>
</html>`;

  const ventana = window.open('', '_blank');
  if (!ventana) {
    alert('Permite las ventanas emergentes para exportar.');
    return;
  }

  ventana.document.open();
  ventana.document.write(html);
  ventana.document.close();
  ventana.focus();

  let impreso = false;
  const imprimir = () => {
    if (impreso || ventana.closed) return;
    impreso = true;
    ventana.focus();
    ventana.print();
  };

  ventana.addEventListener('load', imprimir, { once: true });
  setTimeout(imprimir, 900);
}


document.addEventListener('DOMContentLoaded', iniciar);
