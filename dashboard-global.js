
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

const filtrosMulti = {
  region: new Set(),
  pais: new Set(),
  estado: new Set()
};

const opcionesFiltro = {
  region: [],
  pais: [],
  estado: [
    { valor: 'protegido', texto: 'Protegido' },
    { valor: 'parcial', texto: 'Parcial' },
    { valor: 'sin_cifrar', texto: 'Sin cifrar' }
  ]
};

function valoresFiltro(tipo) {
  return [...filtrosMulti[tipo]];
}

function actualizarMenuMulti(tipo) {
  const contenedor = document.querySelector(
    `.global-multi[data-filtro="${tipo}"]`
  );
  if (!contenedor) return;

  const menu = contenedor.querySelector('.global-multi-menu');
  const texto = contenedor.querySelector('.global-multi-texto');
  const seleccionados = filtrosMulti[tipo];

  const nombres = {
    region: 'Todas las regiones',
    pais: 'Todos los países',
    estado: 'Todos los estados'
  };

  menu.replaceChildren();

  opcionesFiltro[tipo].forEach(opcion => {
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    const span = document.createElement('span');

    checkbox.type = 'checkbox';
    checkbox.value = opcion.valor;
    checkbox.checked = seleccionados.has(opcion.valor);
    span.textContent = opcion.texto;

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        seleccionados.add(opcion.valor);
      } else {
        seleccionados.delete(opcion.valor);
      }

      if (tipo === 'region') llenarPaises();

      actualizarTextoMulti(tipo);
      pintar();
    });

    label.append(checkbox, span);
    menu.append(label);
  });

  actualizarTextoMulti(tipo);
}

function actualizarTextoMulti(tipo) {
  const contenedor = document.querySelector(
    `.global-multi[data-filtro="${tipo}"]`
  );
  if (!contenedor) return;

  const texto = contenedor.querySelector('.global-multi-texto');
  const seleccionados = valoresFiltro(tipo);

  const nombres = {
    region: 'Todas las regiones',
    pais: 'Todos los países',
    estado: 'Todos los estados'
  };

  texto.textContent = seleccionados.length
    ? seleccionados.join(', ')
    : nombres[tipo];
}

function configurarMenusMulti() {
  document.querySelectorAll('.global-multi').forEach(contenedor => {
    const boton = contenedor.querySelector('.global-multi-boton');
    const menu = contenedor.querySelector('.global-multi-menu');

    boton.addEventListener('click', () => {
      const abrir = menu.hidden;

      document.querySelectorAll('.global-multi-menu')
        .forEach(otro => { otro.hidden = true; });

      document.querySelectorAll('.global-multi-boton')
        .forEach(otro => otro.setAttribute('aria-expanded', 'false'));

      menu.hidden = !abrir;
      boton.setAttribute('aria-expanded', String(abrir));
    });
  });

  document.addEventListener('click', evento => {
    if (evento.target.closest('.global-multi')) return;

    document.querySelectorAll('.global-multi-menu')
      .forEach(menu => { menu.hidden = true; });

    document.querySelectorAll('.global-multi-boton')
      .forEach(boton => boton.setAttribute('aria-expanded', 'false'));
  });
}

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

  function pintarBarras(id, items, total) {
    const contenedor = $(id);
    if (!contenedor) return;

    contenedor.replaceChildren();

    if (!items.length) {
      const vacio = document.createElement('p');
      vacio.className = 'global-grafica-vacia';
      vacio.textContent = 'Sin datos para mostrar';
      contenedor.append(vacio);
      return;
    }

    items.forEach(({ etiqueta, valor, color }) => {
      const fila = document.createElement('div');
      fila.className = 'global-barra-fila';

      const cabecera = document.createElement('div');
      cabecera.className = 'global-barra-cabecera';

      const nombre = document.createElement('span');
      nombre.textContent = etiqueta;

      const cantidad = document.createElement('strong');

const porcentaje = total ? (valor / total * 100).toFixed(1) : '0.0';

cantidad.innerHTML = `
  ${valor.toLocaleString('es-MX')}
  <span style="color: #94a3b8; font-size: 12px; font-weight: 400;">
    (${porcentaje}%)
  </span>
`;

      const pista = document.createElement('div');
      pista.className = 'global-barra-pista';

      const progreso = document.createElement('span');
      progreso.className = 'global-barra-progreso';
      progreso.style.width = `${total ? (valor / total) * 100 : 0}%`;
      progreso.style.backgroundColor = color;

      cabecera.append(nombre, cantidad);
      pista.append(progreso);
      fila.append(cabecera, pista);
      contenedor.append(fila);
    });
  }


