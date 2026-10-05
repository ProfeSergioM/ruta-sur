// Ruta Sur · el mundo
// --------------------------------------------------------------------------
// Dos mundos con la misma interfaz:
//   OpenWorld   el mapa abierto, levantado desde OpenStreetMap (openworld.js)
//   TestWorld   la ciudad de pruebas, generada en el navegador (aquí)
//
// Ambos ofrecen `terrain` (lo que consulta la física), `groundAt` (un rayo
// largo para ubicar el suelo al aparecer), la red vial y el texto de atribución.
// Este módulo trae además lo que comparten: los rayos contra las mallas, las
// consultas a Overpass con su memoria local y la detección de una vista que
// bloquea la red.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { Geo } from './geo.js';
import { overpassQuery, buildingsQuery, OVERPASS_ENDPOINTS } from './osm.js';
import { generateCity, buildRegion, cityChunks, cityRoadsOSM, CITY_START } from './testcity.js';

// ---------------------------------------------------------------------------
// Conexiones que la vista no deja salir
// ---------------------------------------------------------------------------
// El juego puede quedar abierto dentro de otra aplicación (una vista previa). Esas
// vistas suelen traer una política de seguridad que bloquea los pedidos a otros
// servidores. El navegador lo avisa con un evento por cada pedido bloqueado: con eso
// el juego puede decir la causa real, en vez de suponer una falla de la conexión.
const blockedHosts = new Set();
const blockedListeners = new Set(); // a quién avisar cuando se anota un servidor bloqueado
if ( typeof document !== 'undefined' && document.addEventListener ) {

	document.addEventListener( 'securitypolicyviolation', e => noteBlocked( e.blockedURI ) );

}

export function noteBlocked( uri ) {

	let host;
	try { host = new URL( uri ).host; } catch ( err ) { return; } // "inline", "eval" u otro valor sin dirección
	if ( ! host || blockedHosts.has( host ) ) return;
	blockedHosts.add( host );
	for ( const fn of [ ...blockedListeners ] ) fn();

}

// ¿La vista bloqueó algún pedido a estos servidores? Cada patrón es el final del nombre del servidor.
export function viewBlocks( ...suffixes ) {

	for ( const h of blockedHosts ) if ( suffixes.some( s => h === s || h.endsWith( '.' + s ) ) ) return true;
	return false;

}

// ¿El juego está dentro de un marco de otra página?
export const EMBEDDED = ( () => { try { return typeof window !== 'undefined' && !! window.top && window.top !== window.self; } catch ( e ) { return true; } } )();

export const BLOCKED_ADVICE = 'Guarda el archivo ruta-sur.html en tu computador y ábrelo con doble clic en Chrome o Edge.';

const DEG = Math.PI / 180;

// far: alcance de la vista [m]; pixelRatio: tope de densidad de píxeles;
// mirror: ancho de la textura de cada espejo [px]; mirrorBoth: los dos espejos en cada cuadro (si no, uno por cuadro)
export const QUALITY = {
	baja: { label: 'Baja', far: 2500, pixelRatio: 1, mirror: 128, mirrorBoth: false },
	media: { label: 'Media', far: 4000, pixelRatio: 1.5, mirror: 192, mirrorBoth: false },
	alta: { label: 'Alta', far: 6000, pixelRatio: 2, mirror: 256, mirrorBoth: true },
};

// ---------------------------------------------------------------------------
// Rayos contra un conjunto de mallas, acelerados con un BVH por malla
// ---------------------------------------------------------------------------
const _box = new THREE.Box3();
const _ray = new THREE.Ray();
const _localRay = new THREE.Ray();
const _n = new THREE.Vector3();
const _v = new THREE.Vector3();

export class RayField {

	constructor() {

		this.meshes = [];          // candidatas cercanas, ordenadas por distancia
		this.budget = 1;           // BVH que se pueden construir en este cuadro
		this.unlimited = false;    // durante la carga no hay tope
		this.ny = 1;
		this.normal = new Float64Array( [ 0, 1, 0 ] ); // normal de la última superficie tocada
		this.rays = 0; this.builds = 0; this.buildMs = 0;

	}

