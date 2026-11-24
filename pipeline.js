/* ============================================================================
 *  CifraControl · Motor del Pipeline de Limpieza (JS Nativo + Web Worker)
 * ============================================================================
 *  Ejecuta el pipeline exacto (Partes A y B de Initial_EDA) en un Web Worker
 *  local sin Pyodide ni CDN, manteniendo la interfaz 100% fluida.
 *  Soporta archivos .xlsx, .xls y .csv/.tsv.
 * ========================================================================== */

'use strict';

const Pipeline = (() => {
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

    return new Promise((resolve, reject) => {
      const worker = new Worker('pipeline-worker.js');
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error('Tiempo máximo de procesamiento agotado (archivo demasiado grande o complejo).'));
      }, 45000);

      worker.onmessage = (e) => {
        const msg = e.data;
        if (!msg) return;
        if (msg.tipo === 'progreso') {
          if (onProgress) onProgress(msg.pct, msg.msg);
          return;
        }
        if (msg.tipo === 'listo') {
          clearTimeout(timer);
          worker.terminate();
          if (onProgress) onProgress(100, '¡Limpieza completada!');
          resolve(msg.resultado);
          return;
        }
        if (msg.tipo === 'error') {
          clearTimeout(timer);
          worker.terminate();
          reject(new Error(msg.mensaje || 'Error al ejecutar el pipeline.'));
        }
      };

      worker.onerror = (err) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(err?.message || 'Error interno en el Web Worker del pipeline.'));
      };

      worker.postMessage({ nombre: archivo.name, buffer }, [buffer]);
    });
  }

  return { procesarArchivo };
})();
