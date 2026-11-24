/* ============================================================================
 *  CifraControl · Motor de Base de Datos Local Cifrada (Zero-Knowledge IndexedDB)
 * ============================================================================
 *  - Todos los datos en disco se almacenan cifrados con AES-GCM-256 + AAD usando
 *    la CryptoKey derivada en RAM por Vault (PBKDF2 600,000 iteraciones).
 *  - Consolidación inteligente entre lotes: actualiza registros con el mismo
 *    equipo_id al cargar nuevos cortes mensuales sin inflar los KPIs.
 * ========================================================================== */

'use strict';

const DB = (() => {
  const DB_NAME = 'cifracontrol_zk_vault_db';
  const DB_VERSION = 2;
  const STORE_META = '__vault_meta__';
  const STORE_DATOS = 'dataset_actual';
  const STORE_HISTORIAL = 'historial_cargas';
  const INDICE_KEY = '__indice__';
  const MAX_AVISOS_ACUMULADOS = 100;

  let dbInstance = null;
  let cacheActual = null;
  let vueloActual = null;
  let colaEscritura = Promise.resolve();
  const CLAVES_PROHIBIDAS = new Set(['__proto__', 'constructor', 'prototype']);

  function generarIdSeguro(prefijo = 'id') {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return `${prefijo}-${window.crypto.randomUUID()}`;
    }
    const rnd = CryptoEngine.generarBytesAleatorios(8);
    const hex = Array.from(rnd, (b) => b.toString(16).padStart(2, '0')).join('');
    return `${prefijo}-${Date.now()}-${hex}`;
  }

  function sanitizarFilas(filas) {
    if (!Array.isArray(filas)) return [];
    const limpias = [];
    for (let i = 0; i < filas.length; i++) {
      const f = filas[i];
      if (!f || typeof f !== 'object' || Array.isArray(f)) continue;
      const obj = {};
      const keys = Object.keys(f);
      for (let j = 0; j < keys.length; j++) {
        const k = keys[j];
        if (!CLAVES_PROHIBIDAS.has(k)) obj[k] = f[k];
      }
      limpias.push(obj);
    }
    return limpias;
  }

  function invalidarCacheActual() {
    cacheActual = null;
    vueloActual = null;
  }

  if (typeof Vault !== 'undefined' && typeof Vault.suscribir === 'function') {
    Vault.suscribir((evento) => {
      if (evento === 'LOCKED' || evento === 'DATA_UPDATED') {
        invalidarCacheActual();
      }
    });
  }

  /** Extrae la llave primaria de un equipo/hallazgo si existe, o null si no aplica. */
  function clavePrimariaFila(fila) {
    if (!fila || typeof fila !== 'object') return null;
    const raw = fila.equipo_id ?? fila.finding_id ?? null;
    if (raw === null || raw === undefined) return null;
    const limpio = String(raw).trim().toUpperCase();
    if (!limpio || limpio === 'NO DISPONIBLE' || limpio === 'N/A' || limpio === 'NULL') {
      return null;
    }
    return limpio;
  }

  /**
   * Consolida múltiples lotes ordenados cronológicamente (del más antiguo al más reciente).
   * Si un equipo_id vuelve a aparecer en un lote más reciente (ej. nuevo corte mensual),
   * prevalece el estado del lote más reciente sin duplicar el equipo en los KPIs,
   * conservando intactas todas las filas dentro de un mismo lote.
   */
  function consolidarFilasDeLotes(lotesDescifrados) {
    const lotesValidos = lotesDescifrados.filter(
      (lote) => lote && Array.isArray(lote.filas) && lote.filas.length > 0
    );
    if (!lotesValidos.length) return { filas: [], reemplazados: 0 };
    if (lotesValidos.length === 1) {
      return { filas: lotesValidos[0].filas.slice(), reemplazados: 0 };
    }

    // Mapa de cuál es el índice del último lote en que aparece cada clave primaria
    const ultimoLotePorClave = new Map();
    for (let idxLote = 0; idxLote < lotesValidos.length; idxLote++) {
      const filasLote = lotesValidos[idxLote].filas;
      for (let i = 0; i < filasLote.length; i++) {
        const pk = clavePrimariaFila(filasLote[i]);
        if (pk !== null) {
          ultimoLotePorClave.set(pk, idxLote);
        }
      }
    }

    const filasConsolidadas = [];
    let reemplazados = 0;
    for (let idxLote = 0; idxLote < lotesValidos.length; idxLote++) {
      const filasLote = lotesValidos[idxLote].filas;
      for (let i = 0; i < filasLote.length; i++) {
        const fila = filasLote[i];
        const pk = clavePrimariaFila(fila);
        if (pk !== null && ultimoLotePorClave.get(pk) !== idxLote) {
          reemplazados++;
          continue;
        }
        filasConsolidadas.push(fila);
      }
    }

    return { filas: filasConsolidadas, reemplazados };
  }

  /** Abre o inicializa el esquema IndexedDB con el almacén de metadatos criptográficos. */
  function abrir() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_DATOS)) {
          db.createObjectStore(STORE_DATOS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_HISTORIAL)) {
          db.createObjectStore(STORE_HISTORIAL, { keyPath: 'id' });
        }
      };

      req.onsuccess = (e) => {
        dbInstance = e.target.result;
        resolve(dbInstance);
      };

      req.onerror = () => {
        reject(new Error('No se pudo abrir la base de datos local (IndexedDB).'));
      };
    });
  }

  function estaBloqueada() {
    return !Vault.estaDesbloqueada();
  }

  function obtenerRol() {
    return Vault.obtenerRol();
  }

  function esAdmin() {
    return Vault.esAdmin();
  }

  async function tieneBovedaConfigurada() {
    const db = await abrir();
    return Vault.existeBoveda(db);
  }

  async function crearBoveda(password, opciones = {}) {
    const db = await abrir();
    return Vault.inicializarBoveda(db, password, opciones);
  }

  async function desbloquearBoveda(password) {
    const db = await abrir();
    return Vault.desbloquear(db, password);
  }

  async function infoCriptografica() {
    const db = await abrir();
    const meta = await Vault.obtenerMetaBoveda(db);
    return {
      bovedaConfigurada: Boolean(meta),
      desbloqueadaEnRAM: Vault.estaDesbloqueada(),
      rolActivo: Vault.obtenerRol(),
      algoritmo: meta?.algoritmo || 'AES-GCM-256 / PBKDF2-HMAC-SHA256',
      iteracionesPBKDF2: meta?.iterations || CryptoEngine.PBKDF2_ITERATIONS,
      longitudIV: '12 bytes (96 bits)',
      longitudSalt: '16 bytes (128 bits)',
      aadActivo: meta?.aadVersion === 1,
      creadoEn: meta?.creadoEn || null,
    };
  }

  function combinarMetas(metaPrevia, metaNueva, totalFilas, reemplazados = 0) {
    if (!metaPrevia && !metaNueva) return null;
    const colsPrevias = Array.isArray(metaPrevia?.columnas) ? metaPrevia.columnas : [];
    const colsNuevas = Array.isArray(metaNueva?.columnas) ? metaNueva.columnas : [];
    const avisosPrevios = Array.isArray(metaPrevia?.avisos) ? metaPrevia.avisos : [];
    const avisosNuevos = Array.isArray(metaNueva?.avisos) ? metaNueva.avisos : [];
    const avisosUnicos = Array.from(new Set([...avisosPrevios, ...avisosNuevos])).slice(0, MAX_AVISOS_ACUMULADOS);
    return {
      ...(metaPrevia || {}),
      ...(metaNueva || {}),
      filas: totalFilas,
      reemplazadosPorActualizacion: reemplazados,
      columnas: metaPrevia ? Array.from(new Set([...colsPrevias, ...colsNuevas])) : colsNuevas,
      avisos: metaPrevia ? avisosUnicos : avisosNuevos.slice(0, MAX_AVISOS_ACUMULADOS),
    };
  }

  /**
   * Guarda el resultado limpio CIFRADO con AES-GCM-256 en IndexedDB por lotes.
   * Conserva cada lote intacto para el historial y las comparativas mensuales,
   * y consolida el dataset activo por `equipo_id` (prevalece el corte más reciente).
   * Restringido al rol 'admin'.
   */
  async function guardarCarga({ filas, meta, registroCola }) {
    if (!Vault.esAdmin()) {
      throw new Error('Acceso denegado: sólo el rol Administrador puede procesar e ingestar archivos Excel/CSV originales.');
    }

    const tarea = colaEscritura.then(async () => {
      const db = await abrir();
      const nuevasFilas = sanitizarFilas(filas);
      const loteId = registroCola?.id ? `lote-${registroCola.id}` : generarIdSeguro('lote');

      let indice = await SecureDB.getDecrypted(db, STORE_DATOS, INDICE_KEY);
      let tienePrevio = Boolean(indice && Array.isArray(indice.lotes) && indice.lotes.length);

      if (!tienePrevio) {
        const legacy = await SecureDB.getDecrypted(db, STORE_DATOS, 'vigente');
        if (legacy && Array.isArray(legacy.filas) && legacy.filas.length) {
          indice = {
            lotes: ['vigente'],
            meta: legacy.meta || null,
            totalFilas: legacy.filas.length,
          };
          tienePrevio = true;
        }
      }

      const lotesPrevios = tienePrevio
        ? await Promise.all(indice.lotes.map((id) => SecureDB.getDecrypted(db, STORE_DATOS, id)))
        : [];
      const nuevoLoteObj = {
        filas: nuevasFilas,
        meta: meta || null,
        actualizadoEn: new Date().toISOString(),
      };
      const { filas: filasConsolidadas, reemplazados } = consolidarFilasDeLotes([
        ...lotesPrevios,
        nuevoLoteObj,
      ]);

      const lotes = tienePrevio ? [...indice.lotes, loteId] : [loteId];
      const totalFilas = filasConsolidadas.length;
      const metaCombinada = combinarMetas(tienePrevio ? indice.meta : null, meta, totalFilas, reemplazados);
      const ahoraIso = nuevoLoteObj.actualizadoEn;

      const escrituras = [
        {
          storeName: STORE_DATOS,
          keyId: loteId,
          data: nuevoLoteObj,
        },
        {
          storeName: STORE_DATOS,
          keyId: INDICE_KEY,
          data: {
            lotes,
            meta: metaCombinada,
            totalFilas,
            actualizadoEn: ahoraIso,
          },
        },
      ];

      if (registroCola && registroCola.id) {
        const copiaCola = { ...registroCola };
        delete copiaCola.filas; // Evita duplicar filas en STORE_HISTORIAL; se hidratan desde loteId
        escrituras.push({
          storeName: STORE_HISTORIAL,
          keyId: registroCola.id,
          data: {
            ...copiaCola,
            loteId,
            meta: meta || null,
            esSnapshot: true,
          },
        });
      }

      await SecureDB.escribirTransaccionCifrada(db, { escrituras });

      cacheActual = {
        disponible: filasConsolidadas.length > 0,
        filas: filasConsolidadas,
        meta: metaCombinada,
      };
      Vault.publicarEventoPestanas?.('DATA_UPDATED', { origen: 'CARGA' });

      return {
        concatenado: tienePrevio,
        filasAgregadas: nuevasFilas.length,
        reemplazados,
        totalFilas,
      };
    });

    colaEscritura = tarea.catch(() => {});
    return tarea;
  }

  /**
   * Lee y descifra en RAM el dataset actual desde IndexedDB consolidando todos los lotes
   * (mantiene el registro más reciente por EquipoID sin alterar el historial).
   */
  async function obtenerActual() {
    if (!Vault.estaDesbloqueada()) {
      invalidarCacheActual();
      return { disponible: false, filas: [], meta: null, bloqueada: true };
    }
    if (cacheActual) return cacheActual;
    if (vueloActual) return vueloActual;

    vueloActual = (async () => {
      const db = await abrir();
      const indice = await SecureDB.getDecrypted(db, STORE_DATOS, INDICE_KEY);

      if (indice && Array.isArray(indice.lotes) && indice.lotes.length) {
        const lotesDescifrados = await Promise.all(
          indice.lotes.map((id) => SecureDB.getDecrypted(db, STORE_DATOS, id))
        );
        const { filas, reemplazados } = consolidarFilasDeLotes(lotesDescifrados);
        const metaFinal = indice.meta
          ? { ...indice.meta, filas: filas.length, reemplazadosPorActualizacion: reemplazados }
          : null;
        cacheActual = filas.length
          ? { disponible: true, filas, meta: metaFinal }
          : { disponible: false, filas: [], meta: null };
        return cacheActual;
      }

      const res = await SecureDB.getDecrypted(db, STORE_DATOS, 'vigente');
      if (!res || !res.filas || !res.filas.length) {
        cacheActual = { disponible: false, filas: [], meta: null };
        return cacheActual;
      }
      cacheActual = { disponible: true, filas: res.filas, meta: res.meta };
      return cacheActual;
    })();

    try {
      return await vueloActual;
    } finally {
      vueloActual = null;
    }
  }

  /**
   * Lista y descifra el historial de cargas realizadas en este equipo.
   * Por defecto devuelve sólo metadatos ligeros; pasar `{ incluirFilas: true }` para hidratar filas.
   */
  async function listarHistorial(opciones = {}) {
    if (!Vault.estaDesbloqueada()) return [];
    const db = await abrir();
    const items = await SecureDB.getAllDecrypted(db, STORE_HISTORIAL);
    items.sort((a, b) => new Date(b.recibidoEn || 0) - new Date(a.recibidoEn || 0));

    if (!opciones.incluirFilas) {
      return items;
    }

    const cacheLotes = new Map();
    await Promise.all(items.map(async (item) => {
      if (Array.isArray(item.filas) && item.filas.length) return;
      if (!item.loteId) return;
      if (!cacheLotes.has(item.loteId)) {
        cacheLotes.set(item.loteId, SecureDB.getDecrypted(db, STORE_DATOS, item.loteId));
      }
      const lote = await cacheLotes.get(item.loteId);
      if (lote && Array.isArray(lote.filas)) {
        item.filas = lote.filas;
      }
    }));

    return items;
  }

  async function obtenerHistorial(id) {
    if (!Vault.estaDesbloqueada() || !id) return null;
    const db = await abrir();
    const item = await SecureDB.getDecrypted(db, STORE_HISTORIAL, id);
    if (!item) return null;
    if ((!Array.isArray(item.filas) || !item.filas.length) && item.loteId) {
      const lote = await SecureDB.getDecrypted(db, STORE_DATOS, item.loteId);
      if (lote && Array.isArray(lote.filas)) {
        item.filas = lote.filas;
      }
    }
    return item;
  }

  async function guardarHistorial(registro) {
    if (!Vault.esAdmin() || !registro?.id) {
      throw new Error('No se pudo guardar el snapshot histórico.');
    }
    const db = await abrir();
    await SecureDB.setEncrypted(db, STORE_HISTORIAL, registro.id, {
      ...registro,
      esSnapshot: true,
    });
    return true;
  }

  async function asegurarActualEnHistorial(actual) {
    if (!Vault.estaDesbloqueada() || !Vault.esAdmin() || !actual?.filas?.length) return false;
    const historial = await listarHistorial();
    if (historial.some((item) => item.esSnapshot)) return false;

    const db = await abrir();
    const indice = await SecureDB.getDecrypted(db, STORE_DATOS, INDICE_KEY);
    const ultimoLoteId = indice?.lotes?.[indice.lotes.length - 1] || null;
    const procesadoEn = actual.meta?.procesado_en || actual.meta?.procesadoEn || '';
    const id = `hist-actual-${procesadoEn || Date.now()}`;

    const payload = {
      id,
      archivo: actual.meta?.archivo_origen || 'Carga actual',
      recibidoEn: actual.meta?.procesado_en || new Date().toISOString(),
      fechaCorte: actual.meta?.fecha_corte || actual.meta?.fechaCorte || null,
      filasTotal: actual.filas.length,
      meta: actual.meta || null,
      status: 'procesado',
    };
    if (ultimoLoteId) {
      payload.loteId = ultimoLoteId;
    } else {
      payload.filas = actual.filas;
    }
    await guardarHistorial(payload);
    return true;
  }

  async function limpiarStoresDatos() {
    invalidarCacheActual();
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DATOS, STORE_HISTORIAL], 'readwrite');
      tx.objectStore(STORE_DATOS).clear();
      tx.objectStore(STORE_HISTORIAL).clear();
      tx.oncomplete = () => {
        Vault.publicarEventoPestanas?.('DATA_UPDATED', { origen: 'VACIAR' });
        resolve(true);
      };
      tx.onerror = () => reject(new Error('No se pudo limpiar la base de datos.'));
    });
  }

  async function vaciar() {
    if (!Vault.esAdmin()) {
      throw new Error('Acceso denegado: sólo el rol Administrador puede vaciar la base de datos.');
    }
    return limpiarStoresDatos();
  }

  async function restablecerFabrica() {
    invalidarCacheActual();
    const db = await abrir();
    Vault.bloquear('FACTORY_RESET');
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META, STORE_DATOS, STORE_HISTORIAL], 'readwrite');
      tx.objectStore(STORE_META).clear();
      tx.objectStore(STORE_DATOS).clear();
      tx.objectStore(STORE_HISTORIAL).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('No se pudo restablecer la bóveda de fábrica.'));
    });
  }

  /**
   * Exporta el respaldo 100% CIFRADO con AES-GCM-256 usando una contraseña de transporte.
   * Evita duplicar filas cuando un snapshot histórico ya apunta a un lote exportado.
   */
  async function exportarBackup(passwordTransporte) {
    const db = await abrir();
    const actual = await obtenerActual();
    const indice = await SecureDB.getDecrypted(db, STORE_DATOS, INDICE_KEY);
    const lotesMap = {};
    if (indice && Array.isArray(indice.lotes)) {
      const lotesLeidos = await Promise.all(
        indice.lotes.map(async (id) => [id, await SecureDB.getDecrypted(db, STORE_DATOS, id)])
      );
      for (const [id, l] of lotesLeidos) {
        if (l && Array.isArray(l.filas)) {
          lotesMap[id] = l;
        }
      }
    }
    const historial = await listarHistorial({ incluirFilas: false });
    const objetoPlano = {
      version: 3,
      exportadoEn: new Date().toISOString(),
      app: 'FEMSA CifraControl Zero-Knowledge',
      datos: actual,
      lotes: Object.keys(lotesMap).length ? lotesMap : null,
      historial,
    };
    return CryptoEngine.cifrarPaqueteTransporte(objetoPlano, passwordTransporte);
  }

  /**
   * Descifra en memoria RAM un paquete .enc.json usando la contraseña de transporte,
   * valida que contenga registros reales antes de tocar la BD e inmediatamente lo
   * recifra en una sola transacción atómica.
   */
  async function importarBackup(paqueteCifrado, passwordTransporte) {
    if (!Vault.estaDesbloqueada()) {
      throw new Error('Debes desbloquear la bóveda antes de importar un respaldo.');
    }
    const contenido = await CryptoEngine.descifrarPaqueteTransporte(paqueteCifrado, passwordTransporte);
    if (!contenido || typeof contenido !== 'object' || !contenido.datos || typeof contenido.datos !== 'object') {
      throw new Error('El paquete descifrado no contiene una estructura válida de CifraControl.');
    }

    const filasLimpias = sanitizarFilas(contenido.datos.filas);
    const lotesImportados = contenido.lotes && typeof contenido.lotes === 'object' && !Array.isArray(contenido.lotes)
      ? contenido.lotes
      : null;
    const tieneLotesValidos = lotesImportados && Object.values(lotesImportados).some(
      (l) => l && Array.isArray(l.filas) && l.filas.length > 0
    );
    const tieneHistorialConFilas = Array.isArray(contenido.historial) && contenido.historial.some(
      (h) => h && Array.isArray(h.filas) && h.filas.length > 0
    );

    if (!filasLimpias.length && !tieneLotesValidos && !tieneHistorialConFilas) {
      throw new Error('El paquete cifrado está vacío (0 registros). Se canceló la importación para proteger tus datos actuales.');
    }

    const db = await abrir();
    const ahoraIso = new Date().toISOString();
    const escrituras = [];
    const lotesIds = [];

    if (tieneLotesValidos) {
      for (const [loteId, loteObj] of Object.entries(lotesImportados)) {
        if (!loteId || CLAVES_PROHIBIDAS.has(loteId) || !loteObj || !Array.isArray(loteObj.filas)) continue;
        const fLimpias = sanitizarFilas(loteObj.filas);
        if (!fLimpias.length) continue;
        lotesIds.push(loteId);
        escrituras.push({
          storeName: STORE_DATOS,
          keyId: loteId,
          data: {
            filas: fLimpias,
            meta: loteObj.meta || null,
            actualizadoEn: loteObj.actualizadoEn || ahoraIso,
          },
        });
      }
    } else if (filasLimpias.length) {
      const loteId = generarIdSeguro('lote-import');
      lotesIds.push(loteId);
      escrituras.push({
        storeName: STORE_DATOS,
        keyId: loteId,
        data: {
          filas: filasLimpias,
          meta: contenido.datos.meta || null,
          actualizadoEn: ahoraIso,
        },
      });
    }

    if (lotesIds.length) {
      escrituras.push({
        storeName: STORE_DATOS,
        keyId: INDICE_KEY,
        data: {
          lotes: lotesIds,
          meta: contenido.datos.meta || null,
          totalFilas: filasLimpias.length,
          actualizadoEn: ahoraIso,
        },
      });
    }

    if (Array.isArray(contenido.historial)) {
      for (const h of contenido.historial) {
        if (h && typeof h === 'object' && typeof h.id === 'string' && !CLAVES_PROHIBIDAS.has(h.id)) {
          const hCopia = { ...h };
          if (Array.isArray(hCopia.filas) && hCopia.filas.length) {
            const fHist = sanitizarFilas(hCopia.filas);
            if (!hCopia.loteId || !lotesIds.includes(hCopia.loteId)) {
              const histLoteId = hCopia.loteId && !CLAVES_PROHIBIDAS.has(hCopia.loteId)
                ? hCopia.loteId
                : `lote-${hCopia.id}`;
              escrituras.push({
                storeName: STORE_DATOS,
                keyId: histLoteId,
                data: {
                  filas: fHist,
                  meta: hCopia.meta || null,
                  actualizadoEn: hCopia.recibidoEn || ahoraIso,
                },
              });
              hCopia.loteId = histLoteId;
            }
            delete hCopia.filas;
          }
          escrituras.push({
            storeName: STORE_HISTORIAL,
            keyId: hCopia.id,
            data: hCopia,
          });
        }
      }
    }

    await SecureDB.escribirTransaccionCifrada(db, {
      limpiarStores: [STORE_DATOS, STORE_HISTORIAL],
      escrituras,
    });

    invalidarCacheActual();
    Vault.publicarEventoPestanas?.('DATA_UPDATED', { origen: 'IMPORT' });
    return filasLimpias.length;
  }

  async function leerTodosCrudos(db, storeName) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error(`Error al leer ${storeName}.`));
    });
  }

  async function cambiarPassword(passActual, passNueva) {
    const db = await abrir();
    return Vault.cambiarPassword(db, passActual, passNueva, async (oldKey, newKey, nuevoConfig) => {
      const porGuardar = {
        [STORE_DATOS]: [],
        [STORE_HISTORIAL]: [],
      };
      for (const storeName of [STORE_DATOS, STORE_HISTORIAL]) {
        const crudos = await leerTodosCrudos(db, storeName);
        for (const rec of crudos) {
          if (!rec || !rec.iv || !rec.ciphertext) continue;
          const aadViejo = rec.aadVersion === 1 ? `${storeName}:${rec.id}` : null;
          const aadNuevo = `${storeName}:${rec.id}`;
          let plano;
          try {
            plano = await CryptoEngine.descifrarPayload(oldKey, rec.iv, rec.ciphertext, aadViejo);
          } catch {
            throw new Error(`Fallo de integridad al recifrar el registro ${rec.id} en ${storeName}. Operación abortada.`);
          }
          const { iv, ciphertext } = await CryptoEngine.cifrarPayload(newKey, plano, aadNuevo);
          porGuardar[storeName].push({
            ...rec,
            iv,
            ciphertext,
            aadVersion: 1,
            updatedAt: new Date().toISOString(),
          });
        }
      }
      await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_META, STORE_DATOS, STORE_HISTORIAL], 'readwrite');
        tx.objectStore(STORE_META).put(nuevoConfig);
        porGuardar[STORE_DATOS].forEach((r) => tx.objectStore(STORE_DATOS).put(r));
        porGuardar[STORE_HISTORIAL].forEach((r) => tx.objectStore(STORE_HISTORIAL).put(r));
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(new Error('Error transaccional al rotar la clave maestra.'));
      });
    });
  }

  return Object.freeze({
    abrir,
    estaBloqueada,
    obtenerRol,
    esAdmin,
    tieneBovedaConfigurada,
    crearBoveda,
    desbloquearBoveda,
    cambiarPassword,
    infoCriptografica,
    guardarCarga,
    obtenerActual,
    listarHistorial,
    obtenerHistorial,
    guardarHistorial,
    asegurarActualEnHistorial,
    vaciar,
    restablecerFabrica,
    exportarBackup,
    importarBackup,
  });
})();