	// Datos por malla que no cambian mientras la malla no se mueva
	static prepare( mesh ) {

		let d = mesh.userData.rs;
		if ( ! d ) {

			const g = mesh.geometry;
			if ( ! g.boundingBox ) g.computeBoundingBox();
			d = mesh.userData.rs = { box: new THREE.Box3(), inv: new THREE.Matrix4(), minScale: 1, side: THREE.FrontSide };
			d.box.copy( g.boundingBox ).applyMatrix4( mesh.matrixWorld );
			d.inv.copy( mesh.matrixWorld ).invert();
			// escala menor de la malla: acota cuánto mide, en su espacio local, un rayo del mundo
			const m = mesh.matrixWorld.elements;
			d.minScale = Math.min( Math.hypot( m[ 0 ], m[ 1 ], m[ 2 ] ), Math.hypot( m[ 4 ], m[ 5 ], m[ 6 ] ), Math.hypot( m[ 8 ], m[ 9 ], m[ 10 ] ) ) || 1;
			const mat = Array.isArray( mesh.material ) ? mesh.material[ 0 ] : mesh.material;
			d.side = mat ? mat.side : THREE.FrontSide;

		}

		return d;

	}

	ensureBVH( mesh ) {

		const g = mesh.geometry;
		if ( g.boundsTree ) return true;
		if ( ! this.unlimited && this.budget <= 0 ) return false;
		const t0 = performance.now();
		g.boundsTree = new MeshBVH( g );
		this.buildMs += performance.now() - t0;
		this.builds ++; this.budget --;
		return true;

	}

	// Construye el BVH de la malla más cercana que aún no lo tenga
	prewarm() {

		for ( const m of this.meshes ) if ( ! m.geometry.boundsTree ) { this.ensureBVH( m ); return; }

	}

	/**
	 * Primer impacto del rayo. Devuelve la distancia o Infinity, y deja la
	 * componente vertical de la normal en `this.ny` y la normal completa en `this.normal`.
	 */
	cast( ox, oy, oz, dx, dy, dz, far, list = this.meshes ) {

		this.rays ++;
		_ray.origin.set( ox, oy, oz ); _ray.direction.set( dx, dy, dz );
		let best = far, ny = 1, found = false;
		for ( let i = 0; i < list.length; i ++ ) {

			const mesh = list[ i ], d = mesh.userData.rs;
			if ( ! d ) continue;
			// descarte rápido con la caja de la malla
			const b = d.box;
			if ( dy === - 1 && dx === 0 && dz === 0 ) {

				if ( ox < b.min.x || ox > b.max.x || oz < b.min.z || oz > b.max.z || oy < b.min.y || oy - best > b.max.y ) continue;

			} else if ( ! b.containsPoint( _ray.origin ) ) {

				// origen fuera de la caja: la entrada debe quedar dentro del alcance del rayo
				if ( ! _ray.intersectBox( b, _v ) || _v.distanceToSquared( _ray.origin ) > best * best ) continue;

			}

			if ( ! this.ensureBVH( mesh ) ) continue;
			_localRay.copy( _ray ).applyMatrix4( d.inv );
			const hit = mesh.geometry.boundsTree.raycastFirst( _localRay, d.side, 0, best / d.minScale );
			if ( ! hit ) continue;
			// la distancia se mide en el mundo: vale también si la malla tiene escala distinta en cada eje
			const dist = _v.copy( hit.point ).applyMatrix4( mesh.matrixWorld ).distanceTo( _ray.origin );
			if ( dist < best ) {

				best = dist; found = true;
				_n.copy( hit.face.normal ).transformDirection( mesh.matrixWorld );
				ny = Math.abs( _n.y );

			}

		}

		this.ny = ny;
		if ( found ) { const n = this.normal; n[ 0 ] = _n.x; n[ 1 ] = _n.y; n[ 2 ] = _n.z; }
		return found ? best : Infinity;

	}

}

