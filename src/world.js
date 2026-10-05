// Ruta Sur · el mundo
// --------------------------------------------------------------------------
// Dos mundos con la misma interfaz:
//   TilesWorld  la malla fotorrealista de Google (Photorealistic 3D Tiles),
//               servida por Cesium ion o directamente por Google Maps Platform
//   TestWorld   la ciudad de pruebas, generada en el navegador
//
// Ambos ofrecen `terrain` (lo que consulta la física), `groundAt` (un rayo
// largo para ubicar el suelo al aparecer), la red vial y el texto de atribución.

import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import {
	GoogleCloudAuthPlugin, CesiumIonAuthPlugin, GLTFExtensionsPlugin, TilesFadePlugin,
	ReorientationPlugin, LoadRegionPlugin, SphereRegion, RayRegion,
} from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { MeshBVH } from 'three-mesh-bvh';
import { Geo } from './geo.js';
import { overpassQuery, buildingsQuery, OVERPASS_ENDPOINTS } from './osm.js';
import { generateCity, buildRegion, cityChunks, cityRoadsOSM, CITY_START } from './testcity.js';
import { DRACO, bytesFromBase64 } from './embebidos.js';

// Solo para los módulos usados sueltos: el archivo armado trae el decodificador adentro.
const DRACO_PATH = 'https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/gltf/';

// El decodificador Draco viaja dentro del archivo del juego. DRACOLoader pide sus dos
// partes con este método (el envoltorio de JavaScript como texto y el binario
// WebAssembly como bytes): aquí se entregan desde la memoria, sin pedido de red.
class EmbeddedDRACOLoader extends DRACOLoader {

	constructor( parts ) { super(); this._parts = parts; }

	_loadLibrary( url, responseType ) {

		// sin WebAssembly la biblioteca pide el decodificador de JavaScript puro, que no va incluido
		if ( /draco_decoder\.js$/.test( String( url ) ) ) return super._loadLibrary( DRACO_PATH + 'draco_decoder.js', responseType );
		return Promise.resolve( responseType === 'arraybuffer' ? bytesFromBase64( this._parts.wasm ).buffer : this._parts.wrapper );

	}

}

// Un solo decodificador Draco para toda la vida de la página. La librería comparte
// entre todos sus TilesRenderer la cola de decodificación; si al salir de una
// partida se terminaran los procesos del decodificador con mallas a medio decodificar,
// esas promesas quedarían sin resolver y ocuparían para siempre un cupo de la cola.
let _draco = null;
function sharedDraco() {

	if ( ! _draco ) _draco = DRACO ? new EmbeddedDRACOLoader( DRACO ) : new DRACOLoader().setDecoderPath( DRACO_PATH );
	return _draco;

}

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

const MAP_HOSTS = [ 'googleapis.com', 'cesium.com' ];
export const BLOCKED_ADVICE = 'Guarda el archivo ruta-sur.html en tu computador y ábrelo con doble clic en Chrome o Edge.';

// Renovación de la sesión de Google (ocurre sola cuando el servicio responde 4xx,
// por ejemplo al vencer la sesión tras unas horas). Dos resguardos sobre la librería:
//  - la renovación no hereda la señal de cancelación de la tesela que la gatilló;
//  - si falla, se puede volver a intentar (la librería dejaba guardada la promesa
//    rechazada y, desde ahí, ninguna tesela volvía a cargar).
// `onRenew` avisa de cada sesión nueva, que el servicio cobra como un pedido raíz.
export function hardenSession( auth, onRenew ) {

	if ( ! auth || auth._rutaSur || typeof auth.refreshToken !== 'function' ) return;
	auth._rutaSur = true;
	const original = auth.refreshToken.bind( auth );
	auth.refreshToken = options => {

		const fresh = auth._tokenRefreshPromise === null;
		const { signal, ...rest } = options || {}; // eslint-disable-line no-unused-vars
		const p = original( rest );
		if ( fresh && p && typeof p.then === 'function' ) {

			p.then( () => { if ( onRenew ) onRenew(); }, () => { if ( auth._tokenRefreshPromise === p ) auth._tokenRefreshPromise = null; } );

		}

		return p;

	};

}
const ION_GOOGLE_ASSET = 2275207; // Google Photorealistic 3D Tiles en Cesium ion
const DEG = Math.PI / 180;
const IDLE_TIME = 0.4;           // sin descargas pendientes durante este tiempo, la carga está en reposo [s]

