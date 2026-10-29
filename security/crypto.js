/* ============================================================================
 *  CifraControl · Capa Criptográfica Zero-Knowledge (Web Crypto API)
 * ============================================================================
 *  - Derivación de clave: PBKDF2-HMAC-SHA256 (250,000 iteraciones)
 *  - Algoritmo simétrico: AES-GCM de 256 bits (Autenticado con MAC Tag)
 *  - Clave maestra en RAM con extractable: false (inmune a extracción por script)
 *  - IV único de 12 bytes por cada operación de cifrado
 * ========================================================================== */

'use strict';

const CryptoEngine = (() => {
  const PBKDF2_ITERATIONS = 250000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  /** Genera un Uint8Array con entropía criptográfica del sistema operativo. */
  function generarBytesAleatorios(tamano) {
    const bytes = new Uint8Array(tamano);
    window.crypto.getRandomValues(bytes);
    return bytes;
  }

  /** Convierte Uint8Array / ArrayBuffer a Base64 (para exportar/serializar de forma segura). */
  function aBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let binario = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binario += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binario);
  }

  /** Convierte Base64 de vuelta a Uint8Array. */
  function deBase64(b64) {
    const binario = window.atob(b64);
    const bytes = new Uint8Array(binario.length);
    for (let i = 0; i < binario.length; i++) {
      bytes[i] = binario.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Deriva una CryptoKey AES-GCM de 256 bits a partir de la contraseña del usuario y el salt.
   * La clave resultante tiene extractable = false y sólo vive en memoria RAM.
   */
  async function derivarClaveMaestra(password, saltBytes) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(String(password));

    try {
      const baseKey = await window.crypto.subtle.importKey(
        'raw',
        passwordBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );

      const derivedKey = await window.crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes),
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false, // No extraíble: ni siquiera desde la consola se puede exportar la clave cruda
        ['encrypt', 'decrypt']
      );

      return derivedKey;
    } finally {
      // Mitigación de memoria: sobrescribir con ceros el buffer temporal de la contraseña
      passwordBuffer.fill(0);
    }
  }

  /**
   * Cifra cualquier objeto serializable en JSON con AES-GCM-256 y un IV aleatorio único de 12 bytes.
   * Devuelve { iv: Uint8Array(12), ciphertext: ArrayBuffer }
   */
  async function cifrarPayload(clave, objeto) {
    const encoder = new TextEncoder();
    const plaintextBytes = encoder.encode(JSON.stringify(objeto));
    const iv = generarBytesAleatorios(IV_BYTES);

    try {
      const ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        clave,
        plaintextBytes
      );
      return { iv, ciphertext };
    } finally {
      plaintextBytes.fill(0);
    }
  }

  /**
   * Descifra un registro AES-GCM-256 verificando su etiqueta de integridad (MAC Tag).
   * Si la clave no corresponde o el ciphertext fue alterado en disco, lanza OperationError.
   */
  async function descifrarPayload(clave, iv, ciphertext) {
    const ivBytes = iv instanceof Uint8Array ? iv : new Uint8Array(iv);
    const decryptedBuffer = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: ivBytes },
      clave,
      ciphertext
    );

    const decoder = new TextDecoder();
    const jsonStr = decoder.decode(decryptedBuffer);
    return JSON.parse(jsonStr);
  }

  return {
    PBKDF2_ITERATIONS,
    SALT_BYTES,
    IV_BYTES,
    generarBytesAleatorios,
    aBase64,
    deBase64,
    derivarClaveMaestra,
    cifrarPayload,
    descifrarPayload,
  };
})();