// Rayo largo hacia abajo. Entre teselas vecinas quedan rendijas de milímetros,
// así que si el rayo central no toca nada se prueba alrededor.
const PROBE = [ [ 0, 0 ], [ 0.3, 0.2 ], [ - 0.3, - 0.2 ], [ 0.2, - 0.3 ], [ - 0.2, 0.3 ] ];
export function longRay( field, x, z, list ) {

	const was = field.unlimited;
	field.unlimited = true;
	let out = null;
	for ( const [ dx, dz ] of PROBE ) {

		const d = field.cast( x + dx, 9000, z + dz, 0, - 1, 0, 12000, list );
		if ( d !== Infinity ) { out = { y: 9000 - d, ny: field.ny }; break; }

	}

	field.unlimited = was;
	return out;

}

// Suelo más cercano a una altura dada: hacia abajo desde 2 m sobre ella y, si no
// hay nada, la primera superficie que aparece bajando desde 80 m más arriba.
export function nearRay( field, x, z, y, list, above = true ) {

	const was = field.unlimited;
	field.unlimited = true;
	let out = null;
	for ( const [ dx, dz ] of PROBE ) {

		let d = field.cast( x + dx, y + 2, z + dz, 0, - 1, 0, 400, list );
		if ( d !== Infinity ) { out = y + 2 - d; break; }
		if ( ! above ) continue;
		d = field.cast( x + dx, y + 80, z + dz, 0, - 1, 0, 78, list );
		if ( d !== Infinity ) { out = y + 80 - d; break; }

	}

	field.unlimited = was;
	return out;

}

// La interfaz que consulta la física
export function makeTerrain( field ) {

	return {
		ny: 1,
		normal: field.normal,
		sampleGround( x, z, yRef ) {

			// el rayo parte 2 m sobre la referencia: no ve lo que pasa por encima del camión
			const d = field.cast( x, yRef + 2, z, 0, - 1, 0, 9 );
			this.ny = field.ny;
			return d === Infinity ? NaN : yRef + 2 - d;

		},
		castObstacle( ox, oy, oz, dx, dy, dz, max ) {

			return field.cast( ox, oy, oz, dx, dy, dz, max );

		},
	};

}

// ---------------------------------------------------------------------------
// Red vial desde Overpass, con respaldo entre instancias y memoria local
// ---------------------------------------------------------------------------
const ROADS_PREFIX = 'rutasur.calles.3.';   // la versión cambia cuando cambia la consulta o el formato guardado
const BUILDINGS_PREFIX = 'rutasur.edificios.1.';
const ROADS_OLD = [ 'rutasur.roads.', 'rutasur.calles.2.' ]; // formatos anteriores: se borran al encontrarlos
const ROADS_TTL = 14 * 864e5;               // dos semanas
const ROADS_TIMEOUT = 50000;                // espera máxima por instancia [ms]; la consulta pide hasta 40 s al servidor

// Formato guardado: compacto, porque el almacenamiento local del navegador admite
// unos 5 millones de caracteres y la red de una ciudad grande ocupa varios megas en JSON.
// Cada vía es [ id, nodos, [ lat, lon, lat, lon, ... ], etiquetas ].
function packRoads( osm ) {

	return osm.elements.map( e => [ e.id, e.nodes || null, e.geometry.flatMap( p => ( p ? [ p.lat, p.lon ] : [ null, null ] ) ), e.tags ] );

}

function unpackRoads( packed ) {

	return { elements: packed.map( ( [ id, nodes, flat, tags ] ) => {

		const geometry = [];
		for ( let i = 0; i < flat.length; i += 2 ) geometry.push( flat[ i ] === null ? null : { lat: flat[ i ], lon: flat[ i + 1 ] } );
		const el = { type: 'way', id, geometry, tags };
		if ( nodes ) el.nodes = nodes;
		return el;

	} ) };

}

// Edificios guardados: [ id, [ lat, lon, ... ], etiquetas ]
function packBuildings( osm ) {

	return osm.elements.map( e => [ e.id, e.geometry.flatMap( p => [ p.lat, p.lon ] ), e.tags ] );

}

function unpackBuildings( packed ) {

	return { elements: packed.map( ( [ id, flat, tags ] ) => {

		const geometry = [];
		for ( let i = 0; i < flat.length; i += 2 ) geometry.push( { lat: flat[ i ], lon: flat[ i + 1 ] } );
		return { type: 'way', id, geometry, tags };

	} ) };

}