function obtenerColumnaSO(fila, nombres) {
  const normalizarClave = texto => String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const claves = Object.keys(fila);
  const encontrada = claves.find(clave =>
    nombres.some(nombre =>
      normalizarClave(clave) === normalizarClave(nombre)
    )
  );

  return encontrada ? String(fila[encontrada] ?? '').trim() : '';
}

function nombreSistemaOperativo(fila) {
  const sistema = obtenerColumnaSO(fila, [
    'Sistema Operativo',
    'sistema_operativo',
    'sistemaOperativo',
    'so',
    'os'
  ]);

  const version = obtenerColumnaSO(fila, [
    'Versión SO',
    'version_so',
    'versionSO',
    'version_sistema_operativo'
  ]);

  const so = normalizar(sistema);
  const ver = normalizar(version);

  if (so.includes('windows')) {
    if (/windows\s*11|10\.0\.(22000|22621|22631|26100|26200)/.test(ver)) {
      return 'Windows 11';
    }

    if (/windows\s*10|10\.0\.(1904[1-5]|1836[2-3]|17763|10240)/.test(ver)) {
      return 'Windows 10';
    }

    return 'Windows sin versión identificada';
  }

  if (so.includes('mac') || so.includes('os x')) return 'macOS';
  if (so.includes('linux')) return 'Linux';

  return sistema || 'Sin sistema operativo';
}

function pintarGraficaSO(filtradas) {
  const contenedor = $('globalSOGrafica');
  if (!contenedor) return;

  contenedor.replaceChildren();

  const grupos = new Map();

  filtradas.forEach(fila => {
    const nombre = nombreSistemaOperativo(fila);

    if (!grupos.has(nombre)) {
      grupos.set(nombre, { total: 0, cifrados: 0 });
    }

    const grupo = grupos.get(nombre);
    grupo.total++;

    if (clasificarEstadoFila(fila) === 'protegido') {
      grupo.cifrados++;
    }
  });

  const resultados = [...grupos.entries()]
    .map(([nombre, datos]) => ({
      nombre,
      total: datos.total,
      porcentaje: datos.total
        ? datos.cifrados / datos.total * 100
        : 0
    }))
    .sort((a, b) => a.porcentaje - b.porcentaje);

  if (!resultados.length) {
    contenedor.textContent = 'No hay datos para mostrar.';
    return;
  }

  resultados.forEach(item => {
    const fila = document.createElement('div');
    fila.className = 'global-so-fila';

    const nombre = document.createElement('span');
    nombre.className = 'global-so-nombre';
    nombre.textContent = item.nombre;

    const pista = document.createElement('div');
    pista.className = 'global-so-pista';

    const barra = document.createElement('div');
    barra.className = 'global-so-barra';
    barra.style.width = `${item.porcentaje}%`;

    barra.style.backgroundColor =
      item.porcentaje < 75 ? '#EA580C' :
      item.porcentaje < 85 ? '#F2A582' :
      item.porcentaje < 95 ? '#79A5C9' :
      '#2563EB';

    pista.append(barra);

    const resultado = document.createElement('strong');
    resultado.className = 'global-so-resultado';
    resultado.textContent =
      `${item.porcentaje.toFixed(1)}% · ${item.total.toLocaleString('es-MX')}`;

    fila.append(nombre, pista, resultado);
    contenedor.append(fila);
  });
}

