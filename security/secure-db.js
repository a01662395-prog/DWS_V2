/* ============================================================================
 *  CifraControl · Capa de Abstracción Transparente Cifrada para IndexedDB
 * ============================================================================
 *  - setEncrypted(db, store, id, data): Cifra con AES-GCM-256 + IV único de 12B
 *    + AAD ("store:id") antes de escribir en IndexedDB. Ningún dato en claro
 *    toca el disco y ningún registro puede intercambiarse de clave/colección.
 *  - getDecrypted(db, store, id): Lee el registro cifrado de IndexedDB y lo
 *    descifra en RAM verificando su MAC Tag y AAD.
 *  - getAllDecrypted(db, store): Descifra todos los registros de una colección.
 * ========================================================================== */

'use strict';

const SecureDB = (() => {
  let ultimosOmitidos = [];

  function construirAADRegistro(storeName, keyId) {
    return `${storeName || ''}:${keyId}`;
  }

  /**
   * Cifra `data` en memoria RAM con un IV aleatorio único de 12 bytes + AAD
   * y devuelve el registro listo para persistir en un ObjectStore de IndexedDB.
   */
  async function prepararRegistroCifrado(keyId, data, storeName = '') {
    const masterKey = Vault.obtenerClaveActiva();
    const aad = construirAADRegistro(storeName, keyId);
    const { iv, ciphertext } = await CryptoEngine.cifrarPayload(masterKey, data, aad);
    return {
      id: keyId,
      iv,
      ciphertext,
      aadVersion: 1,
      encryptedAt: new Date().toISOString(),
    };
  }

  /**
   * Cifra `data` con un IV aleatorio de 12 bytes y lo guarda en `storeName` bajo `keyId`.
   */
  async function setEncrypted(db, storeName, keyId, data) {
    const registro = await prepararRegistroCifrado(keyId, data, storeName);

    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      store.put(registro);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error(`Error al escribir registro cifrado en ${storeName}.`));
      tx.onabort = () => reject(new Error(`Transacción abortada al escribir en ${storeName}.`));
    });
  }

  /**
   * Cifra múltiples registros en memoria RAM primero y luego los persiste (junto con
   * limpiezas opcionales de stores) dentro de UNA SOLA transacción atómica de IndexedDB.
   * Si cualquier cifrado o escritura falla, la base de datos no queda en estado parcial.
   */
  async function escribirTransaccionCifrada(db, { limpiarStores = [], escrituras = [] } = {}) {
    const preparados = await Promise.all(
      escrituras.map(async ({ storeName, keyId, data }) => ({
        storeName,
        registro: await prepararRegistroCifrado(keyId, data, storeName),
      }))
    );

    const storesInvolucrados = Array.from(
      new Set([...limpiarStores, ...preparados.map((p) => p.storeName)])
    );
    if (!storesInvolucrados.length) return true;

    return new Promise((resolve, reject) => {
      const tx = db.transaction(storesInvolucrados, 'readwrite');
      for (const storeName of limpiarStores) {
        tx.objectStore(storeName).clear();
      }
      for (const { storeName, registro } of preparados) {
        tx.objectStore(storeName).put(registro);
      }
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('Error en transacción atómica de IndexedDB.'));
      tx.onabort = () => reject(new Error('Transacción atómica abortada en IndexedDB.'));
    });
  }

  /**
   * Obtiene el registro `keyId` desde `storeName` y lo descifra en memoria RAM.
   */
  async function getDecrypted(db, storeName, keyId) {
    const masterKey = Vault.obtenerClaveActiva();

    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const req = tx.objectStore(storeName).get(keyId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error(`Error al leer registro cifrado de ${storeName}.`));
    });

    if (!record || !record.ciphertext || !record.iv) {
      return null;
    }

    const aad = record.aadVersion === 1 ? construirAADRegistro(storeName, keyId) : null;
    return CryptoEngine.descifrarPayload(masterKey, record.iv, record.ciphertext, aad);
  }

  /**
   * Lee todos los registros cifrados de un ObjectStore y los descifra en paralelo.
   * Si algún registro individual está corrupto, lo aísla y registra su ID en `ultimosOmitidos`.
   */
  async function getAllDecrypted(db, storeName) {
    const masterKey = Vault.obtenerClaveActiva();

    const rawRecords = await new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error(`Error al listar registros cifrados de ${storeName}.`));
    });

    const omitidos = [];
    const resultados = [];
    for (const rec of rawRecords) {
      if (rec && rec.ciphertext && rec.iv) {
        try {
          const aad = rec.aadVersion === 1 ? construirAADRegistro(storeName, rec.id) : null;
          const dec = await CryptoEngine.descifrarPayload(masterKey, rec.iv, rec.ciphertext, aad);
          resultados.push(dec);
        } catch (err) {
          omitidos.push(rec.id);
          console.warn(`[SecureDB] Registro ${rec.id} omitido por fallo de integridad MAC/AAD:`, err);
        }
      }
    }
    ultimosOmitidos = omitidos;
    return resultados;
  }

  function obtenerUltimosOmitidos() {
    return [...ultimosOmitidos];
  }

  return Object.freeze({
    prepararRegistroCifrado,
    setEncrypted,
    escribirTransaccionCifrada,
    getDecrypted,
    getAllDecrypted,
    obtenerUltimosOmitidos,
  });
})();
