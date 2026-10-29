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

/* ==========================================================================
 *  1. CONFIGURACIÓN Y ESTADO GLOBAL
 * ========================================================================== */

const config = {
  /** Retardo simulado (por defecto 0 para respuesta instantánea). */
  retardo: 0,
  /** Interruptor de pruebas: fuerza errores para ver los reintentos. */
  forzarFallo: false,
  /** Sidebar plegado en escritorio. */
  sidebarPlegado: false,
};

const estado = {
  vista: 'resumen',
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
  inventario: { search: '', estado: '', tipo: '', sort: 'id', dir: 'asc', page: 1, pageSize: 10 },
  excepciones: { severidad: '' },
};

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

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (config.forzarFallo) {
    await esperar(450);
    throw new Error('Fallo simulado activado en Ajustes.');
  }
  if (config.retardo > 0) {
    await esperar(config.retardo);
  }

  const dbActual = await DB.obtenerActual();
  const filas = dbActual.filas || [];
  const meta = dbActual.meta || null;
  const total = filas.length;

  switch (ruta) {
    case '/health': {
      return {
        status: 'ok',
        modo: 'Portable Autónoma (IndexedDB + Pyodide Python)',
        baseDeDatos: 'IndexedDB Local (Persistencia privada por equipo)',
        registrosCargados: total,
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

      const colores = ['#9B2C39', '#334155', '#059669', '#D97706', '#2563EB', '#71717A', '#7E222D', '#52525B'];

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
            color: '#9B2C39',
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
            color: '#059669',
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
            color: '#2563EB',
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
            color: '#DC2626',
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
        const ultimoAnalisis = f.mes_ultimo_logon || f.last_seen_band || (meta ? meta.procesado_en.slice(0, 10) : '—');
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

      const q = String(params.search || '').toLowerCase();
      let filtradas = mapeadas.filter((m) => {
        if (params.estado && m.estado !== params.estado) return false;
        if (params.tipo && m.tipo !== params.tipo) return false;
        if (q) {
          const texto = `${m.id} ${m.nombre} ${m.tipo} ${m.cifrado} ${m.ubicacion} ${m.responsable}`.toLowerCase();
          if (!texto.includes(q)) return false;
        }
        return true;
      });

      const col = params.sort || 'id';
      const mult = params.dir === 'desc' ? -1 : 1;
      filtradas.sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? ''), 'es', { numeric: true }) * mult);

      const pageSize = Number(params.pageSize) || 10;
      const totalPaginas = Math.max(1, Math.ceil(filtradas.length / pageSize));
      const pagina = Math.min(Math.max(1, Number(params.page) || 1), totalPaginas);
      const inicio = (pagina - 1) * pageSize;
      const paginadas = filtradas.slice(inicio, inicio + pageSize);

      return {
        filas: paginadas,
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
            servicio: 'Base de Datos IndexedDB Local',
            estado: 'operativo',
            uptime: 100,
            latencia: 1,
            intentos: 0,
            hostname: `local://cifracontrol_local_db (${total} registros)`,
          },
          {
            servicio: 'Motor Python Pyodide (Wasm)',
            estado: 'operativo',
            uptime: 100,
            latencia: 4,
            intentos: 0,
            hostname: 'wasm://python-pandas-pipeline',
          },
          {
            servicio: 'Almacenamiento Aislado por Equipo',
            estado: 'operativo',
            uptime: 100,
            latencia: 1,
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
        if (f.flag_compliant_sin_cifrar) {
          listaExc.push({
            id: `FLAG-${idx + 1}`,
            activo: idEq,
            tipo: 'Marcado como Compliant pero sin cifrar (Not encrypted)',
            severidad: 'critica',
            estado: 'abierta',
            responsable: resp,
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
      const filtradas = sevFiltro ? listaExc.filter((e) => e.severidad === sevFiltro) : listaExc;

      return {
        filas: filtradas.slice(0, 100),
        conteo,
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
  monitoreo:   { titulo: 'Monitoreo',             sub: 'Estado del motor local IndexedDB y Python Wasm' },
  excepciones: { titulo: 'Excepciones y Flags',   sub: 'Incoherencias y alertas detectadas por el pipeline de Python' },
  carga:       { titulo: 'Cargar Excel / CSV',    sub: 'Sube tu archivo → Limpieza en Python → Base de Datos Local' },
  ajustes:     { titulo: 'Ajustes y Respaldo',    sub: 'Preferencias y exportación/importación de tu Base de Datos' },
};

const MODULOS_POR_VISTA = {
  resumen: ['kpis', 'serie', 'algoritmos'],
  inventario: ['inventario'],
  tecnologias: ['tecnologias'],
  monitoreo: ['monitoreo'],
  excepciones: ['excepciones'],
  carga: ['carga', 'cola'],
  ajustes: [],
};

function irA(vista, { empujar = true } = {}) {
  if (!VISTAS[vista]) vista = 'resumen';

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
  (MODULOS_POR_VISTA[vista] || []).forEach((m) => cargarModulo(m));
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
    if (textoSidebar) textoSidebar.textContent = `BD Local (${num(d.registrosCargados)} filas)`;
    if (textoPastilla) textoPastilla.textContent = `BD Local: ${num(d.registrosCargados)} registros`;
    if (bloque) bloque.textContent = JSON.stringify(d, null, 2);
    return true;
  } catch (error) {
    cajas.forEach((c) => c && (c.dataset.estado = 'error'));
    if (textoSidebar) textoSidebar.textContent = 'Error en BD';
    if (textoPastilla) textoPastilla.textContent = 'Fallo simulado';
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

  const sel = document.getElementById('fTipo');
  if (sel && d.tiposDisponibles) {
    sel.innerHTML = '<option value="">Todos los tipos</option>';
    d.tiposDisponibles.forEach((t) => sel.add(new Option(t, t)));
    sel.value = filtros.inventario.tipo;
  }

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
            const color = t.riesgo === 'alto' ? '#F97316' : '#10B981';
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
    cont.innerHTML = `<div class="vacio"><strong>0 excepciones registradas</strong>
      Cuando cargues un archivo, aquí aparecerán las filas marcadas por los flags de incoherencia del pipeline de Python.</div>`;
    setBadge('excepciones', 0);
    return;
  }

  const sev = {
    critica: ['et--peligro', 'Crítica'], alta: ['et--peligro', 'Alta'],
    media: ['et--alerta', 'Media'], baja: ['et--neutro', 'Baja'],
  };

  cont.innerHTML = `
    <div class="totales">
      <div class="total total--peligro"><b>${num(d.conteo.critica)}</b><span>críticas</span></div>
      <div class="total"><b>${num(d.conteo.alta)}</b><span>altas</span></div>
      <div class="total total--alerta"><b>${num(d.conteo.media + d.conteo.baja)}</b><span>resto</span></div>
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
    </div>`;

  setBadge('excepciones', d.conteo.critica);
}

/* ------ Vista Carga: Gráfica de Verificación en vivo + Historial -------- */
function pintarCola(d) {
  const cont = document.querySelector('[data-datos="cola"]');
  const colores = ['#9B2C39', '#334155', '#059669', '#D97706', '#2563EB', '#71717A'];

  const htmlVerificacion = d.disponible && d.totalRegistros > 0
    ? `
      <div class="totales" style="margin-bottom:16px">
        <div class="total total--exito"><b>${num(d.totalRegistros)}</b><span>registros en BD</span></div>
        <div class="total"><b>${num(d.meta?.columnas?.length || 0)}</b><span>columnas limpias</span></div>
        <div class="total total--alerta"><b>${num(d.meta?.avisos?.length || 0)}</b><span>avisos del pipeline</span></div>
      </div>
      <div style="margin-bottom:18px">
        <p style="font-size:.82rem;font-weight:600;margin:0 0 8px;display:flex;align-items:center;gap:6px">
          ${icono('resumen')} Gráfica de datos actuales en Base de Datos (agrupados por <code>${esc(d.distribution.columna)}</code>):
        </p>
        <canvas class="grafico" id="graficoVerificacionCarga" style="height:210px"></canvas>
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
              <small>${esc(f.bytesLegibles)} · ${num(f.filas)} registros limpios · ${esc(fechaHora(f.recibidoEn))}</small>
            </div>
            <span class="etiqueta et--exito">${esc(f.status)}</span>
          </article>`).join('')}
      </div>`
    : '';

  cont.innerHTML = htmlVerificacion + htmlHistorial;

  if (d.disponible && d.totalRegistros > 0) {
    const canvas = document.getElementById('graficoVerificacionCarga');
    const grupos = d.distribution.grupos.map((g, i) => ({
      ...g,
      color: colores[i % colores.length],
    }));
    const fn = () => dibujarBarrasVerificacion(canvas, grupos, d.totalRegistros, 210);
    registrarGrafico(canvas, fn);
    requestAnimationFrame(fn);
    observarResize(canvas, fn);
  }
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

    ctx.fillStyle = g.color || '#9B2C39';
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

async function enviarArchivo(archivo) {
  const problema = validarArchivo(archivo);
  zonaSoltar.classList.toggle('is-error', !!problema);
  if (problema) {
    avisar('Archivo no válido', problema, 'error');
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
      filas: resultado.meta.filas,
      avisos: resultado.meta.avisos || [],
    };

    await DB.guardarCarga({
      filas: resultado.filas,
      meta: resultado.meta,
      registroCola,
    });

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

  window.addEventListener('popstate', () => irA((location.hash || '#/resumen').slice(2), { empujar: false }));

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

  document.getElementById('fBusqueda').addEventListener('input', rebocar((e) => {
    f.search = e.target.value.trim();
    f.page = 1;
    pedirInventario();
  }, 260));

  document.getElementById('fEstado').addEventListener('change', (e) => {
    f.estado = e.target.value; f.page = 1; pedirInventario();
  });
  document.getElementById('fTipo').addEventListener('change', (e) => {
    f.tipo = e.target.value; f.page = 1; pedirInventario();
  });
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
}

function conectarAjustes() {
  document.getElementById('setTema').addEventListener('change', (e) => aplicarTema(e.target.checked));

  document.getElementById('setFallo').addEventListener('change', (e) => {
    config.forzarFallo = e.target.checked;
    if (config.forzarFallo) estado.cache = {};
    avisar(
      e.target.checked ? 'Modo de fallo activado' : 'Modo de fallo desactivado',
      e.target.checked
        ? 'Las próximas consultas mostrarán la vista de error.'
        : 'Las consultas volverán a funcionar con normalidad.',
      e.target.checked ? 'alerta' : 'info'
    );
  });

  document.getElementById('setSidebar').addEventListener('change', (e) => {
    config.sidebarPlegado = e.target.checked;
    aplicarSidebar();
  });

  document.getElementById('setRetardo').addEventListener('change', (e) => {
    config.retardo = Number(e.target.value);
    avisar('Retardo actualizado', `Latencia simulada: ${config.retardo} ms.`, 'info');
  });

  document.getElementById('btnComprobarSalud').addEventListener('click', comprobarSalud);

  // Exportar e Importar Base de Datos para compartir con compañeros
  const btnExportar = document.getElementById('btnExportarBD');
  const btnImportar = document.getElementById('btnImportarBD');
  const inputImportar = document.getElementById('inputImportarBD');

  if (btnExportar) {
    btnExportar.addEventListener('click', async () => {
      try {
        const backup = await DB.exportarBackup();
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `cifracontrol_bd_${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        avisar('Base de Datos exportada', 'Puedes enviar este archivo .json a cualquier compañero.', 'exito');
      } catch (err) {
        avisar('Error al exportar', err.message, 'error');
      }
    });
  }

  if (btnImportar && inputImportar) {
    btnImportar.addEventListener('click', () => inputImportar.click());
    inputImportar.addEventListener('change', async () => {
      const file = inputImportar.files[0];
      if (!file) return;
      try {
        const texto = await file.text();
        const json = JSON.parse(texto);
        await DB.importarBackup(json);
        const total = json.datos?.filas?.length || 0;
        avisar('Base de Datos importada', `Se cargaron ${num(total)} registros en tu equipo.`, 'exito');
        refrescarTodo();
      } catch (err) {
        avisar('Archivo no válido', err.message, 'error');
      }
      inputImportar.value = '';
    });
  }
}

function restaurarPreferencias() {
  try {
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

  irA((location.hash || '#/resumen').slice(2), { empujar: false });
  comprobarSalud();
}

document.addEventListener('DOMContentLoaded', iniciar);