function valorGestion(fila, nombres) {
  const normalizarClave = texto => normalizar(texto).replace(/[^a-z0-9]/g, '');
  const clave = Object.keys(fila).find(actual =>
    nombres.some(nombre => normalizarClave(actual) === normalizarClave(nombre))
  );
  return clave ? fila[clave] : '';
}

function esDatoVerdadero(valor) {
  const texto = normalizar(valor);
  return ['si', 'sí', 'yes', 'true', '1', 'enrolled', 'managed', 'activo', 'activa'].includes(texto);
}

function pintarCoberturaGestion(filtradas) {
  const contenedor = $('globalGestionGrafica');
  if (!contenedor) return;

  contenedor.replaceChildren();
  const total = filtradas.length;

  const mdm = filtradas.filter(fila => esDatoVerdadero(valorGestion(fila, [
    'En MDM', 'en_mdm', 'en_mdm_bool', 'mdm'
  ]))).length;
  const activeDirectory = filtradas.filter(fila => esDatoVerdadero(valorGestion(fila, [
    'En AD', 'en_ad', 'en_ad_bool', 'active_directory', 'active directory'
  ]))).length;
  const porcentaje = valor => total ? (valor / total) * 100 : 0;
  const indicadores = [
    { valor: porcentaje(mdm), etiqueta: 'En MDM' },
    { valor: porcentaje(activeDirectory), etiqueta: 'En Active Directory' }
  ];

  const resumen = document.createElement('div');
  resumen.className = 'global-gestion-resumen';

  indicadores.forEach(indicador => {
    const item = document.createElement('div');
    item.className = 'global-gestion-indicador';

    const anillo = document.createElement('div');
    anillo.className = 'global-gestion-anillo';
    anillo.style.setProperty('--gestion-porcentaje', `${indicador.valor}%`);
    anillo.setAttribute('aria-label', `${indicador.valor.toFixed(1)}% ${indicador.etiqueta}`);

    const contenido = document.createElement('div');
    contenido.className = 'global-gestion-anillo-centro';
    contenido.textContent = `${indicador.valor.toFixed(1)}%`;
    anillo.append(contenido);

    const etiqueta = document.createElement('span');
    etiqueta.textContent = indicador.etiqueta;
    item.append(anillo, etiqueta);
    resumen.append(item);
  });

  contenedor.append(resumen);
}

function valorFilaCritica(fila, nombres) {
  const normalizarClave = texto => normalizar(texto).replace(/[^a-z0-9]/g, '');
  const claves = Object.keys(fila);
  const clave = claves.find(actual =>
    nombres.some(nombre => normalizarClave(actual) === normalizarClave(nombre))
  );
  return clave ? String(fila[clave] ?? '').trim() : '';
}

function nombreEquipoCritico(fila) {
  return valorFilaCritica(fila, [
    'nombre_equipo', 'equipo', 'hostname', 'host', 'device_name',
    'asset_name', 'activo', 'serial', 'numero_serie', 'id'
  ]) || 'Equipo sin identificar';
}

function puntuarEquipoCritico(fila) {
  const estado = clasificarEstadoFila(fila);
  const usuario = valorFilaCritica(fila, [
    'usuario', 'usuario_asignado', 'responsable', 'assigned_user', 'owner'
  ]);
  const ultimaConexion = valorFilaCritica(fila, [
    'ultimo_acceso', 'ultima_conexion', 'last_seen', 'last_login', 'fecha_ultimo_acceso'
  ]);

  let puntaje = estado === 'sin_cifrar' ? 100 : estado === 'parcial' ? 55 : 0;
  if (!usuario) puntaje += 10;

  const fecha = Date.parse(ultimaConexion);
  if (ultimaConexion && !Number.isNaN(fecha)) {
    const dias = (Date.now() - fecha) / 86400000;
    if (dias > 90) puntaje += 20;
  }

  return puntaje;
}

