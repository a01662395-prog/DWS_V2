/* ============================================================================
 *  CifraControl · Gestor de Bóveda Zero-Knowledge (VaultService)
 * ============================================================================
 *  - Administra el ciclo de vida de la CryptoKey maestra únicamente en RAM.
 *  - Valida el inicio de sesión mediante un Payload Testigo (Canary) cifrado
 *    con AES-GCM, sin almacenar jamás el hash de la contraseña en disco.
 *  - Auto-bloqueo automático por inactividad y al cerrar la pestaña.
 *  - Protección contra fuerza bruta local con retardo exponencial.
 * ========================================================================== */

'use strict';

const Vault = (() => {
  const TESTIGO_CANARY = 'FEMSA_ZERO_KNOWLEDGE_CANARY_V1';
  const STORE_META = '__vault_meta__';
  const TIEMPO_INACTIVIDAD_MS = 15 * 60 * 1000; // 15 minutos

  /** Clave maestra activa: sólo vive en esta clausura privada en memoria RAM. */
  let claveActivaRAM = null;
  let timerInactividad = null;
  let intentosFallidos = 0;
  const suscriptores = new Set();

  function estaDesbloqueada() {
    return claveActivaRAM !== null;
  }

  /** Devuelve la CryptoKey en RAM o lanza error si la bóveda está bloqueada. */
  function obtenerClaveActiva() {
    if (!claveActivaRAM) {
      const err = new Error('La bóveda está bloqueada. Desbloquéala con tu contraseña maestra.');
      err.code = 'VAULT_LOCKED';
      throw err;
    }
    reiniciarTimerInactividad();
    return claveActivaRAM;
  }

  function reiniciarTimerInactividad() {
    if (timerInactividad) clearTimeout(timerInactividad);
    if (!claveActivaRAM) return;
    timerInactividad = setTimeout(() => {
      bloquear('INACTIVIDAD');
    }, TIEMPO_INACTIVIDAD_MS);
  }

  /** Registra listeners de actividad humana para mantener viva la sesión mientras se usa. */
  function conectarMonitoreoActividad() {
    const eventos = ['mousedown', 'keydown', 'scroll', 'touchstart'];
    let ultimoReset = 0;
    const handler = () => {
      if (!claveActivaRAM) return;
      const ahora = Date.now();
      if (ahora - ultimoReset > 5000) {
        ultimoReset = ahora;
        reiniciarTimerInactividad();
      }
    };
    eventos.forEach((evt) => window.addEventListener(evt, handler, { passive: true }));

    // Al cerrar o recargar la pestaña, destruimos la referencia a la clave en RAM
    window.addEventListener('beforeunload', () => {
      claveActivaRAM = null;
    });
  }

  /**
   * Comprueba si ya existe una bóveda inicializada en IndexedDB.
   */
  async function existeBoveda(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META], 'readonly');
      const req = tx.objectStore(STORE_META).get('config');
      req.onsuccess = () => resolve(Boolean(req.result && req.result.salt && req.result.authTag));
      req.onerror = () => reject(new Error('No se pudo verificar el estado de la bóveda en IndexedDB.'));
    });
  }

  /**
   * Obtiene los metadatos públicos de la bóveda (salt en claro, fecha de creación, iteraciones).
   */
  async function obtenerMetaBoveda(db) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META], 'readonly');
      const req = tx.objectStore(STORE_META).get('config');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(new Error('Error al leer metadatos de la bóveda.'));
    });
  }

  /**
   * REGISTRO / INICIALIZACIÓN DE BÓVEDA:
   * Crea un salt aleatorio de 16 bytes, deriva la CryptoKey con PBKDF2 (250k iteraciones),
   * cifra el payload testigo con un IV único de 12 bytes y persiste { salt, authIv, authTag }.
   *
   * REGLA DE SEGURIDAD DE REGISTRO ÚNICO:
   * Si ya existe una bóveda configurada en IndexedDB, rechaza el registro para impedir
   * que alguien sobrescriba o vuelva a usar el flujo de "usuario nuevo".
   */
  async function inicializarBoveda(db, password) {
    const yaExiste = await existeBoveda(db);
    if (yaExiste) {
      throw new Error('Ya existe una contraseña maestra configurada en este equipo. No es posible registrar un nuevo usuario sobre una bóveda activa.');
    }

    if (!password || String(password).length < 6) {
      throw new Error('La contraseña maestra debe tener al menos 6 caracteres.');
    }

    const salt = CryptoEngine.generarBytesAleatorios(CryptoEngine.SALT_BYTES);
    const key = await CryptoEngine.derivarClaveMaestra(password, salt);

    const testigoPayload = {
      canary: TESTIGO_CANARY,
      createdAt: new Date().toISOString(),
    };
    const { iv: authIv, ciphertext: authTag } = await CryptoEngine.cifrarPayload(key, testigoPayload);

    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META], 'readwrite');
      tx.objectStore(STORE_META).put({
        id: 'config',
        salt,
        authIv,
        authTag,
        iterations: CryptoEngine.PBKDF2_ITERATIONS,
        algoritmo: 'AES-GCM-256 / PBKDF2-SHA256',
        creadoEn: testigoPayload.createdAt,
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('No se pudo guardar la configuración de la bóveda.'));
    });

    intentosFallidos = 0;
    claveActivaRAM = key;
    reiniciarTimerInactividad();
    notificar('UNLOCKED', { recienCreada: true });
    return true;
  }

  /**
   * LOGIN / DESBLOQUEO:
   * Lee el salt de IndexedDB, deriva la clave candidata y verifica si logra descifrar
   * y autenticar el payload testigo (authTag).
   */
  async function desbloquear(db, password) {
    if (!password) throw new Error('Introduce tu contraseña maestra.');

    // Mitigación contra fuerza bruta: retardo acumulativo tras intentos fallidos
    if (intentosFallidos > 0) {
      const esperaMs = Math.min(4000, intentosFallidos * 450);
      await new Promise((r) => setTimeout(r, esperaMs));
    }

    const config = await obtenerMetaBoveda(db);
    if (!config) {
      throw new Error('NO_VAULT_FOUND');
    }

    const candidateKey = await CryptoEngine.derivarClaveMaestra(password, config.salt);

    try {
      const testigoDescifrado = await CryptoEngine.descifrarPayload(
        candidateKey,
        config.authIv,
        config.authTag
      );

      if (!testigoDescifrado || testigoDescifrado.canary !== TESTIGO_CANARY) {
        throw new Error('CANARY_MISMATCH');
      }
    } catch {
      intentosFallidos++;
      const err = new Error('Contraseña maestra incorrecta. No se pudo descifrar la bóveda.');
      err.code = 'INVALID_PASSWORD';
      err.intentos = intentosFallidos;
      throw err;
    }

    intentosFallidos = 0;
    claveActivaRAM = candidateKey;
    reiniciarTimerInactividad();
    notificar('UNLOCKED', { recienCreada: false });
    return true;
  }

  /**
   * LOGOUT / AUTO-LOCK:
   * Destruye la referencia a la CryptoKey en memoria RAM inmediatamente.
   */
  function bloquear(razon = 'MANUAL') {
    claveActivaRAM = null;
    if (timerInactividad) {
      clearTimeout(timerInactividad);
      timerInactividad = null;
    }
    notificar('LOCKED', { razon });
  }

  function suscribir(fn) {
    suscriptores.add(fn);
    return () => suscriptores.delete(fn);
  }

  function notificar(evento, detalle = {}) {
    suscriptores.forEach((fn) => {
      try { fn(evento, detalle); } catch { /* noop */ }
    });
  }

  conectarMonitoreoActividad();

  return {
    STORE_META,
    estaDesbloqueada,
    obtenerClaveActiva,
    existeBoveda,
    obtenerMetaBoveda,
    inicializarBoveda,
    desbloquear,
    bloquear,
    suscribir,
  };
})();
