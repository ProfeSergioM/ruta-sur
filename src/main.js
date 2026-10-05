// Ruta Sur · programa principal
// --------------------------------------------------------------------------
import * as THREE from 'three';
import { VEHICLES, createTruck, placeTruck, reseatTruck, stepTruck, speedKmh, gearLabel, articulation, totalMass, trailerAxleXZ } from './physics.js';
import { TestWorld, QUALITY, EMBEDDED, viewBlocks } from './world.js';
import { OpenWorld } from './openworld.js';
import { buildGraph, spawnPoint, nearestSegment } from './osm.js';
import { createTruckModel } from './truck-model.js';
import { Hud, fmtDist, fmtPesos } from './hud.js';
import { Jobs } from './jobs.js';
import { Input } from './input.js';
import { Sound } from './audio.js';
import { Mirrors } from './mirrors.js';
import { Traffic, TrafficView } from './traffic.js';
import { Radio } from './radio.js';
import { daylight, clockText, wrapHour, DAY_SECONDS_PER_HOUR } from './daylight.js';
import { compassFromYaw, compassName } from './geo.js';

// La versión sale de package.json: tools/build.mjs la fija al armar el archivo.
const VERSION = typeof __RS_VERSION__ === 'string' ? __RS_VERSION__ : 'en desarrollo';
const H = 1 / 60;                 // paso fijo de la física [s]
const $ = id => document.getElementById( id );

// La guardia de arranque vive en la plantilla: anota los errores sin atender y
// muestra el informe de falla. Aquí se le entregan los datos que el informe cita.
const guard = window.__rsGuardia || { datos: {}, fatal() {}, arranco() {} };
guard.datos.version = VERSION;
// La marca de "esta página ejecuta scripts" la pone la guardia. Se repite aquí por si
// una vista retiró ese script y dejó este: sin la marca, la pantalla inicial queda oculta.
document.documentElement.classList.add( 'js' );

// Coordenadas de referencia de cada centro (fuentes: Wikipedia y OpenStreetMap)
const CITIES = [
	{ id: 'temuco', name: 'Temuco', note: 'Plaza Aníbal Pinto', lat: - 38.739141, lon: - 72.590355 },
	{ id: 'santiago', name: 'Santiago', note: 'Plaza de Armas', lat: - 33.4377333, lon: - 70.6504556 },
	{ id: 'concepcion', name: 'Concepción', note: 'Plaza de la Independencia', lat: - 36.82709, lon: - 73.05023 },
	{ id: 'otro', name: 'Otro punto', note: 'latitud, longitud' },
];

// --------------------------------------------------------------------------
// Preferencias guardadas en este navegador
// --------------------------------------------------------------------------
const store = {
	// Una vista previa aislada puede negar el almacenamiento: el juego funciona igual, sin recordar nada.
	available: ( () => { try { localStorage.setItem( 'rutasur.prueba', '1' ); localStorage.removeItem( 'rutasur.prueba' ); return true; } catch ( e ) { return false; } } )(),
	read( key, fallback ) { try { const v = localStorage.getItem( 'rutasur.' + key ); return v ? JSON.parse( v ) : fallback; } catch ( e ) { return fallback; } },
	write( key, value ) { try { localStorage.setItem( 'rutasur.' + key, JSON.stringify( value ) ); } catch ( e ) { /* sin almacenamiento */ } },
};

const config = Object.assign( { city: 'temuco', coords: '', truck: 'articulado', quality: 'media' }, store.read( 'config', {} ) );


function parseCoords( text ) {

	const m = text.trim().match( /^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/ );
	if ( ! m ) return null;
	const lat = parseFloat( m[ 1 ].replace( ',', '.' ) ), lon = parseFloat( m[ 2 ].replace( ',', '.' ) );
	if ( ! ( Math.abs( lat ) <= 85 && Math.abs( lon ) <= 180 ) ) return null;
	return { lat, lon };

}

// --------------------------------------------------------------------------
// Escena
// --------------------------------------------------------------------------
const canvas = $( 'view' );
const renderer = createRenderer();

// Sin WebGL 2 no hay juego. Primero se comprueba en un lienzo aparte que el navegador
// lo entregue: así la falta de gráficos 3D se explica en pantalla, en vez de dejar la
// página a medio armar. Devuelve null cuando no hay gráficos.
function createRenderer() {

	try {

		const probe = document.createElement( 'canvas' ).getContext( 'webgl2' );
		if ( ! probe ) return null;
		const lose = probe.getExtension( 'WEBGL_lose_context' );
		if ( lose ) lose.loseContext();

		const r = new THREE.WebGLRenderer( { canvas, antialias: true, powerPreference: 'high-performance' } );
		r.setPixelRatio( Math.min( window.devicePixelRatio || 1, 1.5 ) );
		r.setSize( window.innerWidth, window.innerHeight, false );

		// el nombre del adaptador gráfico, para el informe de falla
		const gl = r.getContext();
		let name = String( gl.getParameter( gl.RENDERER ) || '' );
		if ( /^WebKit WebGL$/i.test( name ) ) { const ext = gl.getExtension( 'WEBGL_debug_renderer_info' ); if ( ext ) name = String( gl.getParameter( ext.UNMASKED_RENDERER_WEBGL ) ); }
		guard.datos.graficos = name;
		return r;

	} catch ( e ) {

		console.warn( 'Ruta Sur · no se pudo iniciar WebGL:', e && e.message );
		return null;

	}

}

const scene = new THREE.Scene();
const SKY_TOP = new THREE.Color( 0x3f7fc4 ), SKY_HORIZON = new THREE.Color( 0xc9dbe6 );
scene.fog = new THREE.Fog( SKY_HORIZON, 800, 3800 );
scene.background = SKY_HORIZON;

// proporción de la vista; una vista previa todavía cerrada puede medir cero
const viewAspect = () => ( window.innerWidth || 1 ) / ( window.innerHeight || 1 );
const camera = new THREE.PerspectiveCamera( 62, viewAspect(), 0.5, 4000 );
camera.position.set( 0, 600, 0 );
camera.lookAt( 0, 0, 0 );

const hemi = new THREE.HemisphereLight( 0xffffff, 0x5a6470, 1.25 );
scene.add( hemi );
const sun = new THREE.DirectionalLight( 0xfff1d6, 1.7 );
sun.position.set( - 0.5, 1, 0.35 );
scene.add( sun );

// cielo: una cúpula con degradado que acompaña a la cámara
const sky = new THREE.Mesh(
	new THREE.SphereGeometry( 1, 24, 12 ),
	new THREE.ShaderMaterial( {
		side: THREE.BackSide, depthWrite: false, fog: false,
		uniforms: { top: { value: SKY_TOP }, horizon: { value: SKY_HORIZON } },
		vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
		fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying vec3 vDir; void main() { float h = clamp( normalize( vDir ).y, 0.0, 1.0 ); gl_FragColor = vec4( mix( horizon, top, pow( h, 0.55 ) ), 1.0 ); }',
	} ) );
sky.renderOrder = - 10;
sky.frustumCulled = false;
scene.add( sky );

// marca del destino: una columna de luz y un aro sobre la calzada
const marker = new THREE.Group();
{

	const beam = new THREE.Mesh( new THREE.CylinderGeometry( 1.4, 1.4, 90, 20, 1, true ), new THREE.MeshBasicMaterial( { color: 0xf2a33a, transparent: true, opacity: 0.38, side: THREE.DoubleSide, depthWrite: false, fog: false } ) );
	beam.position.y = 45;
	const ring = new THREE.Mesh( new THREE.TorusGeometry( 9, 0.35, 8, 40 ), new THREE.MeshBasicMaterial( { color: 0xf2a33a, fog: false } ) );
	ring.rotation.x = Math.PI / 2; ring.position.y = 0.4;
	marker.add( beam, ring );
	marker.visible = false;
	scene.add( marker );

}