// Datos guardados con un prefijo (redes o edificios), de los más antiguos a los más
// nuevos. Borra de paso los vencidos, los dañados y los de un formato anterior.
function cacheEntries( prefix ) {

	const live = [];
	try {

		const drop = [];
		for ( let i = 0; i < localStorage.length; i ++ ) {

			const k = localStorage.key( i );
			if ( ! k ) continue;
			if ( ROADS_OLD.some( p => k.startsWith( p ) ) ) { drop.push( k ); continue; }
			if ( ! k.startsWith( prefix ) ) continue;
			let t = NaN;
			try { t = JSON.parse( localStorage.getItem( k ) ).t; } catch ( e ) { /* entrada dañada */ }
			if ( Date.now() - t < ROADS_TTL ) live.push( { k, t } ); else drop.push( k );

		}

		for ( const k of drop ) localStorage.removeItem( k );

	} catch ( e ) { /* sin almacenamiento local */ }

	return live.sort( ( a, b ) => a.t - b.t );

}

const roadCacheEntries = () => cacheEntries( ROADS_PREFIX );

// Guarda una red o un conjunto de edificios. Si no cabe, hace lugar borrando los más antiguos del mismo tipo.
function storeCached( prefix, key, packed ) {

	const value = JSON.stringify( { t: Date.now(), w: packed } );
	const older = cacheEntries( prefix ).filter( e => e.k !== key );
	for ( ;; ) {

		try { localStorage.setItem( key, value ); return true; } catch ( e ) {

			const victim = older.shift();
			if ( ! victim ) return false; // no cabe ni sola: se usa sin guardar
			try { localStorage.removeItem( victim.k ); } catch ( e2 ) { return false; }

		}

	}

}

export async function fetchRoads( lat, lon, radius = 2500 ) {

	const cacheKey = `${ ROADS_PREFIX }${ lat.toFixed( 3 ) }.${ lon.toFixed( 3 ) }.${ radius }`;
	roadCacheEntries();
	try {

		const hit = localStorage.getItem( cacheKey );
		if ( hit ) {

			const o = JSON.parse( hit );
			if ( o && Array.isArray( o.w ) && o.w.length > 0 ) return unpackRoads( o.w );

		}

	} catch ( e ) { /* sin almacenamiento local, o entrada ilegible: se consulta de nuevo */ }

	const body = 'data=' + encodeURIComponent( overpassQuery( lat, lon, radius ) );
	let lastError = null;
	for ( const url of OVERPASS_ENDPOINTS ) {

		const ctl = new AbortController();
		const timer = setTimeout( () => ctl.abort(), ROADS_TIMEOUT );
		try {

			const res = await fetch( url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal } );
			if ( ! res.ok ) throw new Error( `Overpass respondió ${ res.status }` );
			const data = await res.json();
			if ( ! data.elements ) throw new Error( 'Respuesta de Overpass sin elementos' );
			// una consulta que se quedó sin tiempo responde 200 con una nota de error y datos parciales
			if ( typeof data.remark === 'string' && /error|timed out/i.test( data.remark ) ) throw new Error( `Overpass: ${ data.remark }` );
			// solo se conserva lo que usa el juego
			const slim = { elements: data.elements.filter( e => e.type === 'way' && Array.isArray( e.geometry ) ).map( e => ( { type: 'way', id: e.id, nodes: e.nodes, geometry: e.geometry, tags: pickTags( e.tags ) } ) ) };
			if ( slim.elements.length > 0 ) storeCached( ROADS_PREFIX, cacheKey, packRoads( slim ) );
			return slim;

		} catch ( e ) {

			lastError = e;

		} finally { clearTimeout( timer ); }

	}

	throw lastError || new Error( 'Overpass no respondió' );

}

function pickTags( t = {} ) {

	const out = {};
	for ( const k of [ 'highway', 'name', 'ref', 'oneway', 'junction', 'maxspeed', 'access', 'vehicle', 'motor_vehicle', 'hgv', 'area' ] ) if ( t[ k ] !== undefined ) out[ k ] = t[ k ];
	return out;

}

