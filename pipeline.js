/* ============================================================================
 *  CifraControl · Motor del Pipeline de Limpieza (JS Nativo + Web Worker)
 * ============================================================================
 *  Ejecuta el pipeline exacto (Partes A y B de Initial_EDA) en un Web Worker
 *  local sin Pyodide ni CDN, manteniendo la interfaz 100% fluida.
 *  Soporta archivos .xlsx, .xls y .csv/.tsv con timeout adaptativo y cancelación.
 * ========================================================================== */

'use strict';

const Pipeline = (() => {
  let workerActivo = null;

  function cancelarActivo() {
    if (workerActivo) {
      try {
        workerActivo.terminate();
      } catch { /* noop */ }
      workerActivo = null;
    }
  }

  /**
   * Ejecuta el pipeline de limpieza sobre un objeto File del navegador
   * delegando el trabajo pesado a `pipeline-worker.js`.
   * Acepta `bufferPreleido` opcional para evitar leer el archivo dos veces de disco.
   */
  async function procesarArchivo(archivo, onProgress, bufferPreleido = null) {
    if (onProgress) onProgress(10, 'Leyendo archivo local…');
    const buffer = bufferPreleido instanceof ArrayBuffer
      ? bufferPreleido
      : await archivo.arrayBuffer();

    cancelarActivo();

    // Timeout adaptativo según tamaño del archivo (mín. 45s, máx. 180s)
    const mb = Math.max(1, buffer.byteLength / (1024 * 1024));
    const timeoutMs = Math.min(180000, Math.max(45000, Math.round(45000 + mb * 6000)));

    return new Promise((resolve, reject) => {
      const worker = new Worker('pipeline-worker.js');
      workerActivo = worker;

      const limpiar = () => {
        clearTimeout(timer);
        if (workerActivo === worker) workerActivo = null;
        worker.terminate();
      };

      const timer = setTimeout(() => {
        limpiar();
        reject(new Error('Tiempo máximo de procesamiento agotado (archivo demasiado grande o complejo).'));
      }, timeoutMs);

      worker.onmessage = (e) => {
        const msg = e.data;
        if (!msg) return;
        if (msg.tipo === 'progreso') {
          if (onProgress) onProgress(msg.pct, msg.msg);
          return;
        }
        if (msg.tipo === 'listo') {
          limpiar();
          if (onProgress) onProgress(100, '¡Limpieza completada!');
          resolve(msg.resultado);
          return;
        }
        if (msg.tipo === 'error') {
          limpiar();
          reject(new Error(msg.mensaje || 'Error al ejecutar el pipeline.'));
        }
      };

      worker.onerror = (err) => {
        limpiar();
        reject(new Error(err?.message || 'Error interno en el Web Worker del pipeline.'));
      };

      worker.postMessage({ nombre: archivo.name, buffer }, [buffer]);
    });
  }

  return Object.freeze({
    procesarArchivo,
    cancelarActivo,
  });
})();