// --------------------------------------------------------------------------
// Estado del juego
// --------------------------------------------------------------------------
const hud = new Hud();
const sound = new Sound();
// radios chilenas por internet; cada cambio de estado se muestra en pantalla y en la pausa
const radio = new Radio( { onState: r => { hud.toast( r.label, r.state === 'error' ? 'alerta' : '', 2.5 ); syncRadioMenu(); } } );
const game = {
	version: VERSION,
	state: 'menu',            // menu | loading | driving | paused
	world: null, truck: null, model: null, graph: null, jobs: null,
	spec: null, quality: QUALITY.media,
	ghost: false, debug: false,
	mirrors: null, mirrorInsets: true,   // espejos retrovisores y sus recuadros en pantalla
	traffic: null, trafficView: null, trafficOn: true, lastCarHit: - 9,   // los demás vehículos
	hour: 17,                            // hora del juego (0 a 24); el ciclo de luz sale de aquí
	cam: { mode: 0, lookYaw: 0, lookPitch: 0, orbit: 0, lift: 0, yaw: 0, init: false },
	load: null,
	limit: 0,
	perf: { fps: 0, frames: 0, t: 0, physMs: 0, rays: 0 },
	safe: [],                 // posiciones recientes donde el camión estaba bien apoyado
	timers: { hud: 0, map: 0, limit: 0, safe: 0, marker: 0, noGround: 0, reseat: 1, blocked: 0, side: 0, focus: 3 },
};
window.__rutaSur = game;
game.radio = radio;

const input = new Input( canvas, onAction );
// con pantalla táctil no hay teclas: los textos nombran los gestos equivalentes
const TOUCH = typeof matchMedia === 'function' && matchMedia( '( pointer: coarse )' ).matches;
const params = new URLSearchParams( location.search );

// --------------------------------------------------------------------------
// Pantalla inicial
// --------------------------------------------------------------------------
function buildMenu() {

	// Las opciones se arman nodo por nodo, sin HTML como texto: funciona igual bajo una
	// política de seguridad que exija tipos de confianza para insertar HTML.
	const option = ( className, name, id, label, note ) => {

		const l = document.createElement( 'label' ), input = document.createElement( 'input' ), span = document.createElement( 'span' );
		l.className = className;
		input.type = 'radio'; input.name = name; input.id = `${ name }-${ id }`; input.value = id;
		span.textContent = label;
		if ( note ) { const small = document.createElement( 'small' ); small.textContent = note; span.appendChild( small ); }
		l.append( input, span );
		return l;

	};

	const cities = $( 'ciudades' );
	for ( const c of CITIES ) cities.appendChild( option( 'renglon', 'ciudad', c.id, c.name, c.note ) );

	const chips = ( host, name, items, current ) => {

		for ( const [ id, label ] of items ) host.appendChild( option( 'ficha', name, id, label ) );

		check( host, current );

	};

	// Marca la opción guardada. Se busca por valor, sin armar un selector con un dato que viene del almacenamiento.
	const check = ( host, value ) => { const all = [ ...host.querySelectorAll( 'input' ) ]; ( all.find( i => i.value === value ) || all[ 0 ] ).checked = true; };

	chips( $( 'camiones' ), 'camion', Object.values( VEHICLES ).map( v => [ v.id, v.label ] ), config.truck );
	chips( $( 'calidades' ), 'calidad', Object.entries( QUALITY ).map( ( [ id, q ] ) => [ id, q.label ] ), config.quality );
	check( cities, config.city );

	$( 'version' ).textContent = VERSION;
	const coords = $( 'coordenadas' );
	coords.value = config.coords || '';
	const syncCity = () => { coords.hidden = selected( 'ciudad' ) !== 'otro'; };
	cities.addEventListener( 'change', syncCity );
	syncCity();

	// Dentro de otra aplicación (una vista previa), la red puede quedar bloqueada:
	// se avisa antes de que la persona espere una carga que no llega.
	if ( EMBEDDED ) {

		// la aplicación anfitriona puede quedarse con la tecla Esc (por ejemplo, para cerrar su panel): P también pausa
		$( 'tecla-pausa' ).textContent = 'P';
		const m = $( 'marco-nota' );
		m.textContent = 'El juego está abierto dentro de otra aplicación. La ciudad de pruebas funciona aquí. El mapa abierto necesita conectarse con OpenStreetMap, y una vista previa puede bloquear esa conexión: si no carga, guarda este archivo en tu computador y ábrelo con doble clic en Chrome o Edge.';
		m.hidden = false;

	}

	// "Conducir" con el botón o con Enter en el campo de coordenadas. No se usa el envío de un
	// formulario: un marco aislado sin permiso de formularios lo bloquea, y el botón quedaría sin efecto.
	$( 'conducir' ).addEventListener( 'click', () => startFromMenu( 'open' ) );
	coords.addEventListener( 'keydown', e => { if ( e.key === 'Enter' ) { e.preventDefault(); startFromMenu( 'open' ); } } );
	$( 'pista' ).addEventListener( 'click', () => startFromMenu( 'test' ) );
	$( 'carga-volver' ).addEventListener( 'click', () => toMenu() );
	$( 'seguir' ).addEventListener( 'click', () => setPaused( false ) );
	// las mismas acciones de las teclas R y G, para quien juega sin teclado
	$( 'p-calle' ).addEventListener( 'click', () => { setPaused( false ); onAction( 'reset' ); } );
	$( 'p-choques' ).addEventListener( 'click', () => { setPaused( false ); onAction( 'ghost' ); } );
	$( 'p-espejos' ).addEventListener( 'click', () => { setPaused( false ); onAction( 'mirrors' ); } );
	$( 'p-trafico' ).addEventListener( 'click', () => { setTraffic( ! game.trafficOn ); setPaused( false ); } );
	buildRadioMenu();
	$( 'p-otro' ).addEventListener( 'click', () => { setPaused( false ); onAction( 'skip' ); } );
	$( 'salir' ).addEventListener( 'click', () => toMenu() );

}

const selected = name => { const el = document.querySelector( `input[name="${ name }"]:checked` ); return el ? el.value : null; };

// Radio en la pausa: un botón por emisora, "apagada" y un campo para pegar otra dirección
function buildRadioMenu() {

	const host = $( 'radios' );
	const make = ( label, station ) => {

		const b = document.createElement( 'button' );
		b.type = 'button'; b.className = 'boton secundario chica'; b.textContent = label;
		b.dataset.radio = station ? station.id : 'off';
		b.addEventListener( 'click', () => { if ( station ) radio.play( station ); else radio.stop(); } );
		return b;

	};

	const fill = () => {

		host.replaceChildren();
		host.appendChild( make( 'Apagada', null ) );
		for ( const s of radio.stations ) host.appendChild( make( s.name, s ) );
		syncRadioMenu();

	};

	const url = $( 'radio-url' );
	url.addEventListener( 'change', () => { url.value = radio.setCustom( url.value ); fill(); if ( radio.custom ) radio.play( radio.stations[ radio.stations.length - 1 ] ); } );
	url.addEventListener( 'keydown', e => { if ( e.key === 'Enter' ) { e.preventDefault(); url.dispatchEvent( new Event( 'change' ) ); } } );
	fill();

}

