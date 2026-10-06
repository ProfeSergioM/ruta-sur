// Ruta Sur · mundo del mapa abierto
// --------------------------------------------------------------------------
// La misma interfaz que TestWorld, con la ciudad levantada desde
// OpenStreetMap (ver openmap.js). Pide calles y edificios a Overpass, arma los
// trozos de malla alrededor del camión a medida que se mueve y responde los
// rayos de la física con un BVH por trozo.

import * as THREE from 'three';
import { Geo } from './geo.js';
import { RayField, makeTerrain, longRay, nearRay, fetchRoads, fetchBuildings, viewBlocks, blockedListeners, BLOCKED_ADVICE } from './world.js';
import { openCity, chunkIndex, buildOpenChunk, groundPlane, hillRing, chunkOf, OPEN, LAYERS, RAY_LAYERS } from './openmap.js';
import { LAMP_COLORS } from './furniture.js';

// Texturas de grano dibujadas en un lienzo: valen como luminancia (alrededor del
// blanco), y el color de cada vértice les da el tono. Sin documento (las pruebas
// numéricas) no hay texturas y las capas quedan de color plano.
function makeTextures() {

	if ( typeof document === 'undefined' ) return { asphalt: null, sidewalk: null, grass: null, facade: null, windows: null, dash: null, signs: null };
	const hash = ( x, y ) => { const s = Math.sin( x * 12.9898 + y * 78.233 ) * 43758.5453; return s - Math.floor( s ); };
	// paint devuelve la luminancia (en torno a 1) o [ r, g, b, a ] en el mismo rango
	const make = ( size, paint, h = size ) => {

		const c = document.createElement( 'canvas' );
		c.width = size; c.height = h;
		const g = c.getContext( '2d' );
		if ( ! g ) return null;
		const img = g.createImageData( size, h ), d = img.data;
		const clamp = v => Math.max( 0, Math.min( 255, Math.round( 255 * v ) ) );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < size; x ++ ) {

			const p = paint( x, y ), i = ( y * size + x ) * 4;
			if ( typeof p === 'number' ) { d[ i ] = d[ i + 1 ] = d[ i + 2 ] = clamp( p ); d[ i + 3 ] = 255; }
			else { d[ i ] = clamp( p[ 0 ] ); d[ i + 1 ] = clamp( p[ 1 ] ); d[ i + 2 ] = clamp( p[ 2 ] ); d[ i + 3 ] = clamp( p[ 3 ] ); }

		}

		g.putImageData( img, 0, 0 );
		const t = new THREE.CanvasTexture( c );
		t.wrapS = t.wrapT = THREE.RepeatWrapping;
		t.colorSpace = THREE.SRGBColorSpace;
		t.anisotropy = 4;
		return t;

	};

	// asfalto: grano fino y algunas piedras más claras; los bordes de la franja, un poco más gastados
	const asphalt = make( 128, ( x, y ) => {

		const grain = 0.86 + 0.2 * hash( x, y );
		const stone = hash( x * 3 + 7, y * 5 + 1 ) > 0.985 ? 0.25 : 0;
		const edge = 1 + 0.06 * Math.cos( x / 128 * Math.PI * 2 );
		return grain * edge + stone;

	} );
	// vereda: baldosas de 32 píxeles con junta oscura y un moteado suave
	const sidewalk = make( 128, ( x, y ) => {

		const joint = ( x % 32 === 0 || y % 32 === 0 ) ? 0.72 : 1;
		const tile = 0.9 + 0.12 * hash( Math.floor( x / 32 ), Math.floor( y / 32 ) );
		return ( 0.94 + 0.1 * hash( x + 3, y + 9 ) ) * tile * joint;

	} );
	// pasto: moteado de dos escalas, con matas más oscuras
	const grass = make( 128, ( x, y ) => {

		const fine = 0.9 + 0.2 * hash( x, y ), coarse = 0.9 + 0.2 * hash( Math.floor( x / 9 ) + 100, Math.floor( y / 9 ) );
		const tuft = hash( x * 7 + 3, y * 3 + 5 ) > 0.97 ? 0.8 : 1;
		return fine * coarse * tuft;

	} );
	// fachada: una celda de 4 m por un piso, con una ventana centrada; el rincón (0, 0) es pared lisa
	const facade = make( 64, ( x, y ) => {

		const wall = 0.96 + 0.08 * hash( x, y );
		const inWin = x >= 20 && x < 44 && y >= 16 && y < 48;
		if ( ! inWin ) return wall;
		// marco claro, vidrio oscuro con un reflejo
		if ( x < 23 || x >= 41 || y < 19 || y >= 45 ) return 0.86;
		return 0.32 + 0.12 * ( ( x + y ) % 21 < 6 ? 1 : 0 ) + 0.04 * hash( x, y );

	} );
	// luces de las ventanas: la misma celda que la fachada, en un patrón de cuatro por cuatro
	// donde algunas quedan apagadas; se suma a la fachada de noche, así las ventanas brillan
	// sobre la pared oscura y la transición del crepúsculo es continua
	const windows = make( 256, ( x, y ) => {

		const cx = x % 64, cy = y % 64, cell = Math.floor( x / 64 ) * 4 + Math.floor( y / 64 );
		const inGlass = cx >= 23 && cx < 41 && cy >= 19 && cy < 45;
		if ( ! inGlass ) return 0;
		const lit = hash( cell + 3, cell * 7 ) < 0.65;
		return lit ? [ 0.95, 0.8, 0.5, 1 ] : 0;

	} );
	if ( windows ) windows.repeat.set( 0.25, 0.25 ); // cuatro celdas por lado
	// línea central discontinua: tramos de 3 m pintados y 3 m sin pintar, como transparencia
	const dash = make( 8, ( x, y ) => ( y < 32 ? [ 1, 1, 1, 1 ] : [ 1, 1, 1, 0 ] ), 64 );
	return { asphalt, sidewalk, grass, facade, windows, dash, signs: signsAtlas() };

}