function pintarEquiposCriticos(filtradas) {
  const contenedor = $('globalCriticosGrafica');
  const contador = $('globalCriticosConteo');
  if (!contenedor) return;

  contenedor.replaceChildren();

  const equipos = filtradas
    .map(fila => ({ fila, puntaje: puntuarEquipoCritico(fila) }))
    .filter(item => item.puntaje > 0)
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, 5);

  if (contador) contador.textContent = `${equipos.length} alertas`;

  if (!equipos.length) {
    const vacio = document.createElement('p');
    vacio.className = 'global-grafica-vacia';
    vacio.textContent = 'No hay equipos críticos con los filtros actuales.';
    contenedor.append(vacio);
    return;
  }

  equipos.forEach(({ fila }) => {
    const estado = clasificarEstadoFila(fila);
    const item = document.createElement('div');
    item.className = 'global-critico-item';

    const nombre = document.createElement('strong');
    nombre.textContent = nombreEquipoCritico(fila);

    const detalle = document.createElement('span');
    detalle.className = 'global-critico-problema';
    detalle.textContent = estado === 'sin_cifrar'
      ? 'Sin cifrado'
      : estado === 'parcial'
        ? 'Datos incompletos'
        : 'Requiere revisión';

    const pais = nombrePais(fila);
    if (pais) detalle.textContent += ` · ${pais}`;

    const nivel = document.createElement('span');
    nivel.className = `global-critico-estado global-critico-estado--${estado}`;
    nivel.textContent = estado === 'sin_cifrar' ? 'Crítica' : 'Media';

    item.append(nombre, detalle, nivel);
    contenedor.append(item);
  });
}


function obtenerColumnaSO(fila, nombres) {
  const normalizarClave = texto => String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

  const claves = Object.keys(fila);
  const encontrada = claves.find(clave =>
    nombres.some(nombre =>
      normalizarClave(clave) === normalizarClave(nombre)
    )
  );

  return encontrada ? String(fila[encontrada] ?? '').trim() : '';
}

function nombreSistemaOperativo(fila) {
  const sistema = obtenerColumnaSO(fila, [
    'Sistema Operativo',
    'sistema_operativo',
    'sistemaOperativo',
    'so',
    'os'
  ]);

  const version = obtenerColumnaSO(fila, [
    'Versión SO',
    'version_so',
    'versionSO',
    'version_sistema_operativo'
  ]);

  const so = normalizar(sistema);
  const ver = normalizar(version);

  if (so.includes('windows')) {
    if (/windows\s*11|10\.0\.(22000|22621|22631|26100|26200)/.test(ver)) {
      return 'Windows 11';
    }

    if (/windows\s*10|10\.0\.(1904[1-5]|1836[2-3]|17763|10240)/.test(ver)) {
      return 'Windows 10';
    }

    return 'Windows sin versión identificada';
  }

  if (so.includes('mac') || so.includes('os x')) return 'macOS';
  if (so.includes('linux')) return 'Linux';

  return sistema || 'Sin sistema operativo';
}

function pintarGraficaSO(filtradas) {
  const contenedor = $('globalSOGrafica');
  if (!contenedor) return;

  contenedor.replaceChildren();

  const grupos = new Map();

  filtradas.forEach(fila => {
    const nombre = nombreSistemaOperativo(fila);

    if (!grupos.has(nombre)) {
      grupos.set(nombre, { total: 0, cifrados: 0 });
    }

    const grupo = grupos.get(nombre);
    grupo.total++;

    if (clasificarEstadoFila(fila) === 'protegido') {
      grupo.cifrados++;
    }
  });

  const resultados = [...grupos.entries()]
    .map(([nombre, datos]) => ({
      nombre,
      total: datos.total,
      porcentaje: datos.total
        ? datos.cifrados / datos.total * 100
        : 0
    }))
    .sort((a, b) => a.porcentaje - b.porcentaje);

  if (!resultados.length) {
    contenedor.textContent = 'No hay datos para mostrar.';
    return;
  }

  resultados.forEach(item => {
    const fila = document.createElement('div');
    fila.className = 'global-so-fila';

    const nombre = document.createElement('span');
    nombre.className = 'global-so-nombre';
    nombre.textContent = item.nombre;

    const pista = document.createElement('div');
    pista.className = 'global-so-pista';

    const barra = document.createElement('div');
    barra.className = 'global-so-barra';
    barra.style.width = `${item.porcentaje}%`;

    barra.style.backgroundColor =
      item.porcentaje < 75 ? '#EA580C' :
      item.porcentaje < 85 ? '#F2A582' :
      item.porcentaje < 95 ? '#79A5C9' :
      '#2563EB';

    pista.append(barra);

    const resultado = document.createElement('strong');
    resultado.className = 'global-so-resultado';
    resultado.textContent =
      `${item.porcentaje.toFixed(1)}% · ${item.total.toLocaleString('es-MX')}`;

    fila.append(nombre, pista, resultado);
    contenedor.append(fila);
  });
}