function syncRadioMenu() {

	const host = $( 'radios' );
	if ( ! host ) return;
	const id = radio.current ? radio.current.id : 'off';
	for ( const b of host.children ) b.classList.toggle( 'marcado', b.dataset.radio === id );
	$( 'radio-estado' ).textContent = radio.label;

}

function menuError( text ) {

	const el = $( 'menu-error' );
	el.hidden = ! text;
	el.textContent = text || '';
	if ( text ) el.scrollIntoView( { block: 'nearest' } );

}

// mode: 'test' (ciudad de pruebas) u 'open' (mapa abierto desde OpenStreetMap)
function startFromMenu( mode ) {

	menuError( '' );
	config.city = selected( 'ciudad' ); config.truck = selected( 'camion' ); config.quality = selected( 'calidad' );
	config.coords = $( 'coordenadas' ).value;
	store.write( 'config', config );

	if ( mode === 'test' ) { sound.start(); return start( { test: true, truck: config.truck, quality: config.quality } ); }

	let lat, lon;
	if ( config.city === 'otro' ) {

		const c = parseCoords( config.coords );
		if ( ! c ) return menuError( 'Escribe las coordenadas como latitud, longitud en grados decimales. Por ejemplo: -38.7391, -72.5904' );
		lat = c.lat; lon = c.lon;

	} else {

		const c = CITIES.find( c => c.id === config.city ) || CITIES[ 0 ];
		lat = c.lat; lon = c.lon;

	}

	sound.start();
	start( { open: true, lat, lon, truck: config.truck, quality: config.quality } );

}

// --------------------------------------------------------------------------
// Carga de una partida
// --------------------------------------------------------------------------
function start( opts ) {

	teardown();
	game.spec = VEHICLES[ opts.truck ] || VEHICLES.articulado;
	game.quality = QUALITY[ opts.quality ] || QUALITY.media;
	game.hour = Number.isFinite( opts.hour ) ? wrapHour( opts.hour ) : 17;
	renderer.setPixelRatio( Math.min( window.devicePixelRatio || 1, game.quality.pixelRatio ) );
	// durante la carga la cámara mira desde muy alto, hasta saber dónde está el suelo
	camera.far = 20000; camera.near = 5; camera.fov = 50;
	camera.updateProjectionMatrix();
	scene.fog.near = game.quality.far * 0.3; scene.fog.far = game.quality.far * 0.95;
	sky.scale.setScalar( game.quality.far * 0.9 );

	if ( opts.test ) game.world = new TestWorld( { scene } );
	else game.world = new OpenWorld( { scene, lat: opts.lat, lon: opts.lon, far: game.quality.far } );

	const hint = game.world.startHint();
	const L = game.load = {
		phase: 'world', t: 0, wait: 0, hint,
		spawn: null, ground: null, roads: 'pending', roadsError: null,
	};
	game.graph = null;
	// La respuesta de las calles puede llegar cuando esta carga ya se abandonó y hay
	// otra en curso: solo vale para la carga que la pidió.
	const world = game.world;
	world.roads().then( osm => {

		if ( game.load === L ) {

			game.graph = buildGraph( osm, world.geo );
			L.roads = game.graph.count > 1 ? 'ok' : 'empty';
			if ( L.roads === 'empty' ) game.graph = null;

		} else if ( game.world === world && game.truck && ! game.graph && ( game.state === 'driving' || game.state === 'paused' ) ) {

			// La red llegó cuando la partida ya había empezado en modo libre (el servicio
			// de calles puede tardar más que la carga del mapa): desde ahora hay encargos.
			const graph = buildGraph( osm, world.geo );
			if ( graph.count <= 1 ) return;
			game.graph = graph;
			game.jobs = newJobs( graph );
			game.jobs.offer( game.truck );
			startTraffic();
			hud.toast( `Llegó la red de calles. ${ TOUCH ? 'Toca la guía para aceptar el encargo' : 'Enter para aceptar el encargo' }`, 'logro', 6 );

		}

	} ).catch( e => { if ( game.load === L ) { L.roads = 'failed'; L.roadsError = e; } } );

	$( 'carga' ).dataset.estado = ''; $( 'carga-titulo' ).textContent = 'En camino'; $( 'carga-texto' ).textContent = '';
	$( 'menu' ).hidden = true; $( 'carga' ).hidden = false; hud.show( false );
	game.state = 'loading';
	camera.position.set( hint.x, 7000, hint.z );
	camera.up.set( 0, 0, 1 );
	camera.lookAt( hint.x, 0, hint.z );

}

const _focus = new THREE.Vector3();

function loadingStep( dt ) {

	const L = game.load, world = game.world;
	L.t += dt;
	const text = $( 'carga-texto' );

	if ( world.error ) {

		// la carga se detiene: la señal deja de anunciar avance y explica qué pasó
		text.textContent = world.error;
		$( 'carga' ).dataset.estado = 'error';
		$( 'carga-titulo' ).textContent = 'Ruta cortada';
		return;

	}

	const sx = L.spawn ? L.spawn.x : L.hint.x, sz = L.spawn ? L.spawn.z : L.hint.z;
	const gy = L.ground !== null ? L.ground : 0;
	_focus.set( sx, gy, sz );
	// durante la carga la cámara mira el punto de partida desde arriba
	camera.position.set( sx, L.ground !== null ? gy + 420 : 7000, sz );
	camera.up.set( 0, 0, 1 );
	camera.lookAt( sx, gy, sz );
	world.update( _focus, dt, L.ground !== null );
	applyDaylight();

	const p = world.progress;

	if ( L.phase === 'world' ) {

		text.textContent = p.text;
		if ( ! p.ready ) return;
		const g = world.groundAt( sx, sz );
		if ( g ) L.ground = g.y;
		L.phase = 'roads'; L.wait = 0;

	}

	if ( L.phase === 'roads' ) {

		// la red vial llega por otro servicio: se espera un momento y, si falla, se sigue en modo libre
		L.wait += dt;
		text.textContent = 'Leyendo las calles de OpenStreetMap';
		if ( L.roads === 'pending' && L.wait < 25 ) return;
		if ( L.roads === 'ok' ) {

			const sp = spawnPoint( game.graph, L.hint.x, L.hint.z, L.hint.yaw );
			if ( sp ) L.spawn = sp;

		}

		if ( ! L.spawn ) L.spawn = { x: L.hint.x, z: L.hint.z, yaw: L.hint.yaw };
		L.phase = 'ground'; L.wait = 0;
		return;

	}

	if ( L.phase === 'ground' ) {

		// el suelo bajo el punto de partida
		L.wait += dt;
		text.textContent = p.ready ? 'Buscando la calzada' : p.text;
		const g = world.groundAt( L.spawn.x, L.spawn.z );
		if ( g ) L.ground = g.y;
		if ( ! p.ready || L.wait < 0.5 ) return;
		if ( ! g ) {

			if ( L.wait > 12 ) world.error = 'No hay suelo en el punto de partida. Elige otro lugar.';
			return;

		}

		L.phase = 'place'; L.wait = 0;
		return;

	}

	if ( L.phase === 'place' ) {

		L.wait += dt;
		text.textContent = 'Estacionando el camión';
		if ( ( ! p.ready && L.wait < 8 ) || L.wait < 0.4 ) return;
		const t = createTruck( game.spec, { cargoMass: 0 } );
		const g = world.groundAt( L.spawn.x, L.spawn.z );
		if ( ! g || ! placeTruck( t, L.spawn.x, L.spawn.z, L.spawn.yaw, world.terrain, g.y ) ) {

			if ( L.wait > 12 ) world.error = 'No encontré suelo firme para dejar el camión. Elige otro punto.';
			return;

		}

		beginDriving( t );

	}

}