// Atlas de señales: cuatro celdas de 64 px (Pare, velocidad máxima, paradero, no estacionar),
// dibujadas con el lienzo en dos dimensiones; cada placa toma una celda entera
function signsAtlas() {

	const c = document.createElement( 'canvas' );
	c.width = 256; c.height = 64;
	const g = c.getContext( '2d' );
	if ( ! g ) return null;
	g.clearRect( 0, 0, 256, 64 );
	const text = ( s, x, size, color = '#fff' ) => { g.fillStyle = color; g.font = `bold ${ size }px Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText( s, x, 33 ); };
	// Pare: octágono rojo con borde blanco
	g.fillStyle = '#b3251b'; g.beginPath();
	for ( let k = 0; k < 8; k ++ ) { const th = Math.PI / 8 + k * Math.PI / 4; g.lineTo( 32 + 30 * Math.cos( th ), 32 + 30 * Math.sin( th ) ); }
	g.closePath(); g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
	text( 'PARE', 32, 15 );
	// velocidad máxima: disco blanco con anillo rojo
	g.fillStyle = '#fff'; g.beginPath(); g.arc( 96, 32, 30, 0, 7 ); g.fill();
	g.lineWidth = 6; g.strokeStyle = '#b3251b'; g.beginPath(); g.arc( 96, 32, 27, 0, 7 ); g.stroke();
	text( '50', 96, 26, '#111' );
	// paradero: placa azul con un bus
	g.fillStyle = '#1d4e89'; g.fillRect( 164, 4, 56, 56 );
	g.fillStyle = '#fff'; g.fillRect( 176, 24, 32, 16 ); g.fillRect( 178, 18, 28, 7 );
	g.fillStyle = '#1d4e89'; g.fillRect( 180, 26, 8, 6 ); g.fillRect( 196, 26, 8, 6 );
	g.fillStyle = '#fff'; g.beginPath(); g.arc( 182, 42, 3, 0, 7 ); g.arc( 202, 42, 3, 0, 7 ); g.fill();
	// no estacionar: disco azul, anillo y barra rojos
	g.fillStyle = '#1d4e89'; g.beginPath(); g.arc( 224, 32, 30, 0, 7 ); g.fill();
	g.lineWidth = 6; g.strokeStyle = '#b3251b'; g.beginPath(); g.arc( 224, 32, 27, 0, 7 ); g.stroke();
	g.beginPath(); g.moveTo( 205, 13 ); g.lineTo( 243, 51 ); g.stroke();
	const t = new THREE.CanvasTexture( c );
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	return t;

}

export class OpenWorld {

	constructor( { scene, lat, lon, far = 4000 } ) {

		this.kind = 'open';
		this.scene = scene;
		this.geo = new Geo( lat, lon, 0 );
		this.field = new RayField();
		this.field.unlimited = true;
		this.terrain = makeTerrain( this.field );
		this.group = new THREE.Group();
		this.group.name = 'Mapa abierto';
		scene.add( this.group );
		// Cada capa se acerca un poco más a la cámara en profundidad (desplazamiento de
		// polígono), así la calzada tapa la vereda y la vereda al suelo a cualquier distancia.
		// La calzada y la vereda llevan una textura de grano, que el color del vértice tiñe.
		const layer = ( k, map = null, extra = {} ) => new THREE.MeshBasicMaterial( { vertexColors: true, map, polygonOffset: k !== 0, polygonOffsetFactor: - k, polygonOffsetUnits: - 2 * k, ...extra } );
		const T = this.textures = makeTextures();
		this.materials = {
			ground: layer( 0, T.grass ), buildings: layer( 0, T.facade ), decor: layer( 0 ), solid: layer( 0 ),
			// placas de las señales: la textura del atlas, transparente fuera de la placa
			sign: layer( 0, T.signs, T.signs ? { transparent: true, alphaTest: 0.5, side: THREE.DoubleSide } : {} ),
			park: layer( 1, T.grass ), walk: layer( 2, T.sidewalk ), road: layer( 3, T.asphalt ),
			line: layer( 4, null, T.dash ? { alphaMap: T.dash, alphaTest: 0.5 } : {} ),
			// luces de las ventanas: se suman a la fachada; de día no se dibujan
			windows: new THREE.MeshBasicMaterial( { map: T.windows, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: - 1, polygonOffsetUnits: - 2 } ),
			// las lámparas no llevan el tinte de la noche: de noche se encienden
			glow: new THREE.MeshBasicMaterial( { vertexColors: true } ),
			// charcos de luz bajo los faroles: se suman a la calzada, y de día no se dibujan
			pool: new THREE.MeshBasicMaterial( { vertexColors: true, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: - 5, polygonOffsetUnits: - 10 } ),
			plane: new THREE.MeshBasicMaterial( { vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 } ),
			hills: new THREE.MeshBasicMaterial( { vertexColors: true } ),
		};
		this.materials.pool.visible = false;
		this.materials.windows.visible = false;
		this.materials.glow.color.setRGB( 0.75, 0.75, 0.72 );
		this.lampsOn = false;
		this.city = null;
		this.chunks = new Map();   // "i,j" -> { rays (las capas que responden la física), meshes (todas), i, j, cx, cz }
		this._all = [];
		this._since = 1;
		this.error = null;
		this.roadsData = null; this.buildingsData = null;
		this.roadsError = null; this.buildingsError = null;
		this.built = 0; this.buildMs = 0; this.trees = 0; this.lamps = 0;
		this.furniture = { postes: 0, estacionados: 0, paraderos: 0, senales: 0, semaforos: 0, bancas: 0 };
		this.signals = null; this.signalTime = 0; this._signalT = 0; // semáforos: el juego los asigna y pone la hora
		this.pending = 0;          // trozos por construir dentro del radio de carga
		this.pendingNear = 0;      // trozos por construir dentro del radio que la carga espera
		this.loadT = 0;
		this.ground = this._mesh( groundPlane(), this.materials.plane );
		// los cerros quedan dentro del alcance de la vista, entre la mitad y el 80 % del fondo, para que la bruma los suavice
		this.hills = this._mesh( hillRing( far * 0.55, far * 0.8 ), this.materials.hills, false );
		this._roads = fetchRoads( lat, lon, OPEN.roadsRadius ).then( r => { this.roadsData = r; return r; }, e => { this.roadsError = e; throw e; } );
		const buildings = fetchBuildings( lat, lon, OPEN.buildingsRadius ).then( b => { this.buildingsData = b; }, e => { this.buildingsError = e; } );
		Promise.allSettled( [ this._roads, buildings ] ).then( () => this._assemble() );

	}

	// La red vial, compartida con la carga de la partida (una sola consulta)
	roads() { return this._roads; }

	// Sin respuesta de OpenStreetMap: la causa y la salida. El aviso de un pedido bloqueado
	// por la vista llega un instante después de que el pedido falla, así que si todavía no
	// hay bloqueo anotado se queda escuchando y vuelve a explicar cuando llegue.
	_explain() {

		if ( this.disposed ) return;
		if ( viewBlocks( 'overpass-api.de', 'private.coffee' ) ) {

			this.error = `La vista donde está abierto el juego bloquea la conexión con OpenStreetMap. ${ BLOCKED_ADVICE } La ciudad de pruebas funciona en esta vista.`;
			this._unlisten();

		} else {

			const msg = this.roadsError && this.roadsError.message;
			const net = /Failed to fetch|NetworkError|Load failed/i.test( msg || '' );
			this.error = `No se pudo leer OpenStreetMap: ${ net ? 'no hubo respuesta del servicio' : ( msg || 'el servicio no respondió' ) }. Revisa la conexión a internet y vuelve a intentar.`;
			if ( ! this._onBlocked ) { this._onBlocked = () => this._explain(); blockedListeners.add( this._onBlocked ); }

		}

	}

	_unlisten() { if ( this._onBlocked ) { blockedListeners.delete( this._onBlocked ); this._onBlocked = null; } }

	_assemble() {

		if ( this.disposed ) return;
		if ( ! this.roadsData && ! this.buildingsData ) return this._explain();

		this.city = openCity( this.roadsData || { elements: [] }, this.buildingsData || { elements: [] }, this.geo );
		chunkIndex( this.city, OPEN.chunk );

	}

	// Segunda malla sobre la misma geometría, con otro material
	_twin( mesh, material ) {

		const twin = new THREE.Mesh( mesh.geometry, material );
		twin.matrixAutoUpdate = false;
		this.group.add( twin );
		twin.updateWorldMatrix( true );
		return twin;

	}

	_mesh( m, material, rays = true ) {

		if ( m.indices.length === 0 ) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
		g.setAttribute( 'color', new THREE.BufferAttribute( m.colors, 3 ) );
		if ( m.uvs && m.uvs.length === m.positions.length / 3 * 2 ) g.setAttribute( 'uv', new THREE.BufferAttribute( m.uvs, 2 ) );
		g.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
		const mesh = new THREE.Mesh( g, material );
		mesh.matrixAutoUpdate = false;
		this.group.add( mesh );
		mesh.updateWorldMatrix( true );
		if ( rays ) RayField.prepare( mesh );
		return mesh;

	}

	update( focus, dt ) {

		this.loadT += dt;
		if ( ! this.city ) return;
		const size = this.city.chunk;
		const ci = chunkOf( focus.x, size ), cj = chunkOf( focus.z, size );
		const span = Math.ceil( OPEN.buildRadius / size );
		// trozos que faltan, del más cercano al más lejano
		const todo = [];
		let pendingNear = 0;
		for ( let i = ci - span; i <= ci + span; i ++ ) for ( let j = cj - span; j <= cj + span; j ++ ) {

			const k = `${ i },${ j }`;
			if ( this.chunks.has( k ) ) continue;
			const d = Math.hypot( ( i + 0.5 ) * size - focus.x, ( j + 0.5 ) * size - focus.z );
			if ( d > OPEN.buildRadius ) continue;
			todo.push( { i, j, d } );
			if ( d < OPEN.readyRadius ) pendingNear ++;

		}

		todo.sort( ( a, b ) => a.d - b.d );
		this.pending = todo.length;
		this.pendingNear = pendingNear;
		// se construyen trozos mientras quede presupuesto de tiempo en el cuadro
		const t0 = performance.now(), budget = this.field.unlimited ? 12 : 5;
		for ( const c of todo ) {

			if ( performance.now() - t0 > budget && c.d > OPEN.readyRadius ) break;
			const parts = buildOpenChunk( this.city, c.i, c.j );
			const meshes = [], rays = [];
			let glowMesh = null;
			for ( const name of LAYERS ) {

				const ray = RAY_LAYERS.includes( name );
				const mesh = this._mesh( parts[ name ], this.materials[ name ], ray );
				if ( ! mesh ) continue;
				if ( name === 'glow' ) glowMesh = mesh;
				meshes.push( mesh );
				if ( ray ) rays.push( mesh );
				// las luces de las ventanas comparten la geometría de los edificios
				if ( name === 'buildings' ) meshes.push( this._twin( mesh, this.materials.windows ) );

			}

			this.trees += parts.trees; this.lamps += parts.lamps;
			const F = this.furniture; F.postes += parts.poles; F.estacionados += parts.parked; F.paraderos += parts.stops; F.senales += parts.signs; F.semaforos += parts.lights; F.bancas += parts.benches;
			this.chunks.set( `${ c.i },${ c.j }`, { rays, meshes, objects: parts.objects, lamps: glowMesh && parts.signalLamps.length ? { attr: glowMesh.geometry.getAttribute( 'color' ), list: parts.signalLamps, shown: null } : null, i: c.i, j: c.j, cx: ( c.i + 0.5 ) * size, cz: ( c.j + 0.5 ) * size } );
			this.built ++;
			this.pending --;
			if ( c.d < OPEN.readyRadius ) this.pendingNear --;
			if ( performance.now() - t0 > budget ) break;

		}

		this.buildMs += performance.now() - t0;

		// visibilidad, liberación y candidatas para los rayos
		this._since += dt;
		if ( this._since > 0.2 || this.field.meshes.length === 0 ) {

			this._since = 0;
			const near = this.field.meshes, all = this._all;
			near.length = 0; all.length = 0;
			all.push( this.ground );
			for ( const [ k, c ] of this.chunks ) {

				const d = Math.hypot( c.cx - focus.x, c.cz - focus.z );
				if ( d > OPEN.dropRadius ) { for ( const m of c.meshes ) { this.group.remove( m ); m.geometry.dispose(); } this.chunks.delete( k ); continue; }
				for ( const m of c.meshes ) m.visible = d < OPEN.showRadius;
				for ( const m of c.rays ) {

					all.push( m );
					m.userData.rs.dist = d;
					if ( d < OPEN.nearRadius + size * 0.71 ) near.push( m );

				}

			}

			near.sort( ( a, b ) => a.userData.rs.dist - b.userData.rs.dist );
			this.ground.userData.rs.dist = 1e9;
			near.push( this.ground ); // el suelo plano responde cuando no hay trozo (al final: es el más lejano)

		}

		this.field.budget = 1;
		this.field.prewarm();

		// las lámparas de los semáforos siguen el estado de los cruces, unas veces por segundo
		this._signalT += dt;
		if ( this.signals && this._signalT > 0.15 ) { this._signalT = 0; this._paintSignals(); }

	}

	_paintSignals() {

		const S = this.signals, time = this.signalTime;
		for ( const c of this.chunks.values() ) {

			if ( ! c.lamps || ! c.meshes[ 0 ].visible ) continue;
			let changed = false;
			const arr = c.lamps.attr.array;
			for ( const l of c.lamps.list ) {

				const cr = S.atKey( l.key );
				const state = cr ? S.state( cr, cr.majorIds[ l.group === 0 ? 0 : cr.majorIds.length - 1 ], time ) : ( l.group === 0 ? 'green' : 'red' );
				const lit = state === l.lamp;
				if ( l.lit === lit ) continue;
				l.lit = lit; changed = true;
				const col = lit ? LAMP_COLORS[ l.lamp ] : LAMP_COLORS.off;
				for ( let v = l.v0; v < l.v1; v ++ ) { arr[ v * 3 ] = col[ 0 ]; arr[ v * 3 + 1 ] = col[ 1 ]; arr[ v * 3 + 2 ] = col[ 2 ]; }

			}

			if ( changed ) c.lamps.attr.needsUpdate = true;

		}

	}

	setColumn() {}
	releaseColumn() {}
	setResolution() {}
	settle() {}

	// Luz del día: `tint` oscurece la ciudad; `lamps` (0 a 1) enciende faroles, charcos y ventanas
	setLight( { tint, lamps = 0, level = 1 } ) {

		const M = this.materials;
		for ( const name of [ 'ground', 'buildings', 'park', 'walk', 'road', 'line', 'decor', 'solid', 'sign', 'plane', 'hills' ] ) M[ name ].color.setRGB( tint[ 0 ], tint[ 1 ], tint[ 2 ] );
		this.lampsOn = lamps > 0;
		M.glow.color.setRGB( 0.75 + 0.25 * lamps, 0.75 + 0.17 * lamps, 0.72 - 0.02 * lamps );
		M.pool.visible = M.windows.visible = this.lampsOn;
		M.pool.opacity = 0.6 * lamps * ( 1 - 0.7 * level );
		M.windows.opacity = lamps;

	}
	get stalled() { return 0; }
	get tileProblem() { return null; }
	get ready() { return !! this.city && this.pendingNear === 0 && this.chunks.size > 0; }

	get progress() {

		if ( ! this.city ) return { ready: false, text: this.loadT < 8 ? 'Pidiendo las calles y los edificios a OpenStreetMap' : 'Esperando a OpenStreetMap (la consulta puede tardar hasta un minuto)', pending: 1 };
		if ( ! this.ready ) return { ready: false, text: `Levantando la ciudad desde OpenStreetMap (${ this.pending } trozos)`, pending: this.pending };
		return { ready: true, text: 'Ciudad lista', pending: 0 };

	}

	groundNear( x, z, y, above = true ) { return nearRay( this.field, x, z, y, this._all, above ); }
	groundAt( x, z ) { return longRay( this.field, x, z, this._all ); }

	attribution() { return '© OpenStreetMap contributors'; }
	get provider() { return 'OpenStreetMap'; }
	get via() { return ''; }

	stats() {

		return { visibles: this.chunks.size, activas: this.chunks.size, descargando: this.pending, fallidas: this.buildingsError ? 1 : 0, rechazadas: 0, cacheMB: 0,
			cercanas: this.field.meshes.length, rayos: this.field.rays, bvh: this.field.builds, bvhMs: this.field.buildMs,
			edificios: this.city ? this.city.buildings.length : 0, vias: this.city ? this.city.ways.length : 0,
			manchas: this.city ? this.city.greens.length : 0, arbolesOSM: this.city ? this.city.trees.length : 0, arboles: this.trees, faroles: this.lamps, cruces: this.city ? this.city.crossings.length : 0, ...this.furniture };

	}

	startHint() { return { x: 0, z: 0, yaw: Math.PI }; }

	dispose() {

		this.disposed = true;
		this._unlisten();
		this.scene.remove( this.group );
		for ( const c of this.chunks.values() ) for ( const m of c.meshes ) m.geometry.dispose();
		this.chunks.clear();
		this.ground.geometry.dispose();
		this.hills.geometry.dispose();
		for ( const m of Object.values( this.materials ) ) m.dispose();
		for ( const t of Object.values( this.textures ) ) if ( t ) t.dispose();

	}

}
