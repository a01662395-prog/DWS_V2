/* ============================================================================
 *  CifraControl · Gestor de Bóveda Zero-Knowledge (VaultService)
 * ============================================================================
 *  - Administra el ciclo de vida de la CryptoKey maestra únicamente en RAM.
 *  - Valida el inicio de sesión mediante un Payload Testigo (Canary) cifrado
 *    con AES-GCM + AAD, sin almacenar jamás el hash de la contraseña en disco.
 *  - NOTA DE ARQUITECTURA (Zero-Knowledge Client-Side): Al ser una aplicación
 *    100 % local sin servidor, la separación de roles (Admin/Operador) es un
 *    control de flujo operativo sellado en el testigo local y reforzado con
 *    Object.freeze + PBKDF2-SHA256 (600,000 iteraciones).
 *  - Sincronización multi-pestaña mediante BroadcastChannel y auto-bloqueo.
 * ========================================================================== */

'use strict';

const Vault = (() => {
  const TESTIGO_CANARY = 'FEMSA_ZERO_KNOWLEDGE_CANARY_V1';
  const STORE_META = '__vault_meta__';
  const AAD_META_CONFIG = '__vault_meta__:config';
  const SALT_LICENCIA_ADMIN_PRE = 'FEMSA_ADMIN_SALT_V1::';
  const SALT_LICENCIA_ADMIN_KDF = 'FEMSA_ADMIN_KDF_V2_SALT_2026';
  const VERIFICADOR_LICENCIA_ADMIN_PBKDF2 = '40c84c5e5bab578c4d1c8522ce7b0446314b00fab0e23e2acfd92d9c30db929d';

  /** Clave maestra y rol activos: sólo viven en esta clausura privada en memoria RAM. */
  let claveActivaRAM = null;
  let rolActivoRAM = null; // 'admin' | 'operador'
  let timerInactividad = null;
  let inactividadActiva = true;
  let inactividadMs = 15 * 60 * 1000;
  let intentosFallidos = 0;
  let intentosAdminFallidos = 0;
  let desbloqueandoEnCurso = false;
  const suscriptores = new Set();
  const canalSync = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('cifracontrol_vault_sync')
    : null;

  function publicarEventoPestanas(tipo, detalle = {}) {
    if (!canalSync) return;
    try {
      canalSync.postMessage({ tipo, detalle, ts: Date.now() });
    } catch { /* noop */ }
  }

  if (canalSync) {
    canalSync.onmessage = (e) => {
      const msg = e?.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.tipo === 'VAULT_LOCKED' && claveActivaRAM !== null) {
        bloquear(msg.detalle?.razon || 'MULTI_TAB_LOCK', { propagar: false });
      } else if (msg.tipo === 'DATA_UPDATED') {
        notificar('DATA_UPDATED', msg.detalle || {});
      }
    };
  }

  function estaDesbloqueada() {
    return claveActivaRAM !== null;
  }

  function obtenerRol() {
    return rolActivoRAM || 'operador';
  }

  function esAdmin() {
    return rolActivoRAM === 'admin';
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
    if (timerInactividad) {
      clearTimeout(timerInactividad);
      timerInactividad = null;
    }
    if (!claveActivaRAM || !inactividadActiva) return;
    timerInactividad = setTimeout(() => {
      bloquear('INACTIVIDAD');
    }, inactividadMs);
  }

  function configurarInactividad({ activo, minutos } = {}) {
    if (typeof activo === 'boolean') inactividadActiva = activo;
    if (Number.isFinite(Number(minutos)) && Number(minutos) > 0) {
      inactividadMs = Number(minutos) * 60 * 1000;
    }
    reiniciarTimerInactividad();
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

    // Al cerrar o recargar la pestaña, destruimos la clave y el rol en RAM
    window.addEventListener('beforeunload', () => {
      claveActivaRAM = null;
      rolActivoRAM = null;
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
   * Comprueba si ya existe una bóveda inicializada en IndexedDB.
   */
  async function existeBoveda(db) {
    const meta = await obtenerMetaBoveda(db);
    return Boolean(meta && meta.salt && meta.authTag);
  }

  async function verificarClaveAdmin(claveAdminRaw) {
    if (intentosAdminFallidos > 0) {
      const esperaMs = Math.min(4000, intentosAdminFallidos * 600);
      await new Promise((r) => setTimeout(r, esperaMs));
    }
    const pinIngresado = String(claveAdminRaw || '').trim().toUpperCase();
    if (!pinIngresado) {
      intentosAdminFallidos++;
      throw new Error('Clave de administrador incorrecta.');
    }
    const preHash = await CryptoEngine.hashSHA256Hex(SALT_LICENCIA_ADMIN_PRE + pinIngresado, true);
    const derivado = await CryptoEngine.derivarVerificadorPBKDF2Hex(
      preHash,
      SALT_LICENCIA_ADMIN_KDF,
      600000
    );
    if (!CryptoEngine.compararTiempoConstante(derivado, VERIFICADOR_LICENCIA_ADMIN_PBKDF2)) {
      intentosAdminFallidos++;
      throw new Error('Clave de administrador incorrecta.');
    }
    intentosAdminFallidos = 0;
  }

  /**
   * REGISTRO / INICIALIZACIÓN DE BÓVEDA:
   * Crea un salt aleatorio de 16 bytes, deriva la CryptoKey con PBKDF2 (600k iteraciones),
   * cifra el payload testigo con un IV único de 12 bytes + AAD y persiste con `.add()`
   * atómico para impedir condiciones de carrera entre pestañas.
   */
  async function inicializarBoveda(db, password, opciones = {}) {
    const yaExiste = await existeBoveda(db);
    if (yaExiste) {
      throw new Error('Ya existe una contraseña maestra configurada en este equipo. No es posible registrar un nuevo usuario sobre una bóveda activa.');
    }

    if (!password || String(password).length < 6) {
      throw new Error('La contraseña maestra debe tener al menos 6 caracteres.');
    }

    const rolSolicitado = opciones.rol === 'admin' ? 'admin' : 'operador';
    if (rolSolicitado === 'admin') {
      await verificarClaveAdmin(opciones.claveAdmin);
    }

    const salt = CryptoEngine.generarBytesAleatorios(CryptoEngine.SALT_BYTES);
    const key = await CryptoEngine.derivarClaveMaestra(password, salt);

    const testigoPayload = {
      canary: TESTIGO_CANARY,
      rol: rolSolicitado,
      createdAt: new Date().toISOString(),
    };
    const { iv: authIv, ciphertext: authTag } = await CryptoEngine.cifrarPayload(
      key,
      testigoPayload,
      AAD_META_CONFIG
    );

    await new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_META], 'readwrite');
      const store = tx.objectStore(STORE_META);
      const req = store.add({
        id: 'config',
        salt,
        authIv,
        authTag,
        aadVersion: 1,
        iterations: CryptoEngine.PBKDF2_ITERATIONS,
        algoritmo: 'AES-GCM-256 / PBKDF2-SHA256',
        creadoEn: testigoPayload.createdAt,
      });
      req.onerror = (e) => {
        e.preventDefault();
        reject(new Error('Ya existe una contraseña maestra configurada en este equipo.'));
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(new Error('No se pudo guardar la configuración de la bóveda.'));
    });

    intentosFallidos = 0;
    claveActivaRAM = key;
    rolActivoRAM = rolSolicitado;
    reiniciarTimerInactividad();
    notificar('UNLOCKED', { recienCreada: true, rol: rolActivoRAM });
    return true;
  }

  async function actualizarEstadoIntentos(db, config, fallos, lockoutUntil) {
    if (!config) return;
    return new Promise((resolve) => {
      const tx = db.transaction([STORE_META], 'readwrite');
      tx.objectStore(STORE_META).put({
        ...config,
        id: 'config',
        failedAttempts: fallos,
        lockoutUntil: lockoutUntil || 0,
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    });
  }

  async function desbloquear(db, password) {
    if (!password) throw new Error('Introduce tu contraseña maestra.');
    if (desbloqueandoEnCurso) {
      throw new Error('Verificación en curso. Espera un momento.');
    }

    desbloqueandoEnCurso = true;
    try {
      const config = await obtenerMetaBoveda(db);
      if (!config) {
        throw new Error('NO_VAULT_FOUND');
      }

      const fallosPersistidos = Math.max(intentosFallidos, Number(config.failedAttempts) || 0);
      const bloqueoHasta = Number(config.lockoutUntil) || 0;
      const ahora = Date.now();
      if (bloqueoHasta > ahora) {
        const segs = Math.ceil((bloqueoHasta - ahora) / 1000);
        throw new Error(`Demasiados intentos fallidos. Espera ${segs} s antes de volver a intentar.`);
      }

      if (fallosPersistidos > 0) {
        const esperaMs = Math.min(4000, fallosPersistidos * 450);
        await new Promise((r) => setTimeout(r, esperaMs));
      }

      const candidateKey = await CryptoEngine.derivarClaveMaestra(
        password,
        config.salt,
        config.iterations || CryptoEngine.PBKDF2_ITERATIONS
      );
      let rolDescifrado = 'operador';
      const aad = config.aadVersion === 1 ? AAD_META_CONFIG : null;

      try {
        const testigoDescifrado = await CryptoEngine.descifrarPayload(
          candidateKey,
          config.authIv,
          config.authTag,
          aad
        );

        if (!testigoDescifrado || testigoDescifrado.canary !== TESTIGO_CANARY) {
          throw new Error('CANARY_MISMATCH');
        }
        rolDescifrado = testigoDescifrado.rol === 'admin' ? 'admin' : 'operador';
      } catch {
        intentosFallidos = fallosPersistidos + 1;
        const nuevoLockout = intentosFallidos >= 5
          ? Date.now() + Math.min(30000, (intentosFallidos - 4) * 3000)
          : 0;
        await actualizarEstadoIntentos(db, config, intentosFallidos, nuevoLockout);
        const err = new Error('Contraseña incorrecta.');
        err.code = 'INVALID_PASSWORD';
        err.intentos = intentosFallidos;
        throw err;
      }

      if (fallosPersistidos > 0 || bloqueoHasta > 0) {
        await actualizarEstadoIntentos(db, config, 0, 0);
      }
      intentosFallidos = 0;
      claveActivaRAM = candidateKey;
      rolActivoRAM = rolDescifrado;
      reiniciarTimerInactividad();
      notificar('UNLOCKED', { recienCreada: false, rol: rolActivoRAM });
      return true;
    } finally {
      desbloqueandoEnCurso = false;
    }
  }

  /**
   * LOGOUT / AUTO-LOCK:
   * Destruye la referencia a la CryptoKey en memoria RAM inmediatamente y sincroniza pestañas.
   */
  function bloquear(razon = 'MANUAL', { propagar = true } = {}) {
    claveActivaRAM = null;
    rolActivoRAM = null;
    if (timerInactividad) {
      clearTimeout(timerInactividad);
      timerInactividad = null;
    }
    if (propagar) {
      publicarEventoPestanas('VAULT_LOCKED', { razon });
    }
    notificar('LOCKED', { razon });
  }

  async function cambiarPassword(db, passActual, passNueva, onRekeyData) {
    if (!passActual) throw new Error('Introduce tu contraseña actual.');
    if (!passNueva || String(passNueva).length < 6) {
      throw new Error('La nueva contraseña debe tener al menos 6 caracteres.');
    }

    const config = await obtenerMetaBoveda(db);
    if (!config) {
      throw new Error('No hay una bóveda configurada en este equipo.');
    }

    const fallosPersistidos = Math.max(intentosFallidos, Number(config.failedAttempts) || 0);
    const bloqueoHasta = Number(config.lockoutUntil) || 0;
    const ahora = Date.now();
    if (bloqueoHasta > ahora) {
      const segs = Math.ceil((bloqueoHasta - ahora) / 1000);
      throw new Error(`Demasiados intentos fallidos. Espera ${segs} s antes de volver a intentar.`);
    }
    if (fallosPersistidos > 0) {
      const esperaMs = Math.min(4000, fallosPersistidos * 450);
      await new Promise((r) => setTimeout(r, esperaMs));
    }

    const oldKey = await CryptoEngine.derivarClaveMaestra(
      passActual,
      config.salt,
      config.iterations || CryptoEngine.PBKDF2_ITERATIONS
    );
    const oldAad = config.aadVersion === 1 ? AAD_META_CONFIG : null;
    let testigoDescifrado;
    try {
      testigoDescifrado = await CryptoEngine.descifrarPayload(
        oldKey,
        config.authIv,
        config.authTag,
        oldAad
      );
      if (!testigoDescifrado || testigoDescifrado.canary !== TESTIGO_CANARY) {
        throw new Error('CANARY_MISMATCH');
      }
    } catch {
      intentosFallidos = fallosPersistidos + 1;
      const nuevoLockout = intentosFallidos >= 5
        ? Date.now() + Math.min(30000, (intentosFallidos - 4) * 3000)
        : 0;
      await actualizarEstadoIntentos(db, config, intentosFallidos, nuevoLockout);
      throw new Error('La contraseña actual es incorrecta.');
    }

    const newSalt = CryptoEngine.generarBytesAleatorios(CryptoEngine.SALT_BYTES);
    const newIterations = CryptoEngine.PBKDF2_ITERATIONS;
    const newKey = await CryptoEngine.derivarClaveMaestra(passNueva, newSalt, newIterations);

    const rol = testigoDescifrado.rol === 'admin' ? 'admin' : 'operador';
    const nuevoTestigo = {
      canary: TESTIGO_CANARY,
      rol,
      createdAt: testigoDescifrado.createdAt || config.creadoEn || new Date().toISOString(),
      rotatedAt: new Date().toISOString(),
    };
    const { iv: newAuthIv, ciphertext: newAuthTag } = await CryptoEngine.cifrarPayload(
      newKey,
      nuevoTestigo,
      AAD_META_CONFIG
    );
    const nuevoConfig = {
      ...config,
      id: 'config',
      salt: newSalt,
      authIv: newAuthIv,
      authTag: newAuthTag,
      aadVersion: 1,
      iterations: newIterations,
      failedAttempts: 0,
      lockoutUntil: 0,
    };

    if (typeof onRekeyData === 'function') {
      await onRekeyData(oldKey, newKey, nuevoConfig);
    } else {
      await new Promise((resolve, reject) => {
        const tx = db.transaction([STORE_META], 'readwrite');
        tx.objectStore(STORE_META).put(nuevoConfig);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(new Error('No se pudo actualizar la configuración de la bóveda.'));
      });
    }

    intentosFallidos = 0;
    claveActivaRAM = newKey;
    rolActivoRAM = rol;
    reiniciarTimerInactividad();
    publicarEventoPestanas('DATA_UPDATED', { origen: 'REKEY' });
    return true;
  }

  function suscribir(fn) {
    suscriptores.add(fn);
    return () => suscriptores.delete(fn);
  }

  function notificar(evento, detalle = {}) {
    suscriptores.forEach((fn) => {
      try {
        fn(evento, detalle);
      } catch (err) {
        console.warn('[Vault] Error en suscriptor:', err);
      }
    });
  }

  conectarMonitoreoActividad();

  return Object.freeze({
    STORE_META,
    estaDesbloqueada,
    obtenerRol,
    esAdmin,
    obtenerClaveActiva,
    existeBoveda,
    obtenerMetaBoveda,
    inicializarBoveda,
    desbloquear,
    bloquear,
    configurarInactividad,
    cambiarPassword,
    suscribir,
    publicarEventoPestanas,
  });
})();