// Encargos sobre una red vial (o modo libre, sin red), con la caja guardada en el navegador
function newJobs( graph ) {

	return new Jobs( {
		graph, spec: game.spec, rng: seededRandom(),
		store: { get: () => store.read( 'caja', null ), set: v => store.write( 'caja', v ) },
	} );

}

function beginDriving( t ) {

	const world = game.world;
	game.truck = t;
	game.model = createTruckModel( game.spec );
	scene.add( game.model.root );
	game.mirrors = new Mirrors( renderer, scene, { width: game.quality.mirror, both: game.quality.mirrorBoth, far: game.quality.far } );
	game.mirrors.attach( game.model, world, [ $( 'espejo-izq' ), $( 'espejo-der' ) ], game.cam.mode === 0 );
	world.field.unlimited = false;

	game.jobs = newJobs( game.graph );
	if ( game.graph ) game.jobs.offer( t );
	startTraffic();

	game.cam.init = false; game.cam.lookYaw = 0; game.cam.lookPitch = 0; game.cam.orbit = 0; game.cam.yaw = t.yaw;
	hud.setClock( clockText( game.hour ) );
	camera.far = game.quality.far;
	setCamera( game.cam.mode );
	camera.up.set( 0, 1, 0 );
	game.safe.length = 0;
	game.acc = 0; game.simTime = 0; game.script = null; game.lastImpact = 0; game.lastSide = 0; game.timers.side = 0;
	const L = game.load;
	game.load = null;
	$( 'carga' ).hidden = true;
	hud.show( true );
	hud.setAttribution( world.provider, '', world.via ? `Datos servidos por ${ world.via }` : '' );
	$( 'mapa-credito' ).textContent = world.kind === 'test' ? 'Ciudad de pruebas' : '© OpenStreetMap';
	game.state = 'driving';
	input.enabled = true;

	if ( ! game.graph ) hud.toast( L.roads === 'failed' ? ( viewBlocks( 'overpass-api.de', 'private.coffee' ) ? 'La vista donde está abierto el juego bloquea el servicio de calles. Modo libre: maneja sin encargos.' : 'No se pudo leer la red de calles. Modo libre: maneja sin encargos.' ) : ( L.roads === 'pending' ? 'La red de calles todavía no llega. Parte en modo libre: los encargos aparecerán cuando llegue.' : 'Sin calles registradas en este punto. Modo libre.' ), '', 6 );
	else hud.toast( TOUCH ? 'Toca la guía de despacho para aceptar el encargo' : 'Enter para aceptar el encargo', '', 5 );

}

// Con ?seed=N los encargos salen siempre en el mismo orden (para pruebas reproducibles)
function seededRandom() {

	if ( ! params.has( 'seed' ) ) return Math.random;
	let a = parseInt( params.get( 'seed' ), 10 ) | 0;
	return () => {

		a = a + 0x6D2B79F5 | 0;
		let t = Math.imul( a ^ a >>> 15, 1 | a );
		t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
		return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;

	};

}

// Los demás vehículos circulan por la red vial; sin red no hay tráfico
function startTraffic() {

	if ( game.traffic || ! game.graph || ! game.truck ) return;
	const world = game.world;
	game.traffic = new Traffic( { graph: game.graph, rng: seededRandom(), count: game.trafficOn ? game.quality.traffic : 0, groundAt: ( x, z ) => { const g = world.groundAt( x, z ); return g ? g.y : null; } } );
	game.traffic.enabled = game.trafficOn;
	game.trafficView = new TrafficView( scene, game.traffic );
	if ( _lastDaylight ) game.trafficView.setNight( _lastDaylight.lamps );

}

function setTraffic( on ) {

	game.trafficOn = on;
	if ( game.traffic ) {

		game.traffic.enabled = on;
		game.traffic.count = on ? game.quality.traffic : 0;
		if ( ! on ) game.traffic.clearNear( 0, 0, Infinity );

	}

	hud.toast( on ? 'Tráfico activado' : 'Tráfico desactivado: las calles quedan vacías', '', 2 );

}

function teardown() {

	input.enabled = false;
	if ( game.mirrors ) { game.mirrors.dispose(); game.mirrors = null; }
	if ( game.trafficView ) { game.trafficView.dispose(); game.trafficView = null; }
	game.traffic = null;
	if ( game.model ) { scene.remove( game.model.root ); game.model.dispose(); game.model = null; }
	if ( game.world ) { game.world.dispose(); game.world = null; }
	game.truck = null; game.jobs = null; game.graph = null; game.load = null;
	marker.visible = false; marker.userData.node = null; marker.userData.y = null;
	sound.silence();

}

function toMenu() {

	teardown();
	sound.stop();
	radio.stop();
	game.state = 'menu';
	$( 'menu' ).hidden = false; $( 'carga' ).hidden = true; $( 'pausa' ).hidden = true;
	hud.show( false );

}

function setPaused( on ) {

	if ( game.state !== 'driving' && game.state !== 'paused' ) return;
	game.state = on ? 'paused' : 'driving';
	$( 'pausa' ).hidden = ! on;
	$( 'p-choques' ).textContent = game.ghost ? 'Choques: desactivados' : 'Choques: activados';
	$( 'p-espejos' ).textContent = game.mirrorInsets ? 'Espejos en pantalla: sí' : 'Espejos en pantalla: no';
	$( 'p-trafico' ).textContent = game.trafficOn ? 'Tráfico: sí' : 'Tráfico: no';
	$( 'p-otro' ).hidden = ! game.jobs || game.jobs.state === 'libre';
	$( 'pausa-aviso' ).hidden = ! game.contextLost;
	if ( on ) sound.stop(); else sound.start();

}

// --------------------------------------------------------------------------
// Acciones del jugador
// --------------------------------------------------------------------------
const CAM_NAMES = [ 'Cabina', 'Exterior', 'Cenital' ];

// Ciclo de día y noche: el cielo, la bruma, las luces del camión y el tinte de la ciudad
// siguen la hora del juego. Los faroles y las ventanas se encienden con el crepúsculo.
const _sky = { top: new THREE.Color(), horizon: new THREE.Color() };
let _lastDaylight = null;
function applyDaylight() {

	const d = daylight( game.hour );
	_sky.top.setRGB( d.skyTop[ 0 ], d.skyTop[ 1 ], d.skyTop[ 2 ] );
	_sky.horizon.setRGB( d.skyHorizon[ 0 ], d.skyHorizon[ 1 ], d.skyHorizon[ 2 ] );
	sky.material.uniforms.top.value.copy( _sky.top );
	sky.material.uniforms.horizon.value.copy( _sky.horizon );
	scene.fog.color.copy( _sky.horizon );
	scene.background = _sky.horizon;
	hemi.intensity = 1.25 * ( 0.12 + 0.88 * d.level );
	sun.intensity = 1.7 * d.sun;
	sun.color.setRGB( 1, 0.95 - 0.25 * d.dusk, 0.84 - 0.4 * d.dusk );
	if ( game.world && game.world.setLight ) game.world.setLight( d );
	if ( game.model ) game.model.setNight( 1 - d.level );
	if ( game.trafficView ) game.trafficView.setNight( d.lamps );
	_lastDaylight = d;
	return d;

}
const WORLD_NAMES = { test: 'ciudad de pruebas', open: 'mapa abierto' };