function pickBuildingTags( t = {} ) {

	const out = {};
	for ( const k of [ 'building', 'height', 'building:levels', 'name' ] ) if ( t[ k ] !== undefined ) out[ k ] = String( t[ k ] ).slice( 0, 60 );
	return out;

}

// Edificios de OpenStreetMap alrededor de un punto, con la misma memoria local que las calles.
// Solo las vías cerradas con al menos tres esquinas distintas.
export async function fetchBuildings( lat, lon, radius = 1500 ) {

	const cacheKey = `${ BUILDINGS_PREFIX }${ lat.toFixed( 3 ) }.${ lon.toFixed( 3 ) }.${ radius }`;
	cacheEntries( BUILDINGS_PREFIX );
	try {

		const hit = localStorage.getItem( cacheKey );
		if ( hit ) {

			const o = JSON.parse( hit );
			if ( o && Array.isArray( o.w ) ) return unpackBuildings( o.w );

		}

	} catch ( e ) { /* sin almacenamiento local, o entrada ilegible: se consulta de nuevo */ }

	const body = 'data=' + encodeURIComponent( buildingsQuery( lat, lon, radius ) );
	let lastError = null;
	for ( const url of OVERPASS_ENDPOINTS ) {

		const ctl = new AbortController();
		const timer = setTimeout( () => ctl.abort(), ROADS_TIMEOUT );
		try {

			const res = await fetch( url, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal } );
			if ( ! res.ok ) throw new Error( `Overpass respondió ${ res.status }` );
			const data = await res.json();
			if ( ! data.elements ) throw new Error( 'Respuesta de Overpass sin elementos' );
			if ( typeof data.remark === 'string' && /error|timed out/i.test( data.remark ) ) throw new Error( `Overpass: ${ data.remark }` );
			const slim = { elements: [] };
			for ( const e of data.elements ) {

				if ( e.type !== 'way' || ! Array.isArray( e.geometry ) || ! e.tags || ! e.tags.building ) continue;
				const g = e.geometry.filter( p => p && typeof p.lat === 'number' && typeof p.lon === 'number' );
				// una vía cerrada repite el primer punto al final
				if ( g.length > 1 && g[ 0 ].lat === g[ g.length - 1 ].lat && g[ 0 ].lon === g[ g.length - 1 ].lon ) g.pop();
				if ( g.length < 3 ) continue;
				slim.elements.push( { type: 'way', id: e.id, geometry: g, tags: pickBuildingTags( e.tags ) } );

			}

			storeCached( BUILDINGS_PREFIX, cacheKey, packBuildings( slim ) );
			return slim;

		} catch ( e ) {

			lastError = e;

		} finally { clearTimeout( timer ); }

	}

	throw lastError || new Error( 'Overpass no respondió' );

}

// ---------------------------------------------------------------------------
// Ciudad de pruebas
// ---------------------------------------------------------------------------
// Imita el comportamiento de una malla fotogramétrica por niveles de detalle:
// cada trozo de ciudad tiene una versión gruesa, que se ve de lejos y queda
// 25 cm más arriba (el error típico de un nivel bajo), y una fina que se
// construye al acercarse.
const FINE_IN = 170, FINE_OUT = 215, COARSE_LIFT = 0.25;

export class TestWorld {

	constructor( { scene, lat = - 38.739141, lon = - 72.590355 } ) {

		this.kind = 'test';
		this.scene = scene;
		this.geo = new Geo( lat, lon, 0 );
		this.field = new RayField();
		this.field.unlimited = true;
		this.terrain = makeTerrain( this.field );
		this.group = new THREE.Group();
		this.group.name = 'Ciudad de pruebas';
		scene.add( this.group );
		this.material = new THREE.MeshBasicMaterial( { vertexColors: true } );
		this.city = generateCity( 7 );
		this.chunks = cityChunks().map( c => ( { ...c, box: new THREE.Box3( new THREE.Vector3( c.x0, - 50, c.z0 ), new THREE.Vector3( c.x1, 120, c.z1 ) ), coarse: null, fine: null } ) );
		this.builtCoarse = 0;
		this.pendingFine = 0;
		this._all = [];
		this._since = 1;
		this.error = null;

	}

