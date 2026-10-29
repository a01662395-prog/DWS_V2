/* ============================================================================
 *  CifraControl · Motor de Base de Datos Local (IndexedDB)
 * ============================================================================
 *  Almacenamiento persistente 100 % en el navegador del usuario:
 *    - Cero datos dummies iniciales (inicia en 0 registros).
 *    - Aislado por usuario / navegador (lo que cada quien sube se queda en su BD).
 *    - Permite exportar e importar copias de seguridad (.json) para compartir.
 * ========================================================================== */

'use strict';

const DB = (() => {
  const DB_NAME = 'cifracontrol_local_db';
  const DB_VERSION = 1;
  const STORE_DATOS = 'dataset_actual';
  const STORE_HISTORIAL = 'historial_cargas';

  let dbInstance = null;

  /** Abre o inicializa la base de datos IndexedDB en el navegador. */
  function abrir() {
    if (dbInstance) return Promise.resolve(dbInstance);

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
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

  /**
   * Guarda el resultado limpio del pipeline de Python en la Base de Datos Local.
   * @param {Object} payload { filas: Array, meta: Object, registroCola: Object }
   */
  async function guardarCarga({ filas, meta, registroCola }) {
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DATOS, STORE_HISTORIAL], 'readwrite');
      const storeDatos = tx.objectStore(STORE_DATOS);
      const storeHist = tx.objectStore(STORE_HISTORIAL);

      storeDatos.put({
        id: 'vigente',
        filas: filas || [],
        meta: meta || null,
        actualizadoEn: new Date().toISOString(),
      });

      if (registroCola && registroCola.id) {
        storeHist.put(registroCola);
      }

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('Error al escribir en la base de datos local.'));
    });
  }

  /** Obtiene el dataset actual (filas y metadatos) o vacío si aún no se ha subido nada. */
  async function obtenerActual() {
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DATOS], 'readonly');
      const req = tx.objectStore(STORE_DATOS).get('vigente');
      req.onsuccess = () => {
        const res = req.result;
        if (!res || !res.filas || !res.filas.length) {
          resolve({ disponible: false, filas: [], meta: null });
        } else {
          resolve({ disponible: true, filas: res.filas, meta: res.meta });
        }
      };
      req.onerror = () => reject(new Error('No se pudo leer la base de datos local.'));
    });
  }

  /** Lista el historial de cargas realizadas en este navegador. */
  async function listarHistorial() {
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_HISTORIAL], 'readonly');
      const req = tx.objectStore(STORE_HISTORIAL).getAll();
      req.onsuccess = () => {
        const items = (req.result || []).sort(
          (a, b) => new Date(b.recibidoEn || 0) - new Date(a.recibidoEn || 0)
        );
        resolve(items);
      };
      req.onerror = () => reject(new Error('No se pudo leer el historial de cargas.'));
    });
  }

  /** Vacía por completo la base de datos local (vuelve a 0 registros). */
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

  /** Exporta toda la base de datos local a un objeto JSON para compartir con un compañero. */
  async function exportarBackup() {
    const actual = await obtenerActual();
    const historial = await listarHistorial();
    return {
      version: 1,
      exportadoEn: new Date().toISOString(),
      app: 'CifraControl',
      datos: actual,
      historial,
    };
  }

  /** Importa un backup JSON en la base de datos local. */
  async function importarBackup(contenido) {
    if (!contenido || !contenido.datos) {
      throw new Error('El archivo de respaldo no tiene un formato válido de CifraControl.');
    }
    const db = await abrir();
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_DATOS, STORE_HISTORIAL], 'readwrite');
      const sDatos = tx.objectStore(STORE_DATOS);
      const sHist = tx.objectStore(STORE_HISTORIAL);

      sDatos.clear();
      sHist.clear();

      if (contenido.datos.filas && contenido.datos.filas.length) {
        sDatos.put({
          id: 'vigente',
          filas: contenido.datos.filas,
          meta: contenido.datos.meta,
          actualizadoEn: new Date().toISOString(),
        });
      }

      if (Array.isArray(contenido.historial)) {
        contenido.historial.forEach((h) => {
          if (h && h.id) sHist.put(h);
        });
      }

      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('Error al restaurar la copia en la base de datos local.'));
    });
  }

  return {
    abrir,
    guardarCarga,
    obtenerActual,
    listarHistorial,
    vaciar,
    exportarBackup,
    importarBackup,
  };
})();