// mirror: ancho de la textura de cada espejo [px]; mirrorBoth: los dos espejos en cada cuadro (si no, uno por cuadro)
export const QUALITY = {
	baja: { label: 'Baja', errorTarget: 30, far: 2500, pixelRatio: 1, fade: false, cacheGB: 0.6, mirror: 128, mirrorBoth: false },
	media: { label: 'Media', errorTarget: 20, far: 4000, pixelRatio: 1.5, fade: true, cacheGB: 0.8, mirror: 192, mirrorBoth: false },
	alta: { label: 'Alta', errorTarget: 13, far: 6000, pixelRatio: 2, fade: true, cacheGB: 1.2, mirror: 256, mirrorBoth: true },
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
// Región de carga alrededor del camión
// ---------------------------------------------------------------------------
// La cámara decide el detalle de lo que se ve, pero la física necesita el suelo
// con el máximo detalle bajo el camión, incluso detrás de la cabina. Esta
// región pide esas teselas aunque estén fuera de la vista.
class NearRegion extends SphereRegion {

	// con radio cero la región está apagada (una esfera de radio cero todavía toca las teselas que contienen su centro)
	intersectsTile( boundingVolume, tile, tiles ) { return this.sphere.radius > 0 && super.intersectsTile( boundingVolume, tile, tiles ); }
	calculateDistance( boundingVolume ) { return boundingVolume.distanceToPoint( this.sphere.center ); }

}

// Columna vertical: pide el máximo detalle en las teselas que cruza. El rayo
// atraviesa el planeta, así que se limita a las teselas cercanas al punto.
class ColumnRegion extends RayRegion {

	constructor( options ) {

		super( options );
		this.anchor = new THREE.Vector3();
		this.enabled = false;

	}

	intersectsTile( boundingVolume ) {

		return this.enabled && boundingVolume.intersectsRay( this.ray ) && boundingVolume.distanceToPoint( this.anchor ) < 30000;

	}

	calculateDistance() { return 0; }

}

// ---------------------------------------------------------------------------
// Mundo de teselas 3D
// ---------------------------------------------------------------------------
export class TilesWorld {

	/**
	 * credential: { type: 'ion' | 'google' | 'url', value }
	 */
	constructor( { scene, camera, renderer, credential, lat, lon, quality = QUALITY.media, onSession = null } ) {

		this.kind = 'tiles';
		this.onSession = credential.type === 'url' ? null : onSession; // aviso de cada sesión de mapa abierta
		this.scene = scene; this.camera = camera; this.renderer = renderer;
		this.credential = credential;
		this.quality = quality;
		this.geo = new Geo( lat, lon, 0 );
		this.field = new RayField();
		this.field.unlimited = true;
		this.terrain = makeTerrain( this.field );
		this.rootLoaded = false;
		this.error = null;         // error que impide continuar
		this.tileErrors = 0;
		this.tileProblem = null;   // explicación del último error de teselas, para cuando no llega malla
		this._progress = ''; this._stall = 0;
		this.dirty = true;
		this._since = 0;
		this._idle = 0; this._idleFrames = 0;
		this._focus = new THREE.Vector3();
		this._all = [];

		const tiles = this.tiles = new TilesRenderer( credential.type === 'url' ? credential.value : undefined );
		if ( credential.type === 'google' ) {

			const google = new GoogleCloudAuthPlugin( { apiToken: credential.value, autoRefreshToken: true, useRecommendedSettings: false } );
			tiles.registerPlugin( google );
			hardenSession( google.auth, () => this._session() );
			this._hardened = true;

		} else if ( credential.type === 'ion' ) {

			tiles.registerPlugin( new CesiumIonAuthPlugin( { apiToken: credential.value, assetId: ION_GOOGLE_ASSET, autoRefreshToken: true, useRecommendedSettings: false } ) );

		}

		tiles.registerPlugin( new GLTFExtensionsPlugin( { dracoLoader: sharedDraco(), metadata: false, autoDispose: false } ) );
		this.reorient = new ReorientationPlugin( { lat: lat * DEG, lon: lon * DEG, height: 0, recenter: true } );
		tiles.registerPlugin( this.reorient );
		if ( quality.fade ) tiles.registerPlugin( new TilesFadePlugin( { fadeDuration: 300 } ) );

		// regiones de carga: una columna para encontrar el suelo y una esfera que sigue al camión
		this.column = new ColumnRegion( { errorTarget: 0.1 } );
		this.near = new NearRegion( { errorTarget: 0.1 } );
		this.near.sphere.radius = 0;
		this.regions = new LoadRegionPlugin( { regions: [ this.column, this.near ] } );
		tiles.registerPlugin( this.regions );

		tiles.errorTarget = quality.errorTarget;
		tiles.autoDisableRendererCulling = false;
		tiles.lruCache.minBytesSize = quality.cacheGB * 0.75 * 2 ** 30;
		tiles.lruCache.maxBytesSize = quality.cacheGB * 2 ** 30;
		tiles.setCamera( camera );
		tiles.setResolutionFromRenderer( camera, renderer );

		// El aviso de sesión sale de este mismo evento: llega aunque la partida ya se haya
		// abandonado, y el pedido raíz se cobra igual.
		tiles.addEventListener( 'load-root-tileset', e => { if ( e.tileset ) { this.rootLoaded = true; this._session(); } } );
		tiles.addEventListener( 'load-error', e => {

			const root = ! this.rootLoaded && ( e.tile === null || e.tile === undefined );
			if ( ! root ) this.tileErrors ++;
			this._explain = () => { if ( root ) this.error = describeLoadError( e, credential ); else this.tileProblem = describeLoadError( e, credential, true ); };
			this._explain();

		} );
		// Cuando la vista bloquea el pedido, el navegador lo avisa con un evento aparte, que
		// puede llegar después del rechazo. Al llegar, el último error se explica de nuevo, ya con ese dato.
		this._onBlocked = () => { if ( this._explain && viewBlocks( ...MAP_HOSTS ) ) this._explain(); };
		blockedListeners.add( this._onBlocked );
		const mark = () => { this.dirty = true; };
		tiles.addEventListener( 'load-model', mark );
		tiles.addEventListener( 'dispose-model', mark );
		tiles.addEventListener( 'tile-visibility-change', mark );

		scene.add( tiles.group );
		this.setColumn( 0, 0 );

	}

	// La columna de carga baja por (x, z): sirve para encontrar el suelo antes de saber su altura
	setColumn( x, z ) {

		if ( ! this.rootLoaded ) { this._pendingColumn = { x, z }; return; }
		const inv = this.tiles.group.matrixWorldInverse;
		const ray = this.column.ray;
		ray.origin.set( x, 9000, z ); ray.direction.set( 0, - 1, 0 );
		ray.applyMatrix4( inv );
		this.column.anchor.set( x, 0, z ).applyMatrix4( inv );
		this.column.enabled = true;

	}

	// Al empezar a manejar, la columna ya cumplió su trabajo: dejarla encendida
	// mantiene cargado el máximo detalle en el punto de partida durante toda la partida.
	releaseColumn() { this.column.enabled = false; this._pendingColumn = null; }

	_session() { if ( this.onSession ) { try { this.onSession(); } catch ( e ) { /* el aviso no debe interrumpir la carga */ } } }

	setResolution() { this.tiles.setResolutionFromRenderer( this.camera, this.renderer ); }

	// Cámaras adicionales (los espejos): el cargador trae lo que ven, con el detalle que pide su tamaño
	addCamera( camera, width, height ) { this.tiles.setCamera( camera ); this.tiles.setResolution( camera, width, height ); }
	removeCamera( camera ) { this.tiles.deleteCamera( camera ); }

	// Tras mover el foco, la carga debe volver a quedar en reposo antes de darse por lista
	settle() { this._idle = 0; this._idleFrames = 0; }

	/**
	 * focus: posición del camión (o del punto de aparición); withSphere: activa la región cercana
	 */
	update( focus, dt, withSphere = true ) {

		const tiles = this.tiles;
		this._focus.copy( focus );
		if ( ! this._hardened ) {

			// con Cesium ion, la librería registra el complemento de Google cuando llega la dirección del servicio
			const google = tiles.getPluginByName( 'GOOGLE_CLOUD_AUTH_PLUGIN' );
			if ( google ) { hardenSession( google.auth, () => this._session() ); this._hardened = true; }

		}

		if ( this.rootLoaded ) {

			const inv = tiles.group.matrixWorldInverse;
			if ( this._pendingColumn ) { const p = this._pendingColumn; this._pendingColumn = null; this.setColumn( p.x, p.z ); }
			if ( withSphere ) {

				this.near.sphere.center.copy( focus ).applyMatrix4( inv );
				this.near.sphere.radius = 70;

			} else this.near.sphere.radius = 0;

		}

		this.camera.updateMatrixWorld();
		tiles.update();

		// candidatas para los rayos de la física
		this._since += dt;
		if ( this.dirty || this._since > 0.25 ) {

			this.refresh( focus, 75 );
			this.dirty = false; this._since = 0;

		}

		this.field.budget = 1;
		this.field.prewarm();

		const s = tiles.stats;
		const pending = s.downloading + s.parsing + s.queued;
		const quiet = pending === 0 && this.rootLoaded;
		this._idle = quiet ? this._idle + dt : 0;
		this._idleFrames = quiet ? this._idleFrames + 1 : 0;

		// descarga detenida: hay pedidos pendientes y nada cambia
		const key = `${ s.downloading }|${ s.parsing }|${ s.queued }|${ s.loaded }|${ s.failed }|${ this.rootLoaded }`;
		if ( key !== this._progress || ( pending === 0 && this.rootLoaded ) ) { this._progress = key; this._stall = 0; } else this._stall += dt;

	}

	// Segundos sin avance con la carga a medias
	get stalled() { return this._stall; }

	refresh( focus, radius ) {

		const near = this.field.meshes, all = this._all;
		near.length = 0; all.length = 0;
		this.tiles.activeTiles.forEach( tile => {

			const scene = tile.engineData && tile.engineData.scene;
			if ( ! scene ) return;
			scene.traverse( o => {

				if ( ! o.isMesh || ! o.geometry ) return;
				const d = RayField.prepare( o );
				all.push( o );
				d.dist = d.box.distanceToPoint( focus );
				if ( d.dist < radius ) near.push( o );

			} );

		} );
		near.sort( ( a, b ) => a.userData.rs.dist - b.userData.rs.dist );

	}

	// Rayo largo hacia abajo contra todas las teselas activas
	groundAt( x, z ) {

		if ( this.dirty ) { this.refresh( this._focus, 75 ); this.dirty = false; }
		return longRay( this.field, x, z, this._all );

	}

	/**
	 * Suelo más cercano a la altura y: primero hacia abajo desde un poco más arriba
	 * del camión y, si no hay nada, desde lo alto. A diferencia de groundAt, bajo un
	 * puente devuelve la calzada y no el tablero. Devuelve la altura o null.
	 */
	groundNear( x, z, y, above = true ) {

		if ( this.dirty ) { this.refresh( this._focus, 75 ); this.dirty = false; }
		return nearRay( this.field, x, z, y, this._all, above );

	}

	// En reposo: sin pedidos pendientes durante un rato y durante varios cuadros seguidos
	// (con pocos cuadros por segundo, un solo cuadro largo no basta para darlo por cierto).
	get settled() { return this._idle > IDLE_TIME && this._idleFrames >= 3; }
	get ready() { return this.rootLoaded && this.settled; }

	get progress() {

		const s = this.tiles.stats;
		const pending = s.downloading + s.parsing + s.queued;
		if ( this.error ) return { ready: false, text: this.error, pending };
		if ( ! this.rootLoaded ) return { ready: false, text: 'Conectando con el servicio de mapas', pending };
		if ( pending > 0 ) return { ready: false, text: `Descargando la ciudad (${ pending } teselas en camino)`, pending };
		return { ready: this.settled, text: 'Mapa cargado', pending: 0 };

	}

	attribution() {

		const list = this.tiles.getAttributions();
		const parts = [];
		for ( const a of list ) if ( a.type === 'string' && a.value ) parts.push( a.value );
		return parts.join( '; ' );

	}

	get provider() { return this.credential.type === 'url' ? '' : 'Google Maps'; }
	get via() { return this.credential.type === 'ion' ? 'Cesium ion' : ''; }

	stats() {

		const s = this.tiles.stats;
		return {
			visibles: s.visible, activas: s.active, descargando: s.downloading + s.parsing + s.queued, fallidas: s.failed, rechazadas: s.refused || 0,
			cacheMB: Math.round( this.tiles.lruCache.cachedBytes / 2 ** 20 ),
			cercanas: this.field.meshes.length, rayos: this.field.rays, bvh: this.field.builds, bvhMs: this.field.buildMs,
		};

	}

	async roads() { return fetchRoads( this.geo.lat0, this.geo.lon0, 2500 ); }

	startHint() { return { x: 0, z: 0, yaw: Math.PI }; }

	dispose() {

		this.scene.remove( this.tiles.group );
		this.tiles.dispose();
		blockedListeners.delete( this._onBlocked );
		this._explain = null;
		// el decodificador Draco es compartido y sigue vivo: ver sharedDraco

	}

}

// Explica un error de carga. `tile` indica que el mapa abrió y lo que falla son las teselas.
export function describeLoadError( e, credential, tile = false ) {

	const msg = String( ( e.error && e.error.message ) || e.error || '' );
	const code = ( msg.match( /\b(4\d\d|5\d\d)\b/ ) || [] )[ 1 ];
	const lead = tile ? 'El mapa abrió, pero las teselas no llegan. ' : '';
	if ( credential.type === 'ion' && ! tile ) {

		if ( code === '401' ) return 'Cesium ion rechazó el token (401). Revisa que esté copiado completo y que siga activo.';
		if ( code === '404' ) return 'El token es válido, pero la cuenta no tiene el recurso "Google Photorealistic 3D Tiles" (404). Agrégalo desde Asset Depot en Cesium ion.';
		if ( code === '403' || code === '429' ) return `Cesium ion no permitió la descarga (${ code }). Puede ser el límite mensual de la cuenta gratuita.`;

	} else if ( credential.type !== 'url' ) {

		if ( code === '400' ) return lead + 'Google no reconoce la clave (400). Revisa que esté copiada completa.';
		if ( code === '403' ) return lead + 'Google rechazó la clave (403). Revisa que la Map Tiles API esté habilitada, que el proyecto tenga facturación activa y que la clave no esté restringida a otro sitio.';
		if ( code === '429' ) return lead + 'Se alcanzó la cuota de la Map Tiles API (429).';

	}

	if ( code ) return `${ lead }${ tile ? 'El servicio respondió' : 'No se pudo abrir el mapa: el servicio respondió' } ${ code }.${ code[ 0 ] === '5' ? ' Suele ser pasajero: vuelve a intentar en unos minutos.' : '' }`;
	// Sin código y con pedidos bloqueados por la vista: el pedido nunca salió del navegador.
	if ( credential.type !== 'url' && viewBlocks( ...MAP_HOSTS ) ) return `La vista donde está abierto el juego bloquea la conexión con el servicio de mapas. ${ BLOCKED_ADVICE } La ciudad de pruebas funciona en esta vista.`;
	// Sin código: el navegador no pudo leer la respuesta (sin conexión, o un rechazo
	// que llega sin permiso de lectura entre orígenes) o la respuesta no era la esperada.
	if ( msg ) console.warn( 'Ruta Sur · error de carga del mapa:', msg );
	const framed = EMBEDDED && credential.type !== 'url' ? ` Si el juego está abierto dentro de otra aplicación, esa vista puede bloquear la conexión: ${ BLOCKED_ADVICE.charAt( 0 ).toLowerCase() }${ BLOCKED_ADVICE.slice( 1 ) }` : '';
	return `${ lead }${ tile ? 'No' : 'No se pudo abrir el mapa: no' } hubo una respuesta legible del servicio. Revisa la conexión a internet y la credencial${ credential.type === 'google' ? ', y que la Map Tiles API esté habilitada' : '' }.${ framed }`;

}

// ---------------------------------------------------------------------------
// Ciudad de pruebas
// ---------------------------------------------------------------------------
// Imita el comportamiento de las teselas: cada trozo de ciudad tiene una
// versión gruesa, que se ve de lejos y queda 25 cm más arriba (el error típico
// de un nivel de detalle bajo), y una fina que se construye al acercarse.
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