function setCamera( mode ) {

	game.cam.mode = mode;
	if ( game.model ) game.model.setCabinView( mode === 0 );
	if ( game.mirrors ) game.mirrors.setActive( mode === 0 );
	applyDaylight();
	$( 'espejos' ).hidden = ! ( mode === 0 && game.mirrorInsets );
	camera.fov = [ 62, 55, 50 ][ mode ];
	camera.near = mode === 0 ? 0.12 : 0.5;
	camera.updateProjectionMatrix();
	game.cam.init = false;

}

function onAction( name ) {

	if ( name === 'pause' || name === 'help' ) return setPaused( game.state === 'driving' );
	if ( game.state !== 'driving' ) return;
	const t = game.truck;
	switch ( name ) {

		case 'camera': setCamera( ( game.cam.mode + 1 ) % 3 ); hud.toast( `Cámara: ${ CAM_NAMES[ game.cam.mode ] }`, '', 1.5 ); break;
		case 'ghost':
			game.ghost = ! game.ghost;
			hud.toast( game.ghost ? 'Choques desactivados: el camión atraviesa los obstáculos' : 'Choques activados', '', 3 );
			break;
		case 'mute': sound.setMuted( ! sound.muted ); radio.setMuted( sound.muted ); hud.toast( sound.muted ? 'Sonido apagado' : 'Sonido encendido', '', 1.5 ); break;
		case 'radio': radio.next(); if ( ! radio.current ) hud.toast( 'Radio apagada', '', 1.5 ); break;
		case 'hour': game.hour = wrapHour( Math.floor( game.hour ) + 1 ); applyDaylight(); hud.toast( `Hora: ${ clockText( game.hour ) }${ _lastDaylight && _lastDaylight.lampsOn ? ' · luces encendidas' : '' }`, '', 1.5 ); break;
		case 'mirrors':
			game.mirrorInsets = ! game.mirrorInsets;
			$( 'espejos' ).hidden = ! ( game.cam.mode === 0 && game.mirrorInsets );
			hud.toast( game.mirrorInsets ? 'Espejos en pantalla' : 'Espejos solo en la cabina', '', 1.5 );
			break;
		case 'debug': game.debug = ! game.debug; if ( ! game.debug ) hud.setDebug( null ); break;
		case 'reset': resetToRoad(); break;
		case 'accept':
			if ( game.jobs && game.jobs.state === 'offer' ) {

				if ( game.jobs.accept( t ) ) hud.toast( `Encargo aceptado: ${ game.jobs.job.cargo } a ${ game.jobs.job.dest.label }`, 'logro', 4 );
				else if ( game.jobs.state === 'offer' ) hud.toast( 'Ese destino quedó a pocos metros. Hay un encargo nuevo', '', 3.5 );
				else hud.toast( 'No hay destinos alcanzables desde aquí', '', 3 );

			}

			break;
		case 'skip':
			if ( game.jobs && ( game.jobs.state === 'offer' || game.jobs.state === 'active' || game.jobs.state === 'none' ) ) {

				t.cargoMass = 0;
				if ( game.jobs.offer( t ) ) hud.toast( 'Nuevo encargo disponible', '', 2.5 );
				else hud.toast( 'No hay destinos alcanzables desde aquí', '', 3 );

			}

			break;

	}

}

// Vuelve a dejar el camión sobre la calle más cercana, o en la última posición buena
function resetToRoad() {

	const t = game.truck, world = game.world;
	let target = null;
	if ( game.graph ) {

		const s = nearestSegment( game.graph, t.x, t.z, 300 );
		if ( s ) {

			const L = Math.hypot( s.dx, s.dz ) || 1;
			let dx = s.dx / L, dz = s.dz / L;
			// se conserva, en lo posible, el sentido en que miraba el camión
			const fx = - Math.sin( t.yaw ), fz = - Math.cos( t.yaw );
			if ( s.way.oneway < 0 || ( s.way.oneway === 0 && dx * fx + dz * fz < 0 ) ) { dx = - dx; dz = - dz; }
			target = { x: s.x, z: s.z, yaw: Math.atan2( - dx, - dz ) };

		}

	}

	if ( ! target && game.safe.length ) target = game.safe[ Math.max( 0, game.safe.length - 3 ) ];
	if ( ! target ) target = { x: t.x, z: t.z, yaw: t.yaw };
	// la calzada más cercana a la altura actual: bajo un puente, la calle y no el tablero
	const y = world.groundNear( target.x, target.z, t.y );
	if ( y === null ) { hud.toast( 'Aún no hay malla cargada en ese punto', 'alerta', 2.5 ); return; }
	// las mallas que consulta la física se eligen alrededor del foco: primero se mueve el foco al destino
	_focus.set( target.x, y, target.z ); world.update( _focus, 0, true );
	const cargo = t.cargoMass, damage = t.damage, odo = t.odo;
	if ( game.traffic ) game.traffic.clearNear( target.x, target.z, 45 );
	const ok = placeTruck( t, target.x, target.z, target.yaw, world.terrain, y );
	t.cargoMass = cargo; t.damage = damage; t.odo = odo;
	game.cam.init = false;
	game.timers.noGround = 0;
	hud.toast( ok ? 'De vuelta en la calle' : 'La malla de ese punto todavía se está cargando', ok ? '' : 'alerta', 2 );

}

// --------------------------------------------------------------------------
// Cámaras
// --------------------------------------------------------------------------
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler( 0, 0, 0, 'YXZ' );
const _ax = {};

function wrap( a ) { a = ( a + Math.PI ) % ( 2 * Math.PI ); if ( a < 0 ) a += 2 * Math.PI; return a - Math.PI; }

