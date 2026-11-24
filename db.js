/* ============================================================================
 *  CifraControl · Motor de Base de Datos Local Cifrada (Zero-Knowledge IndexedDB)
 * ============================================================================
 *  - Todos los datos en disco se almacenan cifrados con AES-GCM-256 usando
 *    la CryptoKey derivada en RAM por Vault (PBKDF2 250,000 iteraciones).
 *  - Si alguien inspecciona DevTools > Application > IndexedDB o roba los
 *    archivos SQLite/LevelDB del navegador en disco, sólo verá ArrayBuffers
 *    cifrados (ciphertext) e IVs de 12 bytes, sin un solo byte de datos en claro.
 * ========================================================================== */

'use strict';

const DB = (() => {
  const DB_NAME = 'cifracontrol_zk_vault_db';
  const DB_VERSION = 2;
  const STORE_META = '__vault_meta__';
  const STORE_DATOS = 'dataset_actual';
  const STORE_HISTORIAL = 'historial_cargas';

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

  /** Verifica si la bóveda está actualmente bloqueada (sin clave en RAM). */
  function estaBloqueada() {
    return !Vault.estaDesbloqueada();
  }

  function obtenerRol() {
    return Vault.obtenerRol();
  }

  function esAdmin() {
    return Vault.esAdmin();
  }

  /** Verifica si ya existe una contraseña maestra configurada en esta máquina. */
  async function tieneBovedaConfigurada() {
    const db = await abrir();
    return Vault.existeBoveda(db);
  }

  /** Crea la bóveda con la contraseña maestra y el rol elegidos por el usuario. */
  async function crearBoveda(password, opciones = {}) {
    const db = await abrir();
    return Vault.inicializarBoveda(db, password, opciones);
  }

  /** Desbloquea la bóveda validando la contraseña maestra contra el testigo cifrado. */
  async function desbloquearBoveda(password) {
    const db = await abrir();
    return Vault.desbloquear(db, password);
  }

  /** Obtiene los metadatos públicos de la bóveda (algoritmo, iteraciones, fecha de creación). */
  async function infoCriptografica() {
    const db = await abrir();
    const meta = await Vault.obtenerMetaBoveda(db);
    return {
      bovedaConfigurada: Boolean(meta),
      desbloqueadaEnRAM: Vault.estaDesbloqueada(),
      rolActivo: Vault.obtenerRol(),
      algoritmo: meta?.algoritmo || 'AES-GCM-256 / PBKDF2-HMAC-SHA256',
      iteracionesPBKDF2: meta?.iterations || 250000,
      longitudIV: '12 bytes (96 bits)',
      longitudSalt: '16 bytes (128 bits)',
      creadoEn: meta?.creadoEn || null,
    };
  }

  const INDICE_KEY = '__indice__';

  function combinarMetas(metaPrevia, metaNueva, totalFilas) {
    if (!metaPrevia && !metaNueva) return null;
    const colsPrevias = Array.isArray(metaPrevia?.columnas) ? metaPrevia.columnas : [];
    const colsNuevas = Array.isArray(metaNueva?.columnas) ? metaNueva.columnas : [];
    const avisosPrevios = Array.isArray(metaPrevia?.avisos) ? metaPrevia.avisos : [];
    const avisosNuevos = Array.isArray(metaNueva?.avisos) ? metaNueva.avisos : [];
    return {
      ...(metaPrevia || {}),
      ...(metaNueva || {}),
      filas: totalFilas,
      columnas: metaPrevia ? Array.from(new Set([...colsPrevias, ...colsNuevas])) : colsNuevas,
      avisos: metaPrevia ? [...avisosPrevios, ...avisosNuevos] : avisosNuevos,
    };
  }

  /**
   * Guarda el resultado limpio CIFRADO con AES-GCM-256 en IndexedDB por lotes.
   * Si ya existen cargas previas, agrega un nuevo lote sin re-cifrar los anteriores
   * y conserva absolutamente todas las filas (concatenación pura).
   * Restringido exclusivamente al rol 'admin'.
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

      const lotes = tienePrevio ? [...indice.lotes, loteId] : [loteId];
      const totalFilas = (tienePrevio ? (indice.totalFilas || 0) : 0) + nuevasFilas.length;
      const metaCombinada = combinarMetas(tienePrevio ? indice.meta : null, meta, totalFilas);
      const ahoraIso = new Date().toISOString();

      const escrituras = [
        {
          storeName: STORE_DATOS,
          keyId: loteId,
          data: {
            filas: nuevasFilas,
            meta: meta || null,
            actualizadoEn: ahoraIso,
          },
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
        escrituras.push({
          storeName: STORE_HISTORIAL,
          keyId: registroCola.id,
          data: {
            ...registroCola,
            loteId,
            meta: meta || null,
            esSnapshot: true,
          },
        });
      }

      await SecureDB.escribirTransaccionCifrada(db, { escrituras });

      if (cacheActual && Array.isArray(cacheActual.filas)) {
        const acumuladas = cacheActual.filas.concat(nuevasFilas);
        cacheActual = {
          disponible: acumuladas.length > 0,
          filas: acumuladas,
          meta: metaCombinada,
        };
      } else {
        invalidarCacheActual();
      }

      return {
        concatenado: tienePrevio,
        filasAgregadas: nuevasFilas.length,
        totalFilas,
      };
    });

    colaEscritura = tarea.catch(() => {});
    return tarea;
  }

  /**
   * Lee y descifra en RAM el dataset actual desde IndexedDB uniendo todos los lotes en paralelo.
   * Usa caché en RAM mientras la bóveda esté desbloqueada para evitar descifrar en cada vista/filtro.
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
        const filas = [];
        for (const lote of lotesDescifrados) {
          if (lote && Array.isArray(lote.filas) && lote.filas.length) {
            for (let i = 0; i < lote.filas.length; i++) {
              filas.push(lote.filas[i]);
            }
          }
        }
        cacheActual = filas.length
          ? { disponible: true, filas, meta: indice.meta || null }
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
    const procesadoEn = actual.meta?.procesado_en || actual.meta?.procesadoEn || '';
    const yaExiste = historial.some(item => item.esSnapshot && (
      (procesadoEn && (item.meta?.procesado_en || item.meta?.procesadoEn) === procesadoEn)
      || item.id === `hist-actual-${procesadoEn}`
    ));
    if (yaExiste) return false;
    const id = `hist-actual-${procesadoEn || Date.now()}`;
    await guardarHistorial({
      id,
      archivo: actual.meta?.archivo_origen || 'Carga actual',
      recibidoEn: actual.meta?.procesado_en || new Date().toISOString(),
      fechaCorte: actual.meta?.fecha_corte || actual.meta?.fechaCorte || null,
      filas: actual.filas,
      meta: actual.meta || null,
      status: 'procesado',
    });
    return true;
  }

  async function limpiarStoresDatos() {
    invalidarCacheActual();
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DATOS, STORE_HISTORIAL], 'readwrite');
      tx.objectStore(STORE_DATOS).clear();
      tx.objectStore(STORE_HISTORIAL).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('No se pudo limpiar la base de datos.'));
    });
  }

  /**
   * Vacía los datos cargados pero conserva la configuración de la bóveda (contraseña maestra).
   */
  async function vaciar() {
    if (!Vault.esAdmin()) {
      throw new Error('Acceso denegado: sólo el rol Administrador puede vaciar la base de datos.');
    }
    return limpiarStoresDatos();
  }

  /**
   * Restablecimiento destructivo de fábrica (cuando el usuario olvida su contraseña maestra).
   * Borra toda la bóveda y todos los registros cifrados.
   */
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
   * El archivo .enc.json resultante no contiene ni un solo dato en texto plano.
   */
  async function exportarBackup(passwordTransporte) {
    const actual = await obtenerActual();
    const historial = await listarHistorial({ incluirFilas: true });
    const objetoPlano = {
      version: 2,
      exportadoEn: new Date().toISOString(),
      app: 'FEMSA CifraControl Zero-Knowledge',
      datos: actual,
      historial,
    };
    return CryptoEngine.cifrarPaqueteTransporte(objetoPlano, passwordTransporte);
  }

  /**
   * Descifra en memoria RAM un paquete .enc.json usando la contraseña de transporte
   * e inmediatamente lo vuelve a cifrar con la CryptoKey local del usuario en IndexedDB
   * en una sola transacción atómica (tanto para rol Administrador como Operador).
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
    const db = await abrir();
    const ahoraIso = new Date().toISOString();
    const escrituras = [];

    if (filasLimpias.length) {
      const loteId = generarIdSeguro('lote-import');
      escrituras.push(
        {
          storeName: STORE_DATOS,
          keyId: loteId,
          data: {
            filas: filasLimpias,
            meta: contenido.datos.meta || null,
            actualizadoEn: ahoraIso,
          },
        },
        {
          storeName: STORE_DATOS,
          keyId: INDICE_KEY,
          data: {
            lotes: [loteId],
            meta: contenido.datos.meta || null,
            totalFilas: filasLimpias.length,
            actualizadoEn: ahoraIso,
          },
        }
      );
    }

    if (Array.isArray(contenido.historial)) {
      for (const h of contenido.historial) {
        if (h && typeof h === 'object' && typeof h.id === 'string' && !CLAVES_PROHIBIDAS.has(h.id)) {
          const hCopia = { ...h };
          if (Array.isArray(hCopia.filas)) {
            hCopia.filas = sanitizarFilas(hCopia.filas);
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
          const plano = await CryptoEngine.descifrarPayload(oldKey, rec.iv, rec.ciphertext);
          const { iv, ciphertext } = await CryptoEngine.cifrarPayload(newKey, plano);
          porGuardar[storeName].push({
            ...rec,
            iv,
            ciphertext,
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

  return {
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
  };
})();
