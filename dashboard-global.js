
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

  let mapaSvg = null;
  let mapaPaises = [];
  let mapaGrupo = null;
  let mapaZoom = 1;
  let mapaPanX = 0;
  let mapaPanY = 0;
  let mapaArrastrando = false;
  let mapaSeMovio = false;
  let mapaInicioX = 0;
  let mapaInicioY = 0;
  let mapaUltimoArrastre = 0;
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

    actualizarSeleccionMapa(pais);
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
        await crearMapa2D();
      }

      setTimeout(() => {
        ajustarMapa2D();
      }, 100);

    } catch (error) {
      console.error('Dashboard global:', error);

      $('globalSeleccion').textContent =
        'No se pudieron cargar los datos de la bóveda';

    } finally {
      iniciando = false;
    }
  }

  function proyectar([longitud, latitud]) {
    return [
      ((longitud + 180) / 360) * 960,
      ((90 - latitud) / 180) * 480
    ];
  }

  function crearRutaAnillo(anillo) {
    return anillo
      .map((coordenada, indice) => {
        const [x, y] = proyectar(coordenada);
        return `${indice === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ') + ' Z';
  }

  function crearRutaGeometria(geometria) {
    if (geometria.type === 'Polygon') {
      return geometria.coordinates.map(crearRutaAnillo).join(' ');
    }

    if (geometria.type === 'MultiPolygon') {
      return geometria.coordinates
        .flatMap(poligono => poligono.map(crearRutaAnillo))
        .join(' ');
    }

    return '';
  }

  function colorPais(nombre) {
    const pais = paisClave(nombre);
    const norteamerica = ['canada', 'estados unidos', 'mexico'];
    const centroamerica = [
      'belize', 'guatemala', 'honduras', 'el salvador',
      'nicaragua', 'costa rica', 'panama'
    ];
    const sudamerica = [
      'colombia', 'venezuela', 'guyana', 'suriname', 'ecuador',
      'peru', 'brasil', 'bolivia', 'paraguay', 'chile',
      'argentina', 'uruguay'
    ];

    if (norteamerica.includes(pais)) return '#5C88DA';
    if (centroamerica.includes(pais)) return '#FF7F32';
    if (sudamerica.includes(pais)) return '#FF585D';
    return '#D9DDE8';
  }

  function ajustarMapa2D() {
    if (!mapaSvg) return;

    const contenedor = $('mapaMundial');
    mapaSvg.setAttribute('width', String(contenedor.clientWidth));
    mapaSvg.setAttribute('height', String(Math.max(320, contenedor.clientHeight)));
  }

  function aplicarZoomMapa() {
    if (!mapaGrupo) return;

    mapaGrupo.setAttribute(
      'transform',
      `translate(${mapaPanX} ${mapaPanY}) translate(480 240) scale(${mapaZoom}) translate(-480 -240)`
    );
  }

  function activarArrastreMapa(svg) {
    svg.addEventListener('pointerdown', evento => {
      if (evento.button !== 0) return;

      mapaArrastrando = true;
      mapaSeMovio = false;
      mapaInicioX = evento.clientX - mapaPanX;
      mapaInicioY = evento.clientY - mapaPanY;
      svg.setPointerCapture(evento.pointerId);
      svg.classList.add('is-arrastrando');
    });

    svg.addEventListener('pointermove', evento => {
      if (!mapaArrastrando) return;

      const siguienteX = evento.clientX - mapaInicioX;
      const siguienteY = evento.clientY - mapaInicioY;

      if (Math.abs(siguienteX - mapaPanX) > 2 || Math.abs(siguienteY - mapaPanY) > 2) {
        mapaSeMovio = true;
      }

      mapaPanX = siguienteX;
      mapaPanY = siguienteY;
      aplicarZoomMapa();
    });

    const terminarArrastre = evento => {
      if (!mapaArrastrando) return;

      mapaArrastrando = false;
      mapaUltimoArrastre = mapaSeMovio ? performance.now() : 0;
      if (svg.hasPointerCapture(evento.pointerId)) {
        svg.releasePointerCapture(evento.pointerId);
      }
      svg.classList.remove('is-arrastrando');
    };

    svg.addEventListener('pointerup', terminarArrastre);
    svg.addEventListener('pointercancel', terminarArrastre);
  }

  function crearControlesZoom() {
    const controles = document.createElement('div');
    controles.className = 'global-mapa-controles';

    const crearBoton = (texto, etiqueta, cambio) => {
      const boton = document.createElement('button');
      boton.type = 'button';
      boton.className = 'global-mapa-zoom-btn';
      boton.textContent = texto;
      boton.setAttribute('aria-label', etiqueta);
      boton.addEventListener('click', () => {
        mapaZoom = cambio === 0
          ? 1
          : Math.min(3, Math.max(1, mapaZoom + cambio));
        if (cambio === 0) {
          mapaPanX = 0;
          mapaPanY = 0;
        }
        aplicarZoomMapa();
      });
      return boton;
    };

    controles.append(
      crearBoton('+', 'Acercar mapa', 0.25),
      crearBoton('−', 'Alejar mapa', -0.25),
      crearBoton('↺', 'Restablecer zoom del mapa', 0)
    );

    return controles;
  }

  function actualizarSeleccionMapa(paisSeleccionado) {
    mapaPaises.forEach(({ elemento, feature }) => {
      const seleccionado = paisSeleccionado &&
        paisClave(feature.properties.name) === paisClave(paisSeleccionado);

      elemento.classList.toggle('is-seleccionado', seleccionado);
      elemento.setAttribute('stroke-width', seleccionado ? '1.8' : '0.55');
    });
  }

  async function crearMapa2D() {
    const contenedor = $('mapaMundial');

    const respuesta = await fetch(
      'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson'
    );

    if (!respuesta.ok) {
      throw new Error('No se pudo cargar el mapa mundial');
    }

    const geo = await respuesta.json();
    const paises = geo.features;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 960 480');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Mapa mundial 2D');
    svg.classList.add('global-mapa-svg');
    mapaGrupo = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(mapaGrupo);

    mapaPaises = paises.map(feature => {
      const elemento = document.createElementNS(SVG_NS, 'path');
      elemento.setAttribute('d', crearRutaGeometria(feature.geometry));
      elemento.setAttribute('fill', colorPais(feature.properties.name));
      elemento.setAttribute('stroke', 'rgba(255,255,255,0.7)');
      elemento.setAttribute('stroke-width', '0.55');
      elemento.setAttribute('vector-effect', 'non-scaling-stroke');
      elemento.classList.add('global-mapa-pais');
      elemento.addEventListener('click', () => {
        if (performance.now() - mapaUltimoArrastre < 150) return;

        const selector = $('globalPais');
        const nombre = paisClave(feature.properties.name);
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
      mapaGrupo.appendChild(elemento);
      return { elemento, feature };
    });

    contenedor.replaceChildren(crearControlesZoom(), svg);
    mapaSvg = svg;
    mapaZoom = 1;
    mapaPanX = 0;
    mapaPanY = 0;
    aplicarZoomMapa();
    ajustarMapa2D();
    actualizarSeleccionMapa($('globalPais')?.value || '');
    activarArrastreMapa(svg);

    svg.addEventListener('wheel', evento => {
      evento.preventDefault();
      mapaZoom = Math.min(3, Math.max(1, mapaZoom + (evento.deltaY < 0 ? 0.15 : -0.15)));
      aplicarZoomMapa();
    }, { passive: false });

    window.addEventListener('resize', () => {
      if (!contenedor.closest('[hidden]')) ajustarMapa2D();
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