function updateCamera( dt, look ) {

	const t = game.truck, cam = game.cam, model = game.model;
	const drag = input.takeDrag();

	if ( cam.mode === 0 ) {

		// cabina: la mirada vuelve al frente cuando no se arrastra ni se pide mirar al lado
		const keyYaw = look * 1.25;
		if ( drag.active ) { cam.lookYaw -= drag.dx * 0.004; cam.lookPitch -= drag.dy * 0.003; cam.hold = 1.2; }
		else if ( look !== 0 ) { cam.lookYaw += ( keyYaw - cam.lookYaw ) * Math.min( 1, dt * 7 ); cam.hold = 0; }
		else {

			cam.hold = Math.max( 0, ( cam.hold || 0 ) - dt );
			if ( cam.hold === 0 ) { const k = Math.min( 1, dt * 5 ); cam.lookYaw -= cam.lookYaw * k; cam.lookPitch -= cam.lookPitch * k; }

		}

		cam.lookYaw = THREE.MathUtils.clamp( cam.lookYaw, - 2.3, 2.3 );
		cam.lookPitch = THREE.MathUtils.clamp( cam.lookPitch, - 0.6, 0.5 );
		model.eye.updateWorldMatrix( true, false );
		model.eye.matrixWorld.decompose( camera.position, _q1, _v1 );
		_e.set( cam.lookPitch, cam.lookYaw, 0 );
		camera.quaternion.copy( _q1 ).multiply( _q2.setFromEuler( _e ) );

	} else if ( cam.mode === 1 ) {

		// exterior: detrás del conjunto completo, siguiendo a la unidad trasera con algo de retardo
		if ( drag.active ) { cam.orbit -= drag.dx * 0.006; cam.lift = THREE.MathUtils.clamp( cam.lift + drag.dy * 0.03, - 3, 14 ); }
		const tl = t.spec.trailer, tr = t.spec.tractor;
		let bx = t.x, bz = t.z, by = t.y, yawRef = t.yaw, back = tr.rearOverhang + 9.5, height = 6.4;
		if ( tl ) { trailerAxleXZ( t, _ax ); bx = _ax.x; bz = _ax.z; by = t.trailerY; yawRef = t.trailerYaw; back = tl.length - tl.kingpinFromFront - tl.wheelbase + 11; height = 9.2; }
		if ( ! cam.init ) { cam.yaw = yawRef; cam.init = true; }
		cam.yaw += wrap( yawRef - cam.yaw ) * Math.min( 1, dt * 3 );
		const a = cam.yaw + cam.orbit;
		// detrás: el opuesto del avance (-sin a, -cos a)
		_v1.set( bx + Math.sin( a ) * back, by + height + cam.lift, bz + Math.cos( a ) * back );
		// la cámara se mantiene sobre el suelo
		const gy = game.world.terrain.sampleGround( _v1.x, _v1.z, _v1.y );
		if ( gy === gy && _v1.y < gy + 1.2 ) _v1.y = gy + 1.2;
		camera.position.copy( _v1 );
		// mira hacia la cabina, un poco por delante
		_v2.set( t.x - Math.sin( t.yaw ) * ( tr.wheelbase + 6 ), t.y + 1.0, t.z - Math.cos( t.yaw ) * ( tr.wheelbase + 6 ) );
		camera.up.set( 0, 1, 0 );
		camera.lookAt( _v2 );

	} else {

		// cenital: el rumbo del camión queda hacia arriba
		let cx = t.x, cz = t.z;
		if ( t.spec.trailer ) { trailerAxleXZ( t, _ax ); cx = ( t.x + _ax.x ) / 2; cz = ( t.z + _ax.z ) / 2; }
		camera.position.set( cx, t.y + 62, cz );
		camera.up.set( - Math.sin( t.yaw ), 0, - Math.cos( t.yaw ) );
		camera.lookAt( cx, t.y, cz );

	}

	sky.position.copy( camera.position );

}

// --------------------------------------------------------------------------
// Bucle principal
// --------------------------------------------------------------------------
let lastFrame = 0; // marca de tiempo del cuadro anterior [ms]

// Un paso de física con sus avisos. Devuelve el avance con signo, para girar las ruedas.
function physicsStep( inp ) {

	const t = game.truck;
	const odo = t.odo, dirSign = Math.sign( t.v ) || 1;
	const ev = stepTruck( t, inp, game.world.terrain, H, { collisions: ! game.ghost } );
	game.simTime += H;
	game.hour = wrapHour( game.hour + H / DAY_SECONDS_PER_HOUR );
	if ( ev.side ) game.lastSide = ev.side;
	if ( ev.impact > 0.85 ) { sound.thud( ev.impact ); hud.toast( `Choque a ${ Math.round( ev.impact * 3.6 ) } km/h`, 'alerta', 2.2 ); game.lastImpact = ev.impact; }
	else if ( ev.side ) {

		// un costado tocó algo despacio: se avisa una vez y se deja de avisar mientras siga apoyado
		if ( game.timers.side <= 0 ) { sound.scrape(); hud.toast( 'Un costado toca un obstáculo', 'alerta', 2.2 ); }
		game.timers.side = 3;

	}

	if ( game.traffic ) {

		const tv = game.traffic.step( t, H, ! game.ghost );
		if ( tv.hit > 0.85 && game.simTime - game.lastCarHit > 1 ) {

			// chocar un vehículo: daño como contra un obstáculo blando, el camión pierde algo de
			// velocidad (cantidad de movimiento) y hay multa
			game.lastCarHit = game.simTime;
			const car = tv.vehicle, share = car.K.mass / ( totalMass( t ) + car.K.mass );
			t.v -= Math.sign( t.v || 1 ) * tv.hit * share;
			t.damage = Math.min( 1, t.damage + 0.35 * Math.pow( tv.hit / 16.7, 2 ) );
			sound.thud( tv.hit );
			const fine = car.kind === 'micro' ? 40000 : 20000;
			if ( game.jobs ) game.jobs.fine( fine );
			hud.toast( `Chocaste ${ car.kind === 'micro' ? 'una micro' : car.kind === 'camioneta' ? 'una camioneta' : 'un auto' } a ${ Math.round( tv.hit * 3.6 ) } km/h: multa ${ fmtPesos( fine ) }`, 'alerta', 3.5 );

		}

	}

	if ( ev.bump ) sound.bump();
	if ( ev.jackknife ) hud.toast( 'Efecto tijera: avanza para enderezar el semirremolque', 'alerta', 4 );
	return ( t.odo - odo ) * ( Math.sign( t.v ) || dirSign );

}

// Deja el camión en un punto del mundo, con un rumbo de brújula en grados.
game.teleport = ( x, z, compass = 0 ) => {

	if ( game.state !== 'driving' ) return false;
	const g = game.world.groundAt( x, z );
	if ( ! g ) return false;
	const t = game.truck, cargo = t.cargoMass, damage = t.damage;
	_focus.set( x, g.y, z ); game.world.update( _focus, 1, true );
	if ( game.traffic ) game.traffic.clearNear( x, z, 45 );
	const ok = placeTruck( t, x, z, Math.PI - compass * Math.PI / 180, game.world.terrain, g.y );
	t.cargoMass = cargo; t.damage = damage;
	game.cam.init = false;
	return ok;

};

// Para pruebas automáticas: avanza la simulación sin dibujar. `inp` es una
// entrada fija ({ accel, decel, steer }) o una función del tiempo simulado.
game.advance = ( seconds, inp = {} ) => {

	if ( game.state !== 'driving' ) return false;
	const t = game.truck, n = Math.round( seconds / H );
	for ( let i = 0; i < n; i ++ ) {

		physicsStep( typeof inp === 'function' ? inp( game.simTime, t ) : inp );
		if ( i % 12 === 0 ) { _focus.set( t.x, t.y, t.z ); game.world.update( _focus, 12 * H, true ); }
		if ( game.jobs ) game.jobs.update( t, H );

	}

	if ( game.trafficView ) game.trafficView.update();
	return true;

};