function pintarGraficaCumplimiento(filtradas) {
  const contenedor = $('globalCumplimientoGrafica');
  if (!contenedor) return;

  contenedor.replaceChildren();

  const total = filtradas.length;

  const categorias = [
    {
      nombre: 'Cumple',
      clave: 'protegido',
      color: '#32658B'
    },
    {
      nombre: 'No cumple',
      clave: 'sin_cifrar',
      color: '#E86B20'
    },
    {
      nombre: 'No evaluado',
      clave: 'parcial',
      color: '#9CA3AF'
    }
  ];

  const conteos = {
    protegido: 0,
    sin_cifrar: 0,
    parcial: 0
  };

  filtradas.forEach(fila => {
    const estado = clasificarEstadoFila(fila);

    if (estado === 'protegido') {
      conteos.protegido++;
    } else if (estado === 'sin_cifrar') {
      conteos.sin_cifrar++;
    } else {
      conteos.parcial++;
    }
  });

  const barra = document.createElement('div');
  barra.className = 'global-cumplimiento-barra';

  const resumen = document.createElement('div');
  resumen.className = 'global-cumplimiento-resumen';

  categorias.forEach(categoria => {
    const cantidad = conteos[categoria.clave];
    const porcentaje = total
      ? (cantidad / total) * 100
      : 0;

    const segmento = document.createElement('div');
    segmento.style.width = `${porcentaje}%`;
    segmento.style.backgroundColor = categoria.color;
    segmento.title =
      `${categoria.nombre}: ${cantidad} equipos (${porcentaje.toFixed(1)}%)`;

    barra.appendChild(segmento);

    const item = document.createElement('div');
    item.className = 'global-cumplimiento-item';

    const valor = document.createElement('strong');
    valor.textContent = `${porcentaje.toFixed(1)}%`;
    valor.style.color = categoria.color;

    const nombre = document.createElement('span');
    nombre.textContent = categoria.nombre;

    item.append(valor, nombre);
    resumen.appendChild(item);
  });

  contenedor.append(barra, resumen);
}

  function actualizarGraficas(filtradas) {
    const porRegion = new Map();
    filtradas.forEach(fila => {
      const region = String(regionFila(fila) || 'Sin región');
      porRegion.set(region, (porRegion.get(region) || 0) + 1);
    });

    const regiones = [...porRegion.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([etiqueta, valor], indice) => ({
        etiqueta,
        valor,
        color: ['#9B2C39', '#B83847', '#D65A66', '#E27180', '#F0A8B1', '#F8D0D5'][indice]
      }));

    const estados = [
      { etiqueta: 'Cifrado', clave: 'protegido', color: '#9B2C39' },
      { etiqueta: 'Parcial', clave: 'parcial', color: '#D65A66' },
      { etiqueta: 'Sin cifrar', clave: 'sin_cifrar', color: '#F0A8B1' }
    ].map(estado => ({
      etiqueta: estado.etiqueta,
      valor: filtradas.filter(fila => clasificarEstadoFila(fila) === estado.clave).length,
      color: estado.color
    })).filter(estado => estado.valor > 0);

    pintarBarras('globalRegionesGrafica', regiones, filtradas.length);
    pintarDonut('globalEstadosGrafica', estados, filtradas.length);

  }

  function pintarDonut(id, items, total) {
    const contenedor = $(id);
    if (!contenedor) return;

    contenedor.replaceChildren();

    const suma = items.reduce((acumulado, item) => acumulado + item.valor, 0);
    const protegido = items.find(item => item.etiqueta === 'Cifrado')?.valor || 0;
    const porcentajeProtegido = total ? (protegido / total) * 100 : 0;

    const segmentos = [];
    let inicio = 0;
    items.forEach(item => {
      const porcentaje = suma ? (item.valor / suma) * 100 : 0;
      segmentos.push(`${item.color} ${inicio}% ${inicio + porcentaje}%`);
      inicio += porcentaje;
    });

    const donut = document.createElement('div');
    donut.className = 'global-donut';
    donut.style.background = segmentos.length
      ? `conic-gradient(${segmentos.join(', ')})`
      : 'var(--fondo-alt)';

    const centro = document.createElement('div');
    centro.className = 'global-donut-centro';

    const valor = document.createElement('strong');
    valor.textContent = `${porcentajeProtegido.toFixed(1)}%`;

    const etiqueta = document.createElement('span');
    etiqueta.textContent = 'Protegido';

    centro.append(valor, etiqueta);
    donut.append(centro);

    const leyenda = document.createElement('div');
    leyenda.className = 'global-donut-leyenda';

    items.forEach(item => {
      const fila = document.createElement('div');
      fila.className = 'global-donut-fila';

      const nombre = document.createElement('span');
      const punto = document.createElement('i');
      punto.className = 'global-donut-punto';
      punto.style.backgroundColor = item.color;
      nombre.append(punto, `${item.etiqueta} (${item.valor.toLocaleString('es-MX')})`);

      const porcentaje = document.createElement('strong');
      porcentaje.textContent = `${total ? ((item.valor / total) * 100).toFixed(1) : '0.0'}%`;

      fila.append(nombre, porcentaje);
      leyenda.append(fila);
    });

    contenedor.append(donut, leyenda);
  }

  function pintar() {
    
  const regiones = valoresFiltro('region');
  const paises = valoresFiltro('pais');
  const estados = valoresFiltro('estado');

  const filtradas = filas.filter(fila => {
    const coincideRegion =
      !regiones.length ||
      regiones.includes(String(regionFila(fila)));

    const coincidePais =
      !paises.length ||
      paises.some(pais =>
        paisClave(nombrePais(fila)) === paisClave(pais)
      );

    const coincideEstado =
      !estados.length ||
      estados.includes(clasificarEstadoFila(fila));

    return coincideRegion && coincidePais && coincideEstado;
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

const totalEquipos = filtradas.length;

const porcentajeCifrados = totalEquipos
  ? (protegidos / totalEquipos) * 100
  : 0;

const porcentajeSinCifrar = totalEquipos
  ? (sinCifrar / totalEquipos) * 100
  : 0;

const colorCoberturaKpi = colorCobertura(porcentajeCifrados);
const tarjetaCobertura = $('globalCobertura').closest('.global-kpi');
tarjetaCobertura?.style.setProperty('--kpi-color', colorCoberturaKpi);
$('globalCobertura').style.color = colorCoberturaKpi;

$('globalBarraCifrados').style.width =
  `${porcentajeCifrados}%`;

$('globalBarraCobertura').style.width =
  `${porcentajeCifrados}%`;

$('globalBarraSinCifrar').style.width =
  `${porcentajeSinCifrar}%`;


    $('globalSeleccion').textContent =
  [...regiones, ...paises, ...estados].join(' · ') ||
  'Vista global · Todos los países';

    actualizarGraficas(filtradas);
    pintarGraficaCumplimiento(filtradas);
    pintarGraficaSO(filtradas);
    pintarEquiposCriticos(filtradas);
    pintarCoberturaGestion(filtradas);
    actualizarVisualMapa();

  }


function llenarPaises() {
  const regiones = valoresFiltro('region');

  const paises = [
    ...new Set(
      filas
        .filter(fila =>
          !regiones.length ||
          regiones.includes(String(regionFila(fila)))
        )
        .map(nombrePais)
        .filter(Boolean)
        .map(String)
    )
  ].sort((a, b) => a.localeCompare(b, 'es'));

  const clavesDisponibles = new Set(paises.map(paisClave));

  [...filtrosMulti.pais].forEach(pais => {
    if (!clavesDisponibles.has(paisClave(pais))) {
      filtrosMulti.pais.delete(pais);
    }
  });

  opcionesFiltro.pais = paises.map(pais => ({
    valor: pais,
    texto: pais
  }));

  actualizarMenuMulti('pais');
}

  async function cargar() {
    if (iniciando) return;

    iniciando = true;

    try {
      const actual = await DB.obtenerActual();
      filas = actual.filas || [];
      const regiones = [
  ...new Set(
    filas.map(regionFila).filter(Boolean).map(String)
  )
].sort((a, b) => a.localeCompare(b, 'es'));

opcionesFiltro.region = regiones.map(region => ({
  valor: region,
  texto: region
}));

actualizarMenuMulti('region');
actualizarMenuMulti('estado');

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

  const paisesObjetivo = new Set([
    'canada', 'estados unidos', 'mexico',
    'belice', 'belize', 'guatemala', 'honduras', 'el salvador',
    'nicaragua', 'costa rica', 'panama',
    'colombia', 'venezuela', 'guyana', 'surinam', 'suriname',
    'ecuador', 'peru', 'brasil', 'brazil', 'bolivia', 'paraguay',
    'chile', 'argentina', 'uruguay'
  ]);

  function esPaisObjetivo(nombre) {
    return paisesObjetivo.has(paisClave(nombre));
  }

  function colorCobertura(porcentaje) {
    if (porcentaje < 75) return '#E85D04';
    if (porcentaje < 85) return '#F2A582';
    if (porcentaje < 95) return '#79A5C9';
    return '#2563EB';
  }

  function crearEstadisticasPaises(filasMapa) {
    const estadisticas = new Map();

    filasMapa.forEach(fila => {
      const nombre = nombrePais(fila);
      if (!nombre || !esPaisObjetivo(nombre)) return;

      const clave = paisClave(nombre);
      const actual = estadisticas.get(clave) || { total: 0, cifrados: 0 };
      actual.total++;
      if (clasificarEstadoFila(fila) === 'protegido') actual.cifrados++;
      estadisticas.set(clave, actual);
    });

    return estadisticas;
  }

  function actualizarLeyendaMapa() {
    const leyenda = $('globalMapaLeyenda');
    if (!leyenda) return;

    leyenda.replaceChildren();
    [
      ['Menos de 75%', '#E85D04'],
      ['75% a 84%', '#F2A582'],
      ['85% a 94%', '#79A5C9'],
      ['95% o más', '#2563EB'],
      ['Sin información', '#D9DDE8']
    ].forEach(([texto, color]) => {
      const item = document.createElement('span');
      const muestra = document.createElement('i');
      muestra.className = 'global-mapa-leyenda-muestra';
      muestra.style.backgroundColor = color;
      item.append(muestra, texto);
      leyenda.append(item);
    });
  }

  function actualizarVisualMapa(filasMapa = filas) {
    if (!mapaPaises.length) return;

    const estadisticas = crearEstadisticasPaises(filasMapa);

    mapaPaises.forEach(({ elemento, feature }) => {
      const clave = paisClave(feature.properties.name);
      const estadistica = estadisticas.get(clave);

      if (!estadistica || !estadistica.total) {
        elemento.style.display = '';
        elemento.setAttribute('fill', '#D9DDE8');
        elemento.setAttribute(
          'aria-label',
          `${feature.properties.name}: sin información`
        );
        elemento.title = `${feature.properties.name}: sin información`;
        return;
      }

      const porcentaje = (estadistica.cifrados / estadistica.total) * 100;
      elemento.style.display = '';
      elemento.setAttribute('fill', colorCobertura(porcentaje));
      elemento.setAttribute(
        'aria-label',
        `${feature.properties.name}: ${porcentaje.toFixed(1)}% de equipos cifrados`
      );
      elemento.title = `${feature.properties.name}: ${porcentaje.toFixed(1)}% cifrado`;
    });

    actualizarLeyendaMapa();
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
      `translate(${mapaPanX} ${mapaPanY}) translate(240 240) scale(${mapaZoom}) translate(-240 -240)`
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

    const respuesta = await fetch('./world.geojson');

    if (!respuesta.ok) {
      throw new Error('No se pudo cargar el mapa mundial');
    }

    const geo = await respuesta.json();
    const paises = geo.features;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG_NS, 'svg');
    // Encuadre optimizado para las únicas regiones visibles: América del Norte,
    // Centroamérica y América del Sur.
    svg.setAttribute('viewBox', '0 0 480 480');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Mapa mundial 2D');
    svg.classList.add('global-mapa-svg');
    mapaGrupo = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(mapaGrupo);

    const tooltip = document.createElement('div');
    tooltip.className = 'global-mapa-tooltip';
    tooltip.hidden = true;

    const moverTooltip = evento => {
      const rect = contenedor.getBoundingClientRect();
      tooltip.style.left = `${evento.clientX - rect.left + 12}px`;
      tooltip.style.top = `${evento.clientY - rect.top + 12}px`;
    };

    mapaPaises = paises.map(feature => {
      // No dibujamos países fuera de Norteamérica, Centroamérica y Sudamérica.
      if (!esPaisObjetivo(feature.properties.name)) return null;

      const elemento = document.createElementNS(SVG_NS, 'path');
      elemento.setAttribute('d', crearRutaGeometria(feature.geometry));
      elemento.setAttribute('fill', '#D9DDE8');
      elemento.setAttribute('stroke', 'rgba(255,255,255,0.7)');
      elemento.setAttribute('stroke-width', '0.55');
      elemento.setAttribute('vector-effect', 'non-scaling-stroke');
      elemento.classList.add('global-mapa-pais');
      mapaGrupo.appendChild(elemento);
      elemento.addEventListener('pointerenter', evento => {
        tooltip.textContent = feature.properties.name;
        tooltip.hidden = false;
        moverTooltip(evento);
      });
      elemento.addEventListener('pointermove', moverTooltip);
      elemento.addEventListener('pointerleave', () => {
        tooltip.hidden = true;
      });

      return { elemento, feature };
    }).filter(Boolean); // Conserva únicamente los países coloreados

    if (mapaPaises.length === 0) {
      throw new Error('El archivo del mapa no contiene países para mostrar');
    }

    contenedor.replaceChildren(crearControlesZoom(), svg, tooltip);
    mapaSvg = svg;
    mapaZoom = 1;
    mapaPanX = 0;
    mapaPanY = 0;
    aplicarZoomMapa();
    ajustarMapa2D();
    actualizarVisualMapa();
    actualizarLeyendaMapa();
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
  if (!document.querySelector('.global-multi')) return;

  configurarMenusMulti();

  actualizarMenuMulti('region');
  actualizarMenuMulti('pais');
  actualizarMenuMulti('estado');

  const botonLimpiar = $('globalLimpiar');

  if (botonLimpiar) {
    botonLimpiar.addEventListener('click', () => {
      filtrosMulti.region.clear();
      filtrosMulti.pais.clear();
      filtrosMulti.estado.clear();

      llenarPaises();

      actualizarMenuMulti('region');
      actualizarMenuMulti('estado');

      document.querySelectorAll('.global-multi-menu')
        .forEach(menu => {
          menu.hidden = true;
        });

      document.querySelectorAll('.global-multi-boton')
        .forEach(boton => {
          boton.setAttribute('aria-expanded', 'false');
        });

      pintar();
    });
  }
}

  document.addEventListener('DOMContentLoaded', iniciar);

  window.CifraGlobo = {
    cargar
  };
})();
