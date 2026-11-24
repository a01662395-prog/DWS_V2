/* ============================================================================
 *  CifraControl · Capa Criptográfica Zero-Knowledge (Web Crypto API)
 * ============================================================================
 *  - Derivación de clave: PBKDF2-HMAC-SHA256 (600,000 iteraciones OWASP)
 *  - Algoritmo simétrico: AES-GCM de 256 bits (Autenticado con MAC Tag + AAD)
 *  - Clave maestra en RAM con extractable: false (inmune a extracción por script)
 *  - IV único de 12 bytes por cada operación de cifrado
 * ========================================================================== */

'use strict';

const CryptoEngine = (() => {
  const PBKDF2_ITERATIONS = 600000;
  const MIN_PBKDF2_ITERATIONS = 100000;
  const MAX_PBKDF2_ITERATIONS = 1000000;
  const SALT_BYTES = 16;
  const IV_BYTES = 12;

  function normalizarIteraciones(iteraciones) {
    const n = Number(iteraciones);
    if (!Number.isInteger(n) || n < MIN_PBKDF2_ITERATIONS || n > MAX_PBKDF2_ITERATIONS) {
      return PBKDF2_ITERATIONS;
    }
    return n;
  }

  /** Genera un Uint8Array con entropía criptográfica del sistema operativo. */
  function generarBytesAleatorios(tamano) {
    const bytes = new Uint8Array(tamano);
    window.crypto.getRandomValues(bytes);
    return bytes;
  }

  /** Convierte Uint8Array / ArrayBuffer a Base64 por bloques de 32 KB (sin agotar la pila ni el hilo principal). */
  function aBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const CHUNK = 0x8000;
    const partes = [];
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
      const sub = bytes.subarray(i, i + CHUNK);
      partes.push(String.fromCharCode.apply(null, sub));
    }
    return window.btoa(partes.join(''));
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

  /** Comparación de cadenas en tiempo constante para evitar ataques de canal lateral. */
  function compararTiempoConstante(a, b) {
    const strA = String(a ?? '');
    const strB = String(b ?? '');
    const len = Math.max(strA.length, strB.length);
    let diff = strA.length ^ strB.length;
    for (let i = 0; i < len; i++) {
      const codeA = i < strA.length ? strA.charCodeAt(i) : 0;
      const codeB = i < strB.length ? strB.charCodeAt(i) : 0;
      diff |= codeA ^ codeB;
    }
    return diff === 0;
  }

  function codificarAAD(aad) {
    if (!aad) return null;
    if (aad instanceof Uint8Array) return aad;
    return new TextEncoder().encode(String(aad));
  }

  /**
   * Deriva una CryptoKey AES-GCM de 256 bits a partir de la contraseña del usuario y el salt.
   * La clave resultante tiene extractable = false y sólo vive en memoria RAM.
   */
  async function derivarClaveMaestra(password, saltBytes, iteraciones = PBKDF2_ITERATIONS) {
    const encoder = new TextEncoder();
    const passwordBuffer = encoder.encode(String(password));
    const iteracionesSeguras = normalizarIteraciones(iteraciones);

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
          iterations: iteracionesSeguras,
          hash: 'SHA-256',
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      return derivedKey;
    } finally {
      passwordBuffer.fill(0);
    }
  }

  /**
   * Deriva un verificador hexadecimal de 256 bits mediante PBKDF2-HMAC-SHA256
   * para validar credenciales o licencias sin exponer hashes rápidos en código.
   */
  async function derivarVerificadorPBKDF2Hex(secretoTexto, saltTexto, iteraciones = PBKDF2_ITERATIONS) {
    const encoder = new TextEncoder();
    const secretoBytes = encoder.encode(String(secretoTexto));
    const saltBytes = encoder.encode(String(saltTexto));
    const iteracionesSeguras = normalizarIteraciones(iteraciones);

    try {
      const baseKey = await window.crypto.subtle.importKey(
        'raw',
        secretoBytes,
        { name: 'PBKDF2' },
        false,
        ['deriveBits']
      );
      const bits = await window.crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations: iteracionesSeguras,
          hash: 'SHA-256',
        },
        baseKey,
        256
      );
      return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
    } finally {
      secretoBytes.fill(0);
    }
  }

  /**
   * Cifra cualquier objeto serializable en JSON con AES-GCM-256, un IV aleatorio único de 12 bytes
   * y datos adicionales autenticados (AAD) opcionales para ligar el ciphertext a su contexto.
   */
  async function cifrarPayload(clave, objeto, aad = null) {
    const encoder = new TextEncoder();
    const plaintextBytes = encoder.encode(JSON.stringify(objeto));
    const iv = generarBytesAleatorios(IV_BYTES);
    const aadBytes = codificarAAD(aad);
    const params = aadBytes ? { name: 'AES-GCM', iv, additionalData: aadBytes } : { name: 'AES-GCM', iv };

    try {
      const ciphertext = await window.crypto.subtle.encrypt(
        params,
        clave,
        plaintextBytes
      );
      return { iv, ciphertext };
    } finally {
      plaintextBytes.fill(0);
    }
  }

  /**
   * Descifra un registro AES-GCM-256 verificando su etiqueta de integridad (MAC Tag) y su AAD.
   * Si la clave, el AAD o el ciphertext fueron alterados en disco, lanza OperationError.
   */
  async function descifrarPayload(clave, iv, ciphertext, aad = null) {
    const ivBytes = iv instanceof Uint8Array ? iv : new Uint8Array(iv);
    const aadBytes = codificarAAD(aad);
    const params = aadBytes
      ? { name: 'AES-GCM', iv: ivBytes, additionalData: aadBytes }
      : { name: 'AES-GCM', iv: ivBytes };

    const decryptedBuffer = await window.crypto.subtle.decrypt(
      params,
      clave,
      ciphertext
    );

    const decoder = new TextDecoder();
    const jsonStr = decoder.decode(decryptedBuffer);
    return JSON.parse(jsonStr);
  }

  /**
   * Calcula el hash SHA-256 en hexadecimal de una cadena.
   * Por compatibilidad normaliza espacios y mayúsculas salvo que `normalizar = false`.
   */
  async function hashSHA256Hex(texto, normalizar = true) {
    const encoder = new TextEncoder();
    const limpio = normalizar ? String(texto).trim().toUpperCase() : String(texto);
    const data = encoder.encode(limpio);
    const hashBuffer = await window.crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function construirAADPaquete({ formato, algoritmo, kdf, iteraciones, exportadoEn }) {
    return `${formato}|${algoritmo}|${kdf}|${iteraciones}|${exportadoEn}`;
  }

  /**
   * Cifra un paquete de exportación (.json) completo con una contraseña de transporte
   * usando PBKDF2 (600,000 iteraciones) + AES-GCM-256 + Salt de 16B + IV de 12B + AAD de cabecera.
   */
  async function cifrarPaqueteTransporte(objetoPlano, passwordTransporte) {
    if (!passwordTransporte || String(passwordTransporte).length < 6) {
      throw new Error('La contraseña de cifrado del archivo debe tener al menos 6 caracteres.');
    }
    const salt = generarBytesAleatorios(SALT_BYTES);
    const claveTransporte = await derivarClaveMaestra(passwordTransporte, salt);
    const cabecera = {
      formato: 'FEMSA_CIFRACONTROL_ENCRYPTED_PACKAGE_V1',
      algoritmo: 'AES-GCM-256',
      kdf: 'PBKDF2-HMAC-SHA256',
      iteraciones: PBKDF2_ITERATIONS,
      exportadoEn: new Date().toISOString(),
    };
    const aad = construirAADPaquete(cabecera);
    const { iv, ciphertext } = await cifrarPayload(claveTransporte, objetoPlano, aad);

    return {
      ...cabecera,
      aadVersion: 1,
      salt: aBase64(salt),
      iv: aBase64(iv),
      ciphertext: aBase64(ciphertext),
    };
  }

  /**
   * Descifra y verifica la autenticidad (MAC Tag GCM + AAD de cabecera) de un paquete .json cifrado.
   */
  async function descifrarPaqueteTransporte(paquete, passwordTransporte) {
    if (!paquete || paquete.formato !== 'FEMSA_CIFRACONTROL_ENCRYPTED_PACKAGE_V1' || !paquete.salt || !paquete.iv || !paquete.ciphertext) {
      throw new Error('El archivo no es un paquete cifrado válido de FEMSA CifraControl (.enc.json).');
    }
    if (!passwordTransporte) {
      throw new Error('Debes introducir la contraseña de desencriptación del archivo.');
    }

    const iteracionesRaw = Number(paquete.iteraciones || PBKDF2_ITERATIONS);
    if (!Number.isInteger(iteracionesRaw) || iteracionesRaw < MIN_PBKDF2_ITERATIONS || iteracionesRaw > MAX_PBKDF2_ITERATIONS) {
      throw new Error(`Parámetro de iteraciones PBKDF2 fuera del rango de seguridad permitido (${MIN_PBKDF2_ITERATIONS.toLocaleString('es-MX')}–${MAX_PBKDF2_ITERATIONS.toLocaleString('es-MX')}).`);
    }

    const saltBytes = deBase64(paquete.salt);
    const ivBytes = deBase64(paquete.iv);
    const cipherBytes = deBase64(paquete.ciphertext);

    const claveTransporte = await derivarClaveMaestra(
      passwordTransporte,
      saltBytes,
      iteracionesRaw
    );
    const aad = paquete.aadVersion === 1
      ? construirAADPaquete({
          formato: paquete.formato,
          algoritmo: paquete.algoritmo || 'AES-GCM-256',
          kdf: paquete.kdf || 'PBKDF2-HMAC-SHA256',
          iteraciones: iteracionesRaw,
          exportadoEn: paquete.exportadoEn || '',
        })
      : null;

    try {
      return await descifrarPayload(claveTransporte, ivBytes, cipherBytes.buffer, aad);
    } catch {
      throw new Error('Contraseña de archivo incorrecta o el paquete cifrado fue alterado.');
    }
  }

  return Object.freeze({
    PBKDF2_ITERATIONS,
    MIN_PBKDF2_ITERATIONS,
    MAX_PBKDF2_ITERATIONS,
    SALT_BYTES,
    IV_BYTES,
    generarBytesAleatorios,
    aBase64,
    deBase64,
    compararTiempoConstante,
    derivarClaveMaestra,
    derivarVerificadorPBKDF2Hex,
    cifrarPayload,
    descifrarPayload,
    hashSHA256Hex,
    cifrarPaqueteTransporte,
    descifrarPaqueteTransporte,
  });
})();
