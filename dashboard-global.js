
/* CifraControl - Globo 3D interactivo */

(() => {
  'use strict';

  const $ = id => document.getElementById(id);

  const colores = [
    '#FF585D',
    '#FF7F32',
    '#5C88DA',
    '#8E3A80',
    '#6CC24A',
    '#D9D9D6'
  ];

  const normalizar = valor =>
    String(valor ?? '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim()
      .toLowerCase();

  const alias = {
    mexico: 'mexico',
    'united states of america': 'estados unidos',
    'united states': 'estados unidos',
    usa: 'estados unidos',
    brazil: 'brasil',
    germany: 'alemania',
    france: 'francia',
    spain: 'espana',
    canada: 'canada',
    china: 'china',
    india: 'india',
    japan: 'japon',
    russia: 'rusia',
    'united kingdom': 'reino unido',
    'south africa': 'sudafrica',
    australia: 'australia',
    argentina: 'argentina',
    colombia: 'colombia',
    chile: 'chile',
    peru: 'peru',
    italy: 'italia',
    portugal: 'portugal'
  };

  const paisClave = valor => {
    const clave = normalizar(valor);
    return alias[clave] || clave;
  };

  let globo = null;
  let filas = [];
  let iniciando = false;
  let iniciado = false;

  const nombrePais = fila =>
    fila.pais ??
    fila.pais_nombre ??
    fila.country ??
    fila.country_name ??
    '';

  const regionFila = fila =>
    fila.region ??
    fila.continente ??
    fila.continent ??
    '';

  function pintar() {
    const region = $('globalRegion')?.value || '';
    const estado = $('globalEstado')?.value || '';
    const pais = $('globalPais')?.value || '';

    const filtradas = filas.filter(fila => {
      if (
        region &&
        String(regionFila(fila)) !== region
      ) return false;

      if (
        pais &&
        paisClave(nombrePais(fila)) !== paisClave(pais)
      ) return false;

      if (
        estado &&
        clasificarEstadoFila(fila) !== estado
      ) return false;

      return true;
    });

    const protegidos = filtradas.filter(
      fila => clasificarEstadoFila(fila) === 'protegido'
    ).length;

    const sinCifrar = filtradas.filter(
      fila => clasificarEstadoFila(fila) === 'sin_cifrar'
    ).length;

    $('globalTotal').textContent =
      filtradas.length.toLocaleString('es-MX');

    $('globalProtegidos').textContent =
      protegidos.toLocaleString('es-MX');

    $('globalCobertura').textContent =
      `${filtradas.length
        ? (100 * protegidos / filtradas.length).toFixed(1)
        : '0'} %`;

    $('globalSinCifrar').textContent =
      sinCifrar.toLocaleString('es-MX');

    $('globalSeleccion').textContent =
      [region, pais, estado].filter(Boolean).join(' · ') ||
      'Vista global · Todos los países';

    if (globo) {
      globo
        .polygonAltitude(feature =>
          pais &&
          paisClave(feature.properties.name) === paisClave(pais)
            ? 0.045
            : 0.012
        )
        .polygonStrokeColor(feature =>
          pais &&
          paisClave(feature.properties.name) === paisClave(pais)
            ? '#FFFFFF'
            : 'rgba(255,255,255,0.22)'
        );
    }
  }

  function llenarPaises() {
    const selector = $('globalPais');
    if (!selector) return;

    const anterior = selector.value;
    const region = $('globalRegion')?.value || '';

    const paises = [
      ...new Set(
        filas
          .filter(fila =>
            !region || String(regionFila(fila)) === region
          )
          .map(nombrePais)
          .filter(Boolean)
          .map(String)
      )
    ].sort((a, b) => a.localeCompare(b, 'es'));

    selector.replaceChildren(
      new Option('Todos los países', '')
    );

    paises.forEach(pais => {
      selector.add(new Option(pais, pais));
    });

    if (paises.includes(anterior)) {
      selector.value = anterior;
    }
  }

  async function cargar() {
    if (iniciando) return;

    iniciando = true;

    try {
      const actual = await DB.obtenerActual();
      filas = actual.filas || [];

      const selectorRegion = $('globalRegion');
      const regionAnterior = selectorRegion.value;

      const regiones = [
        ...new Set(
          filas
            .map(regionFila)
            .filter(Boolean)
            .map(String)
        )
      ].sort((a, b) => a.localeCompare(b, 'es'));

      selectorRegion.replaceChildren(
        new Option('Todas las regiones', '')
      );

      regiones.forEach(region => {
        selectorRegion.add(new Option(region, region));
      });

      if (regiones.includes(regionAnterior)) {
        selectorRegion.value = regionAnterior;
      }

      llenarPaises();
      pintar();

      if (!iniciado) {
        await crearGlobo();
      }

      setTimeout(() => {
        if (globo) {
          globo.width($('mapaMundial').clientWidth);
        }
      }, 100);

    } catch (error) {
      console.error('Dashboard global:', error);

      $('globalSeleccion').textContent =
        'No se pudieron cargar los datos de la bóveda';

    } finally {
      iniciando = false;
    }
  }

  async function crearGlobo() {
    const contenedor = $('mapaMundial');

    if (!window.Globe) {
      contenedor.textContent =
        'No se pudo cargar la biblioteca 3D. ' +
        'Comprueba tu conexión a Internet.';
      return;
    }

    const respuesta = await fetch(
      'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson'
    );

    if (!respuesta.ok) {
      throw new Error('No se pudo cargar el mapa mundial');
    }

    const geo = await respuesta.json();
    const paises = geo.features;

    globo = Globe()(contenedor)
      .width(contenedor.clientWidth)
      .height(Math.max(380, contenedor.clientHeight))
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor('#5C88DA')
      .atmosphereAltitude(0.18)
      .globeImageUrl(
        'https://unpkg.com/three-globe/example/img/earth-dark.jpg'
      )
      .polygonsData(paises)

      
.polygonCapColor(feature => {
  const nombre = feature.properties.name || '';

  const grupos = {
    norteamerica: '#5C88DA',
    centroamerica: '#FF7F32',
    sudamerica: '#FF585D',
    neutro: '#34405A'
  };

  const pais = paisClave(nombre);

  const norteamerica = [
    'canada',
    'estados unidos',
    'mexico'
  ];

  const centroamerica = [
    'belize',
    'guatemala',
    'honduras',
    'el salvador',
    'nicaragua',
    'costa rica',
    'panama'
  ];

  const sudamerica = [
    'colombia',
    'venezuela',
    'guyana',
    'suriname',
    'ecuador',
    'peru',
    'brasil',
    'bolivia',
    'paraguay',
    'chile',
    'argentina',
    'uruguay'
  ];

  if (norteamerica.includes(pais)) return grupos.norteamerica;
  if (centroamerica.includes(pais)) return grupos.centroamerica;
  if (sudamerica.includes(pais)) return grupos.sudamerica;

  return grupos.neutro;
})

      .polygonSideColor(
        () => 'rgba(255,255,255,0.09)'
      )

      .polygonStrokeColor(
        () => 'rgba(255,255,255,0.22)'
      )

      // Separa las caras del GeoJSON de la textura para evitar z-fighting
      // (triángulos negros y cortes visuales en WebGL).
      .polygonAltitude(0.012)
      .polygonCapCurvatureResolution(3)

      .polygonLabel(feature => {
        const nombre = String(
          feature.properties.name || ''
        ).replace(/&/g, '&amp;')
         .replace(/</g, '&lt;')
         .replace(/>/g, '&gt;');

        return `
          <div style="
            background:#111827;
            color:white;
            padding:8px 12px;
            border:1px solid #5C88DA;
            border-radius:8px;
          ">
            ${nombre}
          </div>
        `;
      })

      .onPolygonClick(feature => {
        const nombre = paisClave(
          feature.properties.name
        );

        const selector = $('globalPais');

        const opcion = [...selector.options].find(
          item => paisClave(item.value) === nombre
        );

        if (opcion) {
          selector.value = opcion.value;
          pintar();
        } else {
          $('globalSeleccion').textContent =
            `${feature.properties.name} · Sin registros asociados`;
        }
      });

    globo.pointOfView({
      lat: 15,
      lng: -35,
      altitude: 2.25
    }, 0);

    globo.controls().autoRotate = false;
    globo.controls().enableDamping = true;

    window.addEventListener('resize', () => {
      if (
        globo &&
        !contenedor.closest('[hidden]')
      ) {
        globo.width(contenedor.clientWidth);
      }
    });

    iniciado = true;
  }

  function iniciar() {
    if (!$('globalRegion')) return;

    $('globalRegion').addEventListener('change', () => {
      llenarPaises();
      pintar();
    });

    $('globalPais').addEventListener('change', pintar);

    $('globalEstado').addEventListener('change', pintar);

    $('globalLimpiar').addEventListener('click', () => {
      $('globalRegion').value = '';
      $('globalEstado').value = '';

      llenarPaises();

      $('globalPais').value = '';

      pintar();
    });

    [
      ['globalVerResumen', 'resumen'],
      ['globalVerInventario', 'inventario'],
      ['globalVerExcepciones', 'excepciones']
    ].forEach(([id, vista]) => {
      $(id)?.addEventListener('click', () => irA(vista));
    });
  }

  document.addEventListener('DOMContentLoaded', iniciar);

  window.CifraGlobo = {
    cargar
  };
})();