	_mesh( c, fine ) {

		const m = buildRegion( this.city, c.x0, c.z0, c.x1, c.z1, fine ? { step: 1 } : { step: 5.5, detail: false, lift: COARSE_LIFT, rough: false } );
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
		g.setAttribute( 'color', new THREE.BufferAttribute( m.colors, 3 ) );
		g.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
		const mesh = new THREE.Mesh( g, this.material );
		mesh.matrixAutoUpdate = false;
		this.group.add( mesh );
		mesh.updateMatrixWorld( true );
		RayField.prepare( mesh );
		return mesh;

	}

	update( focus, dt ) {

		// versiones gruesas: varias por cuadro hasta completar la ciudad
		const t0 = performance.now();
		while ( this.builtCoarse < this.chunks.length && performance.now() - t0 < 10 ) {

			const c = this.chunks[ this.builtCoarse ++ ];
			c.coarse = this._mesh( c, false );

		}

		this._since += dt;
		if ( this.builtCoarse >= this.chunks.length && ( this._since > 0.2 || this.pendingFine > 0 ) ) {

			this._since = 0;
			// versión fina cerca del foco: se construye una por cuadro, la más cercana primero
			let pending = 0, next = null, nextD = Infinity;
			const near = this.field.meshes, all = this._all;
			near.length = 0; all.length = 0;
			for ( const c of this.chunks ) {

				const d = c.box.distanceToPoint( focus );
				if ( d < FINE_IN && ! c.fine ) { pending ++; if ( d < nextD ) { nextD = d; next = c; } }
				const useFine = !! c.fine && d < FINE_OUT;
				if ( c.fine ) c.fine.visible = useFine;
				c.coarse.visible = ! useFine;
				const m = useFine ? c.fine : c.coarse;
				all.push( m );
				m.userData.rs.dist = d;
				if ( d < 75 ) near.push( m );

			}

			if ( next ) { next.fine = this._mesh( next, true ); next.fine.visible = false; pending --; this._since = 1; }
			this.pendingFine = pending + ( next ? 1 : 0 );
			near.sort( ( a, b ) => a.userData.rs.dist - b.userData.rs.dist );

		}

		this.field.budget = 1;
		this.field.prewarm();

	}

	setColumn() {}
	releaseColumn() {}
	setResolution() {}
	settle() { this.pendingFine = 1; }
	get stalled() { return 0; }
	get tileProblem() { return null; }
	groundNear( x, z, y, above = true ) { return nearRay( this.field, x, z, y, this._all, above ); }

	groundAt( x, z ) {

		return longRay( this.field, x, z, this._all );

	}

	get ready() { return this.builtCoarse >= this.chunks.length && this.pendingFine === 0; }

	get progress() {

		const n = this.chunks.length;
		if ( this.builtCoarse < n ) return { ready: false, text: `Levantando la ciudad de pruebas (${ Math.round( 100 * this.builtCoarse / n ) } %)`, pending: n - this.builtCoarse };
		if ( this.pendingFine > 0 ) return { ready: false, text: `Afinando las calles cercanas (${ this.pendingFine } trozos)`, pending: this.pendingFine };
		return { ready: true, text: 'Ciudad lista', pending: 0 };

	}

	attribution() { return ''; }
	get provider() { return ''; }
	get via() { return ''; }

	stats() {

		let fine = 0;
		for ( const c of this.chunks ) if ( c.fine && c.fine.visible ) fine ++;
		return { visibles: this.chunks.length, activas: fine, descargando: this.pendingFine, fallidas: 0, rechazadas: 0, cacheMB: 0, cercanas: this.field.meshes.length, rayos: this.field.rays, bvh: this.field.builds, bvhMs: this.field.buildMs };

	}

	async roads() { return cityRoadsOSM( this.geo ); }

	startHint() { return { x: CITY_START.x, z: CITY_START.z, yaw: Math.PI - CITY_START.compass * DEG }; }

	dispose() {

		this.scene.remove( this.group );
		for ( const c of this.chunks ) { if ( c.coarse ) c.coarse.geometry.dispose(); if ( c.fine ) c.fine.geometry.dispose(); }
		this.material.dispose();

	}

}
