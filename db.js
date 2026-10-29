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
  const DB_VERSION = 1;
  const STORE_META = '__vault_meta__';
  const STORE_DATOS = 'dataset_actual';
  const STORE_HISTORIAL = 'historial_cargas';

  let dbInstance = null;

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

  /** Verifica si ya existe una contraseña maestra configurada en esta máquina. */
  async function tieneBovedaConfigurada() {
    const db = await abrir();
    return Vault.existeBoveda(db);
  }

  /** Crea la bóveda con la contraseña maestra elegida por el usuario. */
  async function crearBoveda(password) {
    const db = await abrir();
    return Vault.inicializarBoveda(db, password);
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
      algoritmo: meta?.algoritmo || 'AES-GCM-256 / PBKDF2-HMAC-SHA256',
      iteracionesPBKDF2: meta?.iterations || 250000,
      longitudIV: '12 bytes (96 bits)',
      longitudSalt: '16 bytes (128 bits)',
      creadoEn: meta?.creadoEn || null,
    };
  }

  /**
   * Guarda el resultado limpio del pipeline de Python CIFRADO con AES-GCM-256 en IndexedDB.
   */
  async function guardarCarga({ filas, meta, registroCola }) {
    const db = await abrir();

    await SecureDB.setEncrypted(db, STORE_DATOS, 'vigente', {
      filas: filas || [],
      meta: meta || null,
      actualizadoEn: new Date().toISOString(),
    });

    if (registroCola && registroCola.id) {
      await SecureDB.setEncrypted(db, STORE_HISTORIAL, registroCola.id, registroCola);
    }

    return true;
  }

  /**
   * Lee y descifra en RAM el dataset actual desde IndexedDB.
   */
  async function obtenerActual() {
    if (!Vault.estaDesbloqueada()) {
      return { disponible: false, filas: [], meta: null, bloqueada: true };
    }
    const db = await abrir();
    const res = await SecureDB.getDecrypted(db, STORE_DATOS, 'vigente');
    if (!res || !res.filas || !res.filas.length) {
      return { disponible: false, filas: [], meta: null };
    }
    return { disponible: true, filas: res.filas, meta: res.meta };
  }

  /**
   * Lista y descifra el historial de cargas realizadas en este equipo.
   */
  async function listarHistorial() {
    if (!Vault.estaDesbloqueada()) return [];
    const db = await abrir();
    const items = await SecureDB.getAllDecrypted(db, STORE_HISTORIAL);
    return items.sort((a, b) => new Date(b.recibidoEn || 0) - new Date(a.recibidoEn || 0));
  }

  /**
   * Vacía los datos cargados pero conserva la configuración de la bóveda (contraseña maestra).
   */
  async function vaciar() {
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
   * Restablecimiento destructivo de fábrica (cuando el usuario olvida su contraseña maestra).
   * Borra toda la bóveda y todos los registros cifrados.
   */
  async function restablecerFabrica() {
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
   * Exporta el respaldo descifrado (requiere que la bóveda esté desbloqueada)
   * para poder compartirlo con un compañero que tiene su propia contraseña.
   */
  async function exportarBackup() {
    const actual = await obtenerActual();
    const historial = await listarHistorial();
    return {
      version: 1,
      exportadoEn: new Date().toISOString(),
      app: 'FEMSA CifraControl',
      datos: actual,
      historial,
    };
  }

  /**
   * Importa un backup JSON y lo cifra inmediatamente con la CryptoKey activa del usuario actual.
   */
  async function importarBackup(contenido) {
    if (!contenido || !contenido.datos) {
      throw new Error('El archivo de respaldo no tiene un formato válido de CifraControl.');
    }
    await vaciar();
    const db = await abrir();

    if (contenido.datos.filas && contenido.datos.filas.length) {
      await SecureDB.setEncrypted(db, STORE_DATOS, 'vigente', {
        filas: contenido.datos.filas,
        meta: contenido.datos.meta,
        actualizadoEn: new Date().toISOString(),
      });
    }

    if (Array.isArray(contenido.historial)) {
      for (const h of contenido.historial) {
        if (h && h.id) {
          await SecureDB.setEncrypted(db, STORE_HISTORIAL, h.id, h);
        }
      }
    }

    return true;
  }

  return {
    abrir,
    tieneBovedaConfigurada,
    crearBoveda,
    desbloquearBoveda,
    infoCriptografica,
    guardarCarga,
    obtenerActual,
    listarHistorial,
    vaciar,
    restablecerFabrica,
    exportarBackup,
    importarBackup,
  };
})();