function drivingStep( dt ) {

	const t = game.truck, world = game.world, jobs = game.jobs, T = game.timers;
	// `game.script` permite manejar desde una prueba: una entrada fija o una función del tiempo simulado
	const inp = game.script ? ( typeof game.script === 'function' ? game.script( game.simTime, t ) : game.script ) : input.read();

	// --- física con paso fijo
	const t0 = performance.now();
	const rays0 = world.field.rays;
	game.acc += dt;
	let steps = 0, travel = 0;
	while ( game.acc >= H && steps < 6 ) { travel += physicsStep( inp ); game.acc -= H; steps ++; }
	if ( steps === 6 ) game.acc = 0;
	game.perf.physMs += performance.now() - t0;
	game.perf.rays += world.field.rays - rays0;

	game.model.update( t, dt, travel );
	if ( game.trafficView ) game.trafficView.update();
	applyDaylight();
	updateCamera( dt, inp.look );
	_focus.set( t.x, t.y, t.z );
	world.update( _focus, dt, true );
	sound.update( t, dt );

	// --- avisos de situación
	if ( t.blocked > 0 && t.throttle > 0.3 ) { T.blocked += dt; if ( T.blocked > 1.2 ) { hud.toast( 'Hay un obstáculo. Retrocede, o desactiva los choques con G', 'alerta', 3 ); T.blocked = - 6; } } else if ( T.blocked > 0 ) T.blocked = 0; else T.blocked = Math.min( 0, T.blocked + dt );
	if ( T.side > 0 ) T.side -= dt;
	if ( ! t.grounded ) {

		T.noGround += dt; T.reseat -= dt;
		// El suelo pudo reaparecer fuera del alcance de las muestras (más de 2 m arriba o
		// más de 7 m abajo): cada medio segundo se busca con un rayo largo y, si está, el camión se apoya ahí.
		if ( T.reseat <= 0 ) {

			T.reseat = 0.5;
			// con los choques desactivados el camión puede ir por dentro de un edificio: ahí no se lo sube al techo
			const y = world.groundNear( t.x, t.z, t.y, ! game.ghost );
			if ( y !== null && reseatTruck( t, world.terrain, y ) ) T.noGround = 0;

		}

		if ( T.noGround > 2.5 ) { hud.toast( 'No hay malla cargada bajo el camión. R para volver a la calle', 'alerta', 3 ); T.noGround = - 5; }

	} else { if ( T.noGround > 0 ) T.noGround = 0; T.reseat = 1; }

	// --- posiciones seguras, para el reinicio
	T.safe += dt;
	if ( T.safe > 2 && t.grounded && t.blocked <= 0 && Math.abs( t.v ) > 1 ) { T.safe = 0; game.safe.push( { x: t.x, z: t.z, yaw: t.yaw } ); if ( game.safe.length > 12 ) game.safe.shift(); }

	// --- encargos
	if ( jobs ) {

		const ev = jobs.update( t, dt );
		if ( ev === 'delivered' ) {

			const r = jobs.last;
			hud.toast( `Entrega completada: ${ fmtPesos( r.paid ) }${ r.bonus ? ' con bono por puntualidad' : '' }`, 'logro', 6 );

		} else if ( ev === 'rerouted' ) hud.toast( 'Ruta recalculada', '', 2 );
		else if ( ev === 'offer' ) hud.toast( `Nuevo encargo disponible. ${ TOUCH ? 'Toca la guía para aceptar' : 'Enter para aceptar' }`, '', 4 );

		const dest = jobs.job && ( jobs.state === 'active' || jobs.state === 'offer' ) ? jobs.job.dest : null;
		marker.visible = !! dest && jobs.state === 'active';
		if ( marker.visible ) {

			T.marker -= dt;
			if ( marker.userData.node !== dest.node ) { marker.userData.node = dest.node; marker.userData.y = null; T.marker = 0; }
			if ( T.marker <= 0 ) {

				T.marker = 2;
				if ( Math.hypot( dest.x - t.x, dest.z - t.z ) < 400 ) { const g = world.groundAt( dest.x, dest.z ); if ( g ) marker.userData.y = g.y; }

			}

			marker.position.set( dest.x, marker.userData.y !== null && marker.userData.y !== undefined ? marker.userData.y : t.y, dest.z );

		}

	}

	// --- tablero
	T.limit -= dt;
	if ( T.limit <= 0 ) {

		T.limit = 0.5;
		const s = game.graph ? nearestSegment( game.graph, t.x, t.z, 22 ) : null;
		game.limit = s ? s.way.maxspeed : 0;
		game.street = s ? s.way.name : '';

	}

	// Dentro de un marco de otra aplicación, el teclado llega al juego solo mientras el
	// marco tiene el foco. Si lo pierde, las teclas dejan de responder sin explicación.
	if ( EMBEDDED && ! TOUCH && ! game.script ) {

		T.focus -= dt;
		if ( T.focus <= 0 ) { T.focus = 4; if ( ! document.hasFocus() && ! hud.busy ) hud.toast( 'Haz clic sobre el juego para manejar con el teclado', '', 3 ); }

	}

	T.hud -= dt;
	if ( T.hud <= 0 ) {

		T.hud = 0.1;
		hud.setDrive( speedKmh( t ), gearLabel( t ), t.rpm, game.limit );
		hud.setClock( clockText( game.hour ) );
		hud.setRpmHigh( t.rpm > t.spec.engine.powerEnd );
		updateJobCard();
		const src = world.attribution();
		hud.setAttribution( world.provider, src, world.via ? `Datos servidos por ${ world.via }` : '' );

	}

	T.map -= dt;
	if ( T.map <= 0 ) {

		T.map = 0.08;
		const active = jobs && jobs.tracker && ( jobs.state === 'active' || jobs.state === 'offer' );
		hud.drawMap( game.graph, t, active ? jobs.tracker : null, active ? jobs.job.dest : null, game.traffic ? game.traffic.vehicles : null );

	}

	hud.update( dt );

}

function updateJobCard() {

	const t = game.truck, jobs = game.jobs;
	const caja = jobs ? `Caja ${ fmtPesos( jobs.total ) } · ${ jobs.entregas } ${ jobs.entregas === 1 ? 'entrega' : 'entregas' }` : '';
	const folio = n => 'N.º ' + String( n ).padStart( 4, '0' );
	const dano = `${ Math.round( ( jobs ? jobs.damage( t ) : 0 ) * 100 ) } %`;
	if ( ! jobs || jobs.state === 'libre' ) {

		hud.setJob( { folio: '', carga: 'Sin carga', destino: 'Modo libre', faltan: '', pago: '', dano: `${ Math.round( t.damage * 100 ) } %`, timbre: 'Libre', ok: false, pista: game.street ? `Vas por ${ game.street }` : 'Rumbo ' + compassName( compassFromYaw( t.yaw ) ), caja: '' } );
		hud.setManeuver( null );
		return;

	}

	const j = jobs.job;
	if ( jobs.state === 'offer' ) {

		hud.setJob( { folio: folio( j.folio ), carga: `${ j.cargo } · ${ ( j.mass / 1000 ).toLocaleString( 'es-CL' ) }\u00a0t`, destino: j.dest.label, faltan: fmtDist( j.length ), pago: fmtPesos( j.pay ), dano: '0 %', timbre: 'Disponible', ok: false, pista: TOUCH ? 'Toca aquí para aceptar. En la pausa puedes pedir otro.' : 'Enter acepta el encargo. N pide otro.', caja } );
		hud.setManeuver( null );

	} else if ( jobs.state === 'active' ) {

		const rem = jobs.tracker.remaining;
		hud.setJob( { folio: folio( j.folio ), carga: `${ j.cargo } · ${ ( j.mass / 1000 ).toLocaleString( 'es-CL' ) }\u00a0t`, destino: j.dest.label, faltan: fmtDist( rem ), pago: fmtPesos( jobs.currentPay( t ) ), dano, timbre: 'En ruta', ok: false, pista: rem < 60 ? 'Detén el camión dentro del aro para entregar.' : ( game.street ? `Vas por ${ game.street }` : '' ), caja } );
		const g = jobs.guidance( t );
		hud.setManeuver( g ? { dist: g.dist === null ? '' : fmtDist( g.dist ), texto: g.texto, lado: g.lado } : null );

	} else if ( jobs.state === 'done' && jobs.last ) {

		const r = jobs.last;
		hud.setJob( { folio: folio( r.folio ), carga: `${ r.cargo } · ${ ( r.mass / 1000 ).toLocaleString( 'es-CL' ) }\u00a0t`, destino: r.dest.label, faltan: '0 m', pago: fmtPesos( r.paid ), dano: `${ Math.round( r.damage * 100 ) } %`, timbre: 'Entregado', ok: true, pista: 'Buscando el próximo encargo.', caja } );
		hud.setManeuver( null );

	} else {

		hud.setJob( { folio: '', carga: 'Sin carga', destino: 'Sin encargos', faltan: '', pago: '', dano, timbre: 'Libre', ok: false, pista: TOUCH ? 'Pide un encargo desde la pausa.' : 'N busca un encargo desde aquí.', caja } );
		hud.setManeuver( null );

	}

}

