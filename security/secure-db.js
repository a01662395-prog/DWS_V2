/* ============================================================================
 *  CifraControl · Capa de Abstracción Transparente Cifrada para IndexedDB
 * ============================================================================
 *  - setEncrypted(db, store, id, data): Cifra con AES-GCM-256 + IV único de 12B
 *    antes de escribir en IndexedDB. Ningún dato en claro toca el disco.
 *  - getDecrypted(db, store, id): Lee el registro cifrado de IndexedDB y lo
 *    descifra en RAM usando la CryptoKey activa en Vault.
 *  - getAllDecrypted(db, store): Descifra todos los registros de una colección.
 * ========================================================================== */

'use strict';

const SecureDB = (() => {
  /**
   * Cifra `data` con un IV aleatorio de 12 bytes y lo guarda en `storeName` bajo `keyId`.
   */
  async function setEncrypted(db, storeName, keyId, data) {
    const masterKey = Vault.obtenerClaveActiva();
    const { iv, ciphertext } = await CryptoEngine.cifrarPayload(masterKey, data);

    return new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readwrite');
      const store = tx.objectStore(storeName);
      store.put({
        id: keyId,
        iv,
        ciphertext,
        encryptedAt: new Date().toISOString(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error(`Error al escribir registro cifrado en ${storeName}.`));
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

    return CryptoEngine.descifrarPayload(masterKey, record.iv, record.ciphertext);
  }

  /**
   * Lee todos los registros cifrados de un ObjectStore y los descifra uno por uno.
   * Si algún registro individual está corrupto, lo aísla sin romper el resto de la colección.
   */
  async function getAllDecrypted(db, storeName) {
    const masterKey = Vault.obtenerClaveActiva();

    const rawRecords = await new Promise((resolve, reject) => {
      const tx = db.transaction([storeName], 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(new Error(`Error al listar registros cifrados de ${storeName}.`));
    });

    const resultados = [];
    for (const rec of rawRecords) {
      if (rec && rec.ciphertext && rec.iv) {
        try {
          const dec = await CryptoEngine.descifrarPayload(masterKey, rec.iv, rec.ciphertext);
          resultados.push(dec);
        } catch (err) {
          console.warn(`[SecureDB] Registro ${rec.id} omitido por fallo de integridad MAC:`, err);
        }
      }
    }
    return resultados;
  }

  return {
    setEncrypted,
    getDecrypted,
    getAllDecrypted,
  };
})();