function debugText() {

	const t = game.truck, w = game.world, p = game.perf, s = w.stats();
	const geo = w.geo.toGeo( t.x, t.y, t.z );
	const info = renderer.info;
	return [
		`Ruta Sur ${ VERSION } · ${ WORLD_NAMES[ w.kind ] || w.kind }`,
		`${ p.fps.toFixed( 0 ) } c/s · física ${ p.physAvg.toFixed( 2 ) } ms · ${ p.rayAvg.toFixed( 0 ) } rayos por cuadro`,
		`dibujos ${ info.render.calls } · triángulos ${ ( info.render.triangles / 1e6 ).toFixed( 2 ) } M`,
		`teselas visibles ${ s.visibles } · activas ${ s.activas } · en camino ${ s.descargando } · fallidas ${ s.fallidas }${ s.rechazadas ? ` · sin memoria ${ s.rechazadas }` : '' }`,
		`memoria de teselas ${ s.cacheMB } MB · mallas cercanas ${ s.cercanas } · BVH ${ s.bvh } (${ s.bvhMs.toFixed( 0 ) } ms)`,
		`lat ${ geo.lat.toFixed( 6 ) } lon ${ geo.lon.toFixed( 6 ) } alt ${ geo.h.toFixed( 1 ) } m`,
		`rumbo ${ Math.round( compassFromYaw( t.yaw ) ) % 360 }° ${ compassName( compassFromYaw( t.yaw ) ) } · pendiente ${ ( Math.tan( t.pitch ) * 100 ).toFixed( 1 ) } % · articulación ${ Math.round( articulation( t ) * 180 / Math.PI ) || 0 }°`,
		`masa ${ ( totalMass( t ) / 1000 ).toFixed( 1 ) } t · suelo: ${ t.gTr.samples } muestras, ${ t.gTr.rejected } descartadas${ game.ghost ? ' · sin choques' : '' }`,
	].join( '\n' );

}

function frame( now = performance.now() ) {

	requestAnimationFrame( frame );
	const elapsed = Math.max( 0, now - lastFrame ) / 1000;
	const dt = Math.min( elapsed, 0.1 ); // la simulación no avanza más de 0,1 s por cuadro
	lastFrame = now;
	if ( game.state === 'menu' ) return;

	// Las esperas de la carga se miden en tiempo real: con pocos cuadros por segundo,
	// el tiempo recortado de la simulación las alargaría varias veces.
	if ( game.state === 'loading' ) loadingStep( Math.min( elapsed, 1 ) );
	else if ( game.state === 'driving' ) drivingStep( dt );
	else if ( game.state === 'paused' && game.world ) { _focus.set( game.truck.x, game.truck.y, game.truck.z ); game.world.update( _focus, dt, true ); }

	if ( game.state === 'menu' ) return; // la carga pudo terminar en error y volver al inicio
	if ( ! game.noRender ) {

		// en la cabina, los espejos se dibujan antes que la vista principal y sus recuadros después
		const mirrors = game.mirrors && game.cam.mode === 0 && game.state !== 'loading' ? game.mirrors : null;
		if ( mirrors ) mirrors.render();
		renderer.render( scene, camera );
		if ( mirrors ) mirrors.drawInsets();

	}

	const p = game.perf;
	p.frames ++; p.t += dt;
	if ( p.t >= 0.5 ) {

		p.fps = p.frames / p.t; p.physAvg = p.physMs / p.frames; p.rayAvg = p.rays / p.frames;
		p.frames = 0; p.t = 0; p.physMs = 0; p.rays = 0;
		if ( game.debug && game.state === 'driving' ) hud.setDebug( debugText() );

	}

}

window.addEventListener( 'resize', () => {

	if ( ! renderer ) return;
	renderer.setSize( window.innerWidth, window.innerHeight, false );
	camera.aspect = viewAspect();
	camera.updateProjectionMatrix();
	if ( game.world ) game.world.setResolution();

} );

document.addEventListener( 'visibilitychange', () => { if ( document.hidden && game.state === 'driving' ) setPaused( true ); } );

// El navegador puede retirar el contexto gráfico cuando falta memoria de video. La
// imagen se congela hasta que lo devuelve: se detiene la partida y se explica.
canvas.addEventListener( 'webglcontextlost', () => {

	game.contextLost = true;
	$( 'pausa-aviso' ).textContent = 'El navegador liberó la memoria de gráficos y la imagen se detuvo. Suele volver sola en unos segundos. Si no vuelve, recarga la página y elige una calidad de mapa menor.';
	if ( game.state === 'driving' ) setPaused( true );
	else if ( game.state === 'paused' ) $( 'pausa-aviso' ).hidden = false;
	else if ( game.state === 'loading' && game.world ) game.world.error = 'El navegador liberó la memoria de gráficos durante la carga. Vuelve a intentar con una calidad de mapa menor.';

} );
canvas.addEventListener( 'webglcontextrestored', () => {

	game.contextLost = false;
	$( 'pausa-aviso' ).hidden = true;
	if ( game.world && game.world.setResolution ) game.world.setResolution();
	if ( game.state === 'paused' || game.state === 'driving' ) hud.toast( 'La imagen volvió', 'logro', 3 );

} );

// Un error sin atender durante la partida abre el informe de falla: el camión se detiene mientras tanto.
guard.alFallar = () => { if ( game.state === 'driving' ) setPaused( true ); };
guard.datos.estado = () => `${ game.state }${ game.world ? ', ' + ( WORLD_NAMES[ game.world.kind ] || game.world.kind ) : '' }`;

if ( renderer ) {

	buildMenu();
	requestAnimationFrame( frame );
	guard.arranco();

	// Arranque directo para pruebas y desarrollo:
	//   ?auto=test                      ciudad de pruebas
	//   ?auto=open&lat=..&lon=..        mapa abierto desde OpenStreetMap (sin lat y lon: Temuco)
	//   &hora=21                        hora del juego al empezar (0 a 24)
	const hour = params.has( 'hora' ) ? parseFloat( params.get( 'hora' ) ) : undefined;
	if ( params.get( 'trafico' ) === '0' ) game.trafficOn = false; // &trafico=0: calles vacías
	if ( params.get( 'auto' ) === 'test' ) start( { test: true, truck: params.get( 'veh' ) || config.truck, quality: params.get( 'q' ) || config.quality, hour } );
	else if ( params.get( 'auto' ) === 'open' ) start( { open: true, lat: parseFloat( params.get( 'lat' ) ) || CITIES[ 0 ].lat, lon: parseFloat( params.get( 'lon' ) ) || CITIES[ 0 ].lon, truck: params.get( 'veh' ) || config.truck, quality: params.get( 'q' ) || config.quality, hour } );

} else {

	guard.fatal( 'Sin gráficos 3D', [
		'El juego dibuja con WebGL 2 y este navegador no pudo iniciarlo. Puede estar desactivado, o la vista donde está abierto el archivo no lo permite.',
		'Abre el archivo con una versión reciente de Chrome o Edge. Si ya lo abriste así, activa la aceleración de gráficos en la configuración del navegador y vuelve a cargar la página.',
	] );

}
