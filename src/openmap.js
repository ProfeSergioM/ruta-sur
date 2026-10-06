// Ruta Sur · mapa abierto
// --------------------------------------------------------------------------
// Una ciudad levantada desde OpenStreetMap: las calles como franjas de asfalto
// con vereda, los edificios como prismas de colores extruidos desde su planta
// (con la altura que OSM declare o una típica de su tipo), las plazas, parques y
// aguas como manchas en el suelo, y los árboles mapeados uno por uno. La
// ambientación se completa con árboles de vereda y faroles generados a lo largo
// de las calles, y con una línea de cerros brumosos en el horizonte, decorativa.
// No hay fotografía ni relieve: el suelo es plano.
//
// El módulo es puro (no depende de Three.js): recibe las respuestas de Overpass
// ya convertidas a coordenadas del juego y entrega mallas por trozos, en el
// mismo formato que la ciudad de pruebas. Ejes: +X oeste, +Y arriba, +Z norte.

import { ROAD_CLASSES, buildingHeight, featureKind } from './osm.js';
import { MeshBuilder, valueNoise } from './testcity.js';
import { utilityPole, parkedCar, busStop, bench, bin, roadSign, trafficLight, SIGNS, CAR_COLORS } from './furniture.js';

export const OPEN = {
	chunk: 120,          // lado de cada trozo de malla [m]
	buildRadius: 420,    // se construyen los trozos a esta distancia del foco [m]
	readyRadius: 260,    // la carga está lista cuando estos trozos existen [m]
	showRadius: 700,     // los trozos más lejos se ocultan [m]
	dropRadius: 1400,    // y más lejos aún se liberan [m]
	nearRadius: 75,      // trozos que responden los rayos de la física [m]
	groundExtent: 8000,  // el suelo plano llega hasta aquí [m]
	buildingsRadius: 1500, // radio de la consulta de edificios [m]
	roadsRadius: 2500,   // radio de la consulta de calles [m]
};

// Ancho total de la calzada por clase de vía [m]; las veredas van aparte
export const ROAD_WIDTH = {
	motorway: 11, trunk: 11, primary: 10, secondary: 9, tertiary: 8, unclassified: 7, residential: 7, living_street: 5,
	motorway_link: 5.5, trunk_link: 5.5, primary_link: 5.5, secondary_link: 5, tertiary_link: 5,
};
const SIDEWALK = 1.6; // ancho de vereda a cada lado [m]

const COLORS = {
	road: [ 0.25, 0.25, 0.27 ], sidewalk: [ 0.6, 0.59, 0.57 ], line: [ 0.8, 0.78, 0.64 ],
	ground: [ 0.46, 0.49, 0.36 ], green: [ 0.34, 0.5, 0.27 ], water: [ 0.3, 0.45, 0.58 ],
	trunk: [ 0.3, 0.24, 0.18 ], leaf: [ [ 0.24, 0.38, 0.2 ], [ 0.3, 0.44, 0.22 ], [ 0.2, 0.34, 0.19 ] ],
	post: [ 0.42, 0.44, 0.46 ], lamp: [ 0.95, 0.9, 0.7 ], hill: [ 0.5, 0.58, 0.6 ], hillLow: [ 0.45, 0.52, 0.42 ],
};
export const WINDOW_METERS = { u: 4, v: 3.2 };  // una celda de la textura de fachada: 4 m de ancho por un piso de alto
export const GROUND_METERS = 18;                // la textura de pasto se repite cada tantos metros
const TREE_SPACING = 16, LAMP_SPACING = 34;     // separación de los árboles de vereda y de los faroles [m]
const POLE_SPACING = 28, PARK_SPACING = 7.5, STOP_SPACING = 110, SIGN_SPACING = 150; // postes, autos estacionados, paraderos y señales de velocidad [m]
const MAJOR = 8;                                // desde este ancho de calzada una vía es principal: faroles, estacionados, paraderos, semáforos [m]
const PALETTE = [ [ 0.72, 0.69, 0.63 ], [ 0.62, 0.6, 0.58 ], [ 0.75, 0.72, 0.7 ], [ 0.58, 0.52, 0.46 ], [ 0.66, 0.68, 0.7 ], [ 0.7, 0.62, 0.55 ], [ 0.52, 0.55, 0.58 ], [ 0.74, 0.66, 0.58 ], [ 0.6, 0.64, 0.6 ] ];
// la luz viene del mismo lado que el sol del juego (-0.5, 1, 0.35)
const LX = - 0.5 / Math.hypot( 0.5, 0.35 ), LZ = 0.35 / Math.hypot( 0.5, 0.35 );

// Número determinista en [0, 1) a partir de un identificador
export function hashId( id ) {

	let h = ( id | 0 ) ^ 0x9e3779b9;
	h = Math.imul( h ^ ( h >>> 16 ), 0x45d9f3b );
	h = Math.imul( h ^ ( h >>> 13 ), 0x45d9f3b );
	h ^= h >>> 16;
	return ( h >>> 0 ) / 4294967296;

}

// Área con signo de un polígono en planta (x, z)
export function signedArea( poly ) {

	let a = 0;
	for ( let i = 0, n = poly.length; i < n; i ++ ) {

		const p = poly[ i ], q = poly[ ( i + 1 ) % n ];
		a += p.x * q.z - q.x * p.z;

	}

	return a / 2;

}

function pointInTriangle( p, a, b, c ) {

	const s1 = ( b.x - a.x ) * ( p.z - a.z ) - ( b.z - a.z ) * ( p.x - a.x );
	const s2 = ( c.x - b.x ) * ( p.z - b.z ) - ( c.z - b.z ) * ( p.x - b.x );
	const s3 = ( a.x - c.x ) * ( p.z - c.z ) - ( a.z - c.z ) * ( p.x - c.x );
	return ( s1 >= 0 && s2 >= 0 && s3 >= 0 ) || ( s1 <= 0 && s2 <= 0 && s3 <= 0 );

}

/**
 * Triangulación de un polígono simple por recorte de orejas. Devuelve índices
 * de a tres, con la orientación del polígono recibido. Si el polígono se cruza
 * a sí mismo y no quedan orejas, el resto se cierra en abanico.
 */
export function triangulate( poly ) {

	const n = poly.length, out = [];
	if ( n < 3 ) return out;
	const sign = Math.sign( signedArea( poly ) ) || 1;
	const idx = [];
	for ( let i = 0; i < n; i ++ ) idx.push( i );
	let guard = 0;
	while ( idx.length > 3 && guard < 2 * n * n ) {

		let found = false;
		for ( let k = 0; k < idx.length; k ++ ) {

			guard ++;
			const i0 = idx[ ( k + idx.length - 1 ) % idx.length ], i1 = idx[ k ], i2 = idx[ ( k + 1 ) % idx.length ];
			const a = poly[ i0 ], b = poly[ i1 ], c = poly[ i2 ];
			// convexa en el sentido del polígono
			const cross = ( b.x - a.x ) * ( c.z - a.z ) - ( b.z - a.z ) * ( c.x - a.x );
			if ( cross * sign <= 1e-9 ) continue;
			let empty = true;
			for ( const j of idx ) {

				if ( j === i0 || j === i1 || j === i2 ) continue;
				if ( pointInTriangle( poly[ j ], a, b, c ) ) { empty = false; break; }

			}

			if ( ! empty ) continue;
			out.push( i0, i1, i2 );
			idx.splice( k, 1 );
			found = true;
			break;

		}

		if ( ! found ) {

			// sin orejas: polígono degenerado o que se cruza; abanico con lo que queda
			for ( let k = 1; k < idx.length - 1; k ++ ) out.push( idx[ 0 ], idx[ k ], idx[ k + 1 ] );
			return out;

		}

	}

	if ( idx.length === 3 ) out.push( idx[ 0 ], idx[ 1 ], idx[ 2 ] );
	return out;

}

// Prisma vertical sobre un polígono en planta: paredes sombreadas según su orientación y
// techo plano. Con `windows`, las paredes llevan coordenadas de textura en celdas de
// WINDOW_METERS (u a lo largo de la pared, v hacia arriba desde el suelo), para la fachada.
export function prism( mb, poly, y0, y1, col, roofShade = 0.8, windows = false ) {

	// la misma orientación que las cajas de la ciudad de pruebas: área positiva
	const pts = signedArea( poly ) < 0 ? poly.slice().reverse() : poly;
	const n = pts.length;
	const vTop = windows ? ( y1 - 0 ) / WINDOW_METERS.v : 0, vBot = windows ? ( y0 - 0 ) / WINDOW_METERS.v : 0;
	for ( let k = 0; k < n; k ++ ) {

		const a = pts[ k ], b = pts[ ( k + 1 ) % n ];
		const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot( dx, dz );
		if ( len < 1e-6 ) continue;
		// normal exterior de la pared, con la orientación de las cajas
		const nx = dz / len, nz = - dx / len;
		const shade = 0.68 + 0.3 * ( 0.5 + 0.5 * ( nx * LX + nz * LZ ) );
		// las celdas de ventana se cuentan desde la esquina y se redondean para que ninguna quede cortada
		const uEnd = windows ? Math.max( 1, Math.round( len / WINDOW_METERS.u ) ) : 0;
		const v0 = mb.vertex( a.x, y0, a.z, col, shade * 0.9, 0, vBot ), v1 = mb.vertex( b.x, y0, b.z, col, shade * 0.9, uEnd, vBot );
		const v2 = mb.vertex( b.x, y1, b.z, col, shade, uEnd, vTop ), v3 = mb.vertex( a.x, y1, a.z, col, shade, 0, vTop );
		mb.quad( v0, v3, v2, v1 );

	}

	// el techo apunta al rincón de la textura, que es pared lisa
	const top = pts.map( p => mb.vertex( p.x, y1, p.z, col, roofShade, 0.02, 0.02 ) );
	const tris = triangulate( pts );
	// el techo mira hacia arriba con el orden inverso al de las paredes
	for ( let i = 0; i < tris.length; i += 3 ) mb.tri( top[ tris[ i ] ], top[ tris[ i + 2 ] ], top[ tris[ i + 1 ] ] );

}

export const TEXTURE_METERS = 6; // la textura de las calles se repite cada tantos metros a lo largo

// Franja plana a lo largo de una polilínea, con discos en los vértices interiores para
// cerrar los codos. Coordenadas de textura: u cruza la franja de 0 a 1 y v avanza en
// metros a lo largo, dividido por TEXTURE_METERS, así la textura no se estira.
function strip( mb, pts, width, y, col, v0 = 0 ) {

	const w = width / 2;
	let along = v0;
	for ( let i = 0; i < pts.length - 1; i ++ ) {

		const p = pts[ i ], q = pts[ i + 1 ];
		const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot( dx, dz );
		if ( len < 1e-6 ) continue;
		const nx = - dz / len * w, nz = dx / len * w;
		const va = along / TEXTURE_METERS, vb = ( along + len ) / TEXTURE_METERS;
		const a = mb.vertex( p.x + nx, y, p.z + nz, col, 1, 0, va ), b = mb.vertex( q.x + nx, y, q.z + nz, col, 1, 0, vb );
		const c = mb.vertex( q.x - nx, y, q.z - nz, col, 1, 1, vb ), d = mb.vertex( p.x - nx, y, p.z - nz, col, 1, 1, va );
		// mira hacia arriba (el orden importa: la cara de atrás no se dibuja)
		mb.quad( a, b, c, d );
		if ( i > 0 && w > 0.4 ) {

			const center = mb.vertex( p.x, y, p.z, col, 1, 0.5, va ), ring = [];
			for ( let k = 0; k < 8; k ++ ) { const th = Math.PI * 2 * k / 8; ring.push( mb.vertex( p.x + Math.cos( th ) * w, y, p.z + Math.sin( th ) * w, col, 1, 0.5 + 0.5 * Math.cos( th ), va + 0.5 * Math.sin( th ) * w / TEXTURE_METERS ) ); }
			for ( let k = 0; k < 8; k ++ ) mb.tri( center, ring[ ( k + 1 ) % 8 ], ring[ k ] );

		}

		along += len;

	}

}

// Mancha plana sobre un polígono (plaza, parque, agua), mirando hacia arriba
function patch( mb, poly, y, col ) {

	const pts = signedArea( poly ) < 0 ? poly.slice().reverse() : poly;
	const idx = pts.map( p => mb.vertex( p.x, y, p.z, col, 0.95 + 0.1 * valueNoise( p.x, p.z, 30 ), p.x / GROUND_METERS, p.z / GROUND_METERS ) );
	const tris = triangulate( pts );
	for ( let i = 0; i < tris.length; i += 3 ) mb.tri( idx[ tris[ i ] ], idx[ tris[ i + 2 ] ], idx[ tris[ i + 1 ] ] );

}

// Árbol: tronco y copa, con la altura y el verde que diga la semilla
export function tree( mb, x, z, seed, solid = mb ) {

	const h = 5 + 5 * hashId( seed ), r = 1.6 + 1.8 * hashId( seed + 11 );
	const leaf = COLORS.leaf[ Math.floor( hashId( seed + 23 ) * COLORS.leaf.length ) ];
	solid.frustum( x, z, - 0.1, 0.5, 0.5, h * 0.5, 0.1, COLORS.trunk ); // el tronco choca; la copa no
	mb.blob( x, h * 0.72, z, r, h * 0.38, leaf );

}

// Farol: poste y brazo hacia la calle en `mb`; la lámpara en `glow` (de noche se enciende) y,
// en `pool`, un disco de luz sobre la calzada que se dibuja sumando (claro al centro, nada al borde)
export function lamp( mb, glow, pool, x, z, towardX, towardZ, solid = mb ) {

	const H = 8;
	solid.box( x - 0.09, x + 0.09, z - 0.09, z + 0.09, 0, H, COLORS.post ); // el poste choca; el brazo no
	const ax = x + towardX * 0.8, az = z + towardZ * 0.8;
	mb.box( Math.min( x, ax ) - 0.05, Math.max( x, ax ) + 0.05, Math.min( z, az ) - 0.05, Math.max( z, az ) + 0.05, H - 0.1, H, COLORS.post );
	glow.box( ax - 0.3, ax + 0.3, az - 0.3, az + 0.3, H - 0.3, H, COLORS.lamp, 1 );
	const px = x + towardX * 3.2, pz = z + towardZ * 3.2, R = 7;
	const center = pool.vertex( px, 0.04, pz, COLORS.lamp, 1 ), ring = [];
	for ( let k = 0; k < 12; k ++ ) { const th = Math.PI * 2 * k / 12; ring.push( pool.vertex( px + Math.cos( th ) * R, 0.04, pz + Math.sin( th ) * R, COLORS.lamp, 0 ) ); }
	for ( let k = 0; k < 12; k ++ ) pool.tri( center, ring[ ( k + 1 ) % 12 ], ring[ k ] );

}

function inside( x, z, poly ) {

	let c = false;
	for ( let i = 0, j = poly.length - 1; i < poly.length; j = i ++ ) {

		const a = poly[ i ], b = poly[ j ];
		if ( ( a.z > z ) !== ( b.z > z ) && x < ( b.x - a.x ) * ( z - a.z ) / ( b.z - a.z ) + a.x ) c = ! c;

	}

	return c;

}

function distToSegment( x, z, p, q ) {

	const ex = q.x - p.x, ez = q.z - p.z, l2 = ex * ex + ez * ez;
	const t = l2 > 0 ? Math.max( 0, Math.min( 1, ( ( x - p.x ) * ex + ( z - p.z ) * ez ) / l2 ) ) : 0;
	return Math.hypot( x - ( p.x + ex * t ), z - ( p.z + ez * t ) );

}

/**
 * Convierte las respuestas de Overpass (calles, edificios y ambientación) a la ciudad
 * del juego: vías con sus puntos en planta y ancho, edificios con su planta, altura y
 * color, manchas verdes y de agua, y árboles mapeados.
 */
export function openCity( roads, buildings, geo ) {

	const g = { x: 0, y: 0, z: 0 };
	const pt = p => { geo.toWorld( p.lat, p.lon, 0, g ); return { x: g.x, z: g.z }; };
	const ways = [];
	for ( const e of ( roads && roads.elements ) || [] ) {

		const width = e.tags && ROAD_WIDTH[ e.tags.highway ];
		if ( ! width || ! Array.isArray( e.geometry ) ) continue;
		const pts = e.geometry.filter( Boolean ).map( pt );
		if ( pts.length < 2 ) continue;
		const cls = ROAD_CLASSES[ e.tags.highway ];
		// distancia acumulada hasta cada punto, para que la textura siga de un tramo al otro
		const along = [ 0 ];
		for ( let i = 1; i < pts.length; i ++ ) along.push( along[ i - 1 ] + Math.hypot( pts[ i ].x - pts[ i - 1 ].x, pts[ i ].z - pts[ i - 1 ].z ) );
		ways.push( { id: e.id, pts, along, width, line: ! e.tags.oneway && cls && cls.rank <= 6 && width >= 7 } );

	}

	const list = [], greens = [], trees = [];
	for ( const e of ( buildings && buildings.elements ) || [] ) {

		const kind = featureKind( e.tags || {} );
		if ( kind === 'tree' ) {

			if ( typeof e.lat === 'number' ) { const q = pt( e ); trees.push( { id: e.id, x: q.x, z: q.z } ); }
			continue;

		}

		if ( ! Array.isArray( e.geometry ) ) continue;
		const poly = [];
		for ( const p of e.geometry ) {

			if ( ! p ) continue;
			const q = pt( p ), last = poly[ poly.length - 1 ];
			if ( last && Math.hypot( q.x - last.x, q.z - last.z ) < 0.05 ) continue;
			poly.push( q );

		}

		if ( poly.length > 1 && Math.hypot( poly[ 0 ].x - poly[ poly.length - 1 ].x, poly[ 0 ].z - poly[ poly.length - 1 ].z ) < 0.05 ) poly.pop();
		if ( poly.length < 3 || Math.abs( signedArea( poly ) ) < 2 ) continue;
		let cx = 0, cz = 0, bx0 = Infinity, bx1 = - Infinity, bz0 = Infinity, bz1 = - Infinity;
		for ( const p of poly ) { cx += p.x; cz += p.z; bx0 = Math.min( bx0, p.x ); bx1 = Math.max( bx1, p.x ); bz0 = Math.min( bz0, p.z ); bz1 = Math.max( bz1, p.z ); }
		cx /= poly.length; cz /= poly.length;
		if ( kind === 'green' || kind === 'water' ) {

			const t = e.tags || {};
			const wooded = kind === 'green' && ( t.natural === 'wood' || t.landuse === 'forest' || t.natural === 'scrub' );
			greens.push( { id: e.id, poly, kind, wooded, cx, cz, x0: bx0, x1: bx1, z0: bz0, z1: bz1 } );
			continue;

		}

		const r = hashId( e.id );
		list.push( { id: e.id, poly, cx, cz, h: buildingHeight( e.tags, r ), color: PALETTE[ Math.floor( hashId( e.id + 7 ) * PALETTE.length ) ], tags: e.tags || {} } );

	}

	return { ways, buildings: list, greens, trees, crossings: findCrossings( ways ), chunk: OPEN.chunk, index: null };

}

// Cruces: puntos que comparten dos vías o más (o donde una vía toca el interior de otra).
// Cada cruce guarda sus aproximaciones: hacia dónde sale cada vía y con qué ancho.
export function findCrossings( ways ) {

	const at = new Map();
	const key = p => `${ Math.round( p.x * 5 ) },${ Math.round( p.z * 5 ) }`; // a 20 cm
	ways.forEach( ( w, wi ) => w.pts.forEach( ( p, k ) => {

		const kk = key( p );
		let c = at.get( kk );
		if ( ! c ) at.set( kk, c = { x: p.x, z: p.z, ways: new Set(), approaches: [] } );
		c.ways.add( wi );
		for ( const q of [ w.pts[ k - 1 ], w.pts[ k + 1 ] ] ) {

			if ( ! q ) continue;
			const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot( dx, dz );
			if ( len < 1e-6 ) continue;
			c.approaches.push( { wi, width: w.width, ux: dx / len, uz: dz / len } );

		}

	} ) );
	const out = [];
	// dos vías que solo se continúan (cambia el nombre) tienen dos aproximaciones: no es un cruce
	for ( const c of at.values() ) if ( c.ways.size >= 2 && c.approaches.length >= 3 ) out.push( { x: c.x, z: c.z, ways: [ ...c.ways ], approaches: c.approaches } );
	return out;

}

const key = ( i, j ) => `${ i },${ j }`;
export const chunkOf = ( v, size = OPEN.chunk ) => Math.floor( v / size );

// Índice por trozo: qué tramos de vía, edificios, manchas y árboles dibuja cada uno. Un
// tramo y una mancha van en todos los trozos que toca su caja; un edificio y un árbol,
// en el de su centro.
export function chunkIndex( city, size = OPEN.chunk ) {

	const map = new Map();
	const get = ( i, j ) => { const k = key( i, j ); let c = map.get( k ); if ( ! c ) { c = { segments: [], buildings: [], greens: [], trees: [], crossings: [] }; map.set( k, c ); } return c; };
	city.ways.forEach( ( w, wi ) => {

		for ( let s = 0; s < w.pts.length - 1; s ++ ) {

			const p = w.pts[ s ], q = w.pts[ s + 1 ], m = w.width / 2 + SIDEWALK;
			const i0 = chunkOf( Math.min( p.x, q.x ) - m, size ), i1 = chunkOf( Math.max( p.x, q.x ) + m, size );
			const j0 = chunkOf( Math.min( p.z, q.z ) - m, size ), j1 = chunkOf( Math.max( p.z, q.z ) + m, size );
			for ( let i = i0; i <= i1; i ++ ) for ( let j = j0; j <= j1; j ++ ) get( i, j ).segments.push( wi, s );

		}

	} );
	city.buildings.forEach( ( b, bi ) => get( chunkOf( b.cx, size ), chunkOf( b.cz, size ) ).buildings.push( bi ) );
	( city.greens || [] ).forEach( ( g, gi ) => {

		for ( let i = chunkOf( g.x0, size ); i <= chunkOf( g.x1, size ); i ++ ) for ( let j = chunkOf( g.z0, size ); j <= chunkOf( g.z1, size ); j ++ ) get( i, j ).greens.push( gi );

	} );
	( city.trees || [] ).forEach( ( t, ti ) => get( chunkOf( t.x, size ), chunkOf( t.z, size ) ).trees.push( ti ) );
	( city.crossings || [] ).forEach( ( c, ci ) => get( chunkOf( c.x, size ), chunkOf( c.z, size ) ).crossings.push( ci ) );
	city.index = map; city.chunk = size;
	return map;

}

/**
 * Mallas del trozo (i, j), en capas que el mundo dibuja con desplazamiento de polígono
 * creciente, para que el orden no dependa de la precisión del búfer de profundidad:
 * suelo, manchas (plazas y agua), veredas, calzadas y líneas centrales. Aparte van los
 * edificios (con su textura de fachada), la decoración (copas, brazos y techos) y lo sólido
 * (troncos, postes, estacionados, paraderos, bancas). Las capas planas van a milímetros una
 * de otra; de lejos, sin el desplazamiento, se mezclarían. El suelo, los edificios y lo
 * sólido responden los rayos de la física.
 */
export function buildOpenChunk( city, i, j ) {

	const size = city.chunk, x0 = i * size, z0 = j * size, x1 = x0 + size, z1 = z0 + size;
	const mb = new MeshBuilder(), walk = new MeshBuilder(), road = new MeshBuilder(), line = new MeshBuilder();
	const bld = new MeshBuilder(), park = new MeshBuilder(), decor = new MeshBuilder(), glow = new MeshBuilder(), pool = new MeshBuilder();
	const solid = new MeshBuilder(), sign = new MeshBuilder();
	const entry = ( city.index || chunkIndex( city, size ) ).get( key( i, j ) ) || { segments: [], buildings: [], greens: [], trees: [], crossings: [] };
	const objects = [];                 // { kind, x, z } de cada pieza puesta, para las pruebas y el minimapa
	const counts = { poles: 0, parked: 0, stops: 0, signs: 0, lights: 0, benches: 0 };
	const signalLamps = [];             // { key, group, lamp, v0, v1 }: lámparas de semáforo en la capa glow, por cruce y grupo
	const within = ( x, z ) => x >= x0 && x < x1 && z >= z0 && z < z1;

	// suelo: una grilla chica con un leve moteado y la textura de pasto en metros del mundo
	const G = 4;
	for ( let b = 0; b <= G; b ++ ) for ( let a = 0; a <= G; a ++ ) {

		const x = x0 + size * a / G, z = z0 + size * b / G, n = 0.88 + 0.24 * valueNoise( x, z, 23 );
		mb.vertex( x, 0, z, [ COLORS.ground[ 0 ] * n, COLORS.ground[ 1 ] * n, COLORS.ground[ 2 ] * n ], 1, x / GROUND_METERS, z / GROUND_METERS );

	}

	for ( let b = 0; b < G; b ++ ) for ( let a = 0; a < G; a ++ ) {

		const v = b * ( G + 1 ) + a;
		mb.quad( v, v + G + 1, v + G + 2, v + 1 );

	}

	// calles: la vereda debajo, la calzada encima y la línea sobre la calzada
	const segs = entry.segments;
	for ( let s = 0; s < segs.length; s += 2 ) {

		const w = city.ways[ segs[ s ] ], k = segs[ s + 1 ], pts = [ w.pts[ k ], w.pts[ k + 1 ] ];
		const v0 = w.along ? w.along[ k ] : 0;
		strip( walk, pts, w.width + 2 * SIDEWALK, 0.01, COLORS.sidewalk, v0 );
		strip( road, pts, w.width, 0.02, COLORS.road, v0 );
		if ( w.line ) strip( line, pts, 0.22, 0.03, COLORS.line, v0 );

	}

	const buildings = entry.buildings.map( bi => city.buildings[ bi ] );
	for ( const b of buildings ) prism( bld, b.poly, - 0.5, b.h, b.color, 0.8, true );

	// plazas, parques y agua
	const greens = ( entry.greens || [] ).map( gi => city.greens[ gi ] );
	for ( const g of greens ) patch( park, g.poly, g.kind === 'water' ? 0.004 : 0.006, g.kind === 'water' ? COLORS.water : COLORS.green );

	// árboles: los mapeados, los de los parques y bosques, y los de vereda a lo largo de las calles
	let count = 0;
	const MAX_TREES = 160;
	const free = ( x, z ) => {

		if ( ! within( x, z ) ) return false;
		for ( const b of buildings ) if ( inside( x, z, b.poly ) ) return false;
		for ( const g of greens ) if ( g.kind === 'water' && inside( x, z, g.poly ) ) return false;
		return true;

	};

	const plant = ( x, z, seed ) => { if ( count < MAX_TREES && free( x, z ) ) { tree( decor, x, z, seed, solid ); count ++; objects.push( { kind: 'arbol', x, z } ); } };
	for ( const ti of entry.trees || [] ) { const t = city.trees[ ti ]; plant( t.x, t.z, t.id ); }
	for ( const g of greens ) {

		if ( g.kind === 'water' ) continue;
		const step = g.wooded ? 11 : 24;
		for ( let x = Math.ceil( Math.max( g.x0, x0 ) / step ) * step; x <= Math.min( g.x1, x1 ); x += step ) for ( let z = Math.ceil( Math.max( g.z0, z0 ) / step ) * step; z <= Math.min( g.z1, z1 ); z += step ) {

			const seed = g.id * 31 + Math.round( x ) * 7 + Math.round( z );
			if ( ! g.wooded && hashId( seed + 5 ) < 0.45 ) continue;
			const px = x + ( hashId( seed ) - 0.5 ) * step * 0.6, pz = z + ( hashId( seed + 1 ) - 0.5 ) * step * 0.6;
			if ( inside( px, pz, g.poly ) ) plant( px, pz, seed );

		}

		// bancas y un basurero en las plazas (no en los bosques)
		if ( g.wooded || Math.abs( signedArea( g.poly ) ) < 300 ) continue;
		for ( let b = 0; b < 3; b ++ ) {

			const seed = g.id * 17 + b * 101, th = hashId( seed ) * Math.PI * 2, r = 4 + 5 * hashId( seed + 1 );
			const x = g.cx + Math.cos( th ) * r, z = g.cz + Math.sin( th ) * r;
			if ( ! inside( x, z, g.poly ) || ! free( x, z ) ) continue;
			bench( solid, x, z, th + Math.PI / 2 ); counts.benches ++; objects.push( { kind: 'banca', x, z } );
			if ( b === 0 ) { const bx = x + Math.cos( th ) * 1.6, bz = z + Math.sin( th ) * 1.6; if ( inside( bx, bz, g.poly ) ) { bin( solid, bx, bz, th ); objects.push( { kind: 'basurero', x: bx, z: bz } ); } }

		}

	}

	// árboles de vereda y faroles, a intervalos fijos a lo largo de cada vía (la fase sale de la
	// distancia acumulada, así siguen parejos de un tramo al siguiente y de un trozo al otro)
	const lampsOf = [];
	const nearOtherRoad = ( x, z, wi ) => {

		for ( let s = 0; s < segs.length; s += 2 ) {

			if ( segs[ s ] === wi ) continue;
			const o = city.ways[ segs[ s ] ], k = segs[ s + 1 ];
			if ( distToSegment( x, z, o.pts[ k ], o.pts[ k + 1 ] ) < o.width / 2 + SIDEWALK + 1.5 ) return true;

		}

		return false;

	};

	for ( let s = 0; s < segs.length; s += 2 ) {

		const wi = segs[ s ], w = city.ways[ wi ], k = segs[ s + 1 ], p = w.pts[ k ], q = w.pts[ k + 1 ];
		if ( ! w.along || w.width < 5 ) continue;
		const a0 = w.along[ k ], a1 = w.along[ k + 1 ], len = a1 - a0;
		if ( len < 1e-6 ) continue;
		const dx = ( q.x - p.x ) / len, dz = ( q.z - p.z ) / len, nx = - dz, nz = dx;
		// rumbo de quien avanza de p a q (yaw del juego) y el contrario; a la derecha del avance queda side = 1
		const yawFwd = Math.atan2( - dx, - dz ), yawBack = Math.atan2( dx, dz );
		const at = ( t, side, off ) => [ p.x + dx * ( t - a0 ) + nx * off * side, p.z + dz * ( t - a0 ) + nz * off * side ];
		// lo ya puesto en este tramo, para que nada quede encima de otra cosa
		const taken = [];
		const clear = ( x, z, r = 3 ) => { for ( const o of taken ) if ( Math.hypot( o[ 0 ] - x, o[ 1 ] - z ) < r ) return false; return true; };
		const ok = ( x, z, r ) => within( x, z ) && ! nearOtherRoad( x, z, wi ) && free( x, z ) && clear( x, z, r );
		const major = w.width >= MAJOR;

		// árboles de vereda, en las calles de 7 m o más
		if ( w.width >= 7 ) {

			const offset = w.width / 2 + SIDEWALK - 0.55;
			for ( let t = Math.ceil( ( a0 + 6 ) / TREE_SPACING ) * TREE_SPACING; t < a1 - 4; t += TREE_SPACING ) {

				for ( const side of [ - 1, 1 ] ) {

					const seed = w.id * 13 + Math.round( t ) * 3 + side;
					if ( hashId( seed + 2 ) < 0.3 ) continue; // no toda vereda tiene su árbol
					const [ x, z ] = at( t, side, offset );
					if ( ! within( x, z ) || nearOtherRoad( x, z, wi ) ) continue;
					plant( x, z, seed ); taken.push( [ x, z ] );

				}

			}

		}

		// postes de luz en las calles menores, alternando de lado
		if ( ! major ) {

			for ( let t = Math.ceil( ( a0 + 9 ) / POLE_SPACING ) * POLE_SPACING; t < a1 - 3; t += POLE_SPACING ) {

				const side = ( Math.round( t / POLE_SPACING ) % 2 ) * 2 - 1;
				const [ x, z ] = at( t, side, w.width / 2 + SIDEWALK - 0.35 );
				if ( ! ok( x, z, 2.5 ) ) continue;
				utilityPole( solid, decor, x, z, side > 0 ? yawFwd : yawBack ); counts.poles ++; taken.push( [ x, z ] ); objects.push( { kind: 'poste', x, z } );

			}

		}

		if ( ! major ) continue; // desde aquí, solo vías principales (terciarias y mayores)

		// faroles
		for ( let t = Math.ceil( ( a0 + 3 ) / LAMP_SPACING ) * LAMP_SPACING; t < a1 - 2; t += LAMP_SPACING ) {

			const side = ( Math.round( t / LAMP_SPACING ) % 2 ) * 2 - 1;
			const [ x, z ] = at( t, side, w.width / 2 + 0.5 );
			if ( ! within( x, z ) || nearOtherRoad( x, z, wi ) ) continue;
			lamp( decor, glow, pool, x, z, - nx * side, - nz * side, solid );
			lampsOf.push( x ); taken.push( [ x, z ] ); objects.push( { kind: 'farol', x, z } );

		}

		// paraderos sobre la vereda, abiertos hacia la calle, con su señal
		for ( let t = Math.ceil( ( a0 + 25 ) / STOP_SPACING ) * STOP_SPACING; t < a1 - 8; t += STOP_SPACING ) {

			const side = ( Math.round( t / STOP_SPACING ) % 2 ) * 2 - 1;
			const [ x, z ] = at( t, side, w.width / 2 + 1.0 );
			if ( ! ok( x, z, 4 ) ) continue;
			const yaw = side > 0 ? yawBack : yawFwd; // de frente a la calle
			busStop( solid, decor, x, z, yaw ); counts.stops ++; taken.push( [ x, z ] ); objects.push( { kind: 'paradero', x, z } );
			const [ sx, sz ] = at( t + 2.6, side, w.width / 2 + 0.45 );
			if ( within( sx, sz ) ) { roadSign( solid, sign, sx, sz, side > 0 ? yawFwd : yawBack, SIGNS.paradero, 0.6 ); counts.signs ++; taken.push( [ sx, sz ] ); objects.push( { kind: 'senal', x: sx, z: sz } ); }

		}

		// señales de velocidad máxima, una por sentido, a la derecha de quien avanza
		for ( let t = Math.ceil( ( a0 + 20 ) / SIGN_SPACING ) * SIGN_SPACING; t < a1 - 5; t += SIGN_SPACING ) {

			const side = ( Math.round( t / SIGN_SPACING ) % 2 ) * 2 - 1;
			const [ x, z ] = at( t, side, w.width / 2 + 0.45 );
			if ( ! ok( x, z, 2.5 ) ) continue;
			roadSign( solid, sign, x, z, side > 0 ? yawFwd : yawBack, SIGNS.velocidad ); counts.signs ++; taken.push( [ x, z ] ); objects.push( { kind: 'senal', x, z } );

		}

		// autos estacionados junto a la solera, con dos ruedas sobre la vereda, mirando en el sentido de su lado
		for ( let t = Math.ceil( ( a0 + 4 ) / PARK_SPACING ) * PARK_SPACING; t < a1 - 3; t += PARK_SPACING ) {

			for ( const side of [ - 1, 1 ] ) {

				const seed = w.id * 29 + Math.round( t ) * 5 + side;
				if ( hashId( seed + 3 ) < 0.45 ) continue;
				const [ x, z ] = at( t, side, w.width / 2 + 0.3 );
				if ( ! ok( x, z, 3.6 ) ) continue;
				parkedCar( solid, x, z, side > 0 ? yawFwd : yawBack, CAR_COLORS[ Math.floor( hashId( seed ) * CAR_COLORS.length ) ], hashId( seed + 1 ) );
				counts.parked ++; taken.push( [ x, z ] ); objects.push( { kind: 'estacionado', x, z, yaw: side > 0 ? yawFwd : yawBack } );

			}

		}

	}

	// cruces: semáforos donde se encuentran dos vías principales; discos Pare donde una menor llega a una principal
	for ( const ci of entry.crossings || [] ) {

		const c = city.crossings[ ci ];
		const majors = c.approaches.filter( a => a.width >= MAJOR ), minors = c.approaches.filter( a => a.width < MAJOR );
		const majorWays = new Set( majors.map( a => a.wi ) );
		const widest = Math.max( ...c.approaches.map( a => a.width ) );
		if ( majorWays.size >= 2 ) {

			// la vía principal de id menor forma el grupo 0 (parte en verde); las demás, el 1 (mismo convenio que signals.js)
			const majorIds = [ ...majorWays ].map( wi => city.ways[ wi ].id ).sort( ( p, q ) => p - q );
			const ckey = `${ Math.round( c.x * 5 ) },${ Math.round( c.z * 5 ) }`;
			for ( const a of majors ) {

				// esquina derecha de quien llega por esta aproximación (viene en el sentido -u)
				const other = Math.max( ...c.approaches.filter( b => b.wi !== a.wi ).map( b => b.width ) );
				const x = c.x + a.ux * ( other / 2 + SIDEWALK + 0.4 ) + a.uz * ( a.width / 2 + 0.5 );
				const z = c.z + a.uz * ( other / 2 + SIDEWALK + 0.4 ) - a.ux * ( a.width / 2 + 0.5 );
				if ( ! within( x, z ) || ! free( x, z ) ) continue;
				const group = city.ways[ a.wi ].id === majorIds[ 0 ] ? 0 : 1;
				for ( const l of trafficLight( solid, decor, glow, x, z, Math.atan2( a.ux, a.uz ), group === 0 ? 'green' : 'red' ) ) signalLamps.push( { key: ckey, group, ...l } );
				counts.lights ++; objects.push( { kind: 'semaforo', x, z, group } );

			}

		} else if ( majors.length > 0 ) {

			for ( const a of minors ) {

				const x = c.x + a.ux * ( widest / 2 + SIDEWALK + 1.5 ) + a.uz * ( a.width / 2 + 0.45 );
				const z = c.z + a.uz * ( widest / 2 + SIDEWALK + 1.5 ) - a.ux * ( a.width / 2 + 0.45 );
				if ( ! within( x, z ) || ! free( x, z ) ) continue;
				roadSign( solid, sign, x, z, Math.atan2( a.ux, a.uz ), SIGNS.pare, 0.7 );
				counts.signs ++; objects.push( { kind: 'senal', x, z } );

			}

		}

	}

	return { ground: mb.finish(), buildings: bld.finish(), park: park.finish(), walk: walk.finish(), road: road.finish(), line: line.finish(), decor: decor.finish(), glow: glow.finish(), pool: pool.finish(), solid: solid.finish(), sign: sign.finish(), trees: count, lamps: lampsOf.length, objects, signalLamps, ...counts };

}

export const LAYERS = [ 'ground', 'buildings', 'park', 'walk', 'road', 'line', 'decor', 'glow', 'pool', 'solid', 'sign' ];
export const RAY_LAYERS = [ 'ground', 'buildings', 'solid' ]; // las que responden los rayos de la física

// Cerros brumosos en el horizonte: un anillo de lomas con alturas de ruido, decorativo.
// Tres vueltas de vértices (pie interior, cresta, pie exterior); el color sube del
// verde del suelo al gris azulado de la bruma con la altura.
export function hillRing( r0 = 2000, r1 = 2900, segments = 120 ) {

	const mb = new MeshBuilder();
	const height = th => { const n = valueNoise( Math.cos( th ) * 4 + 50, Math.sin( th ) * 4 + 50, 1 ) * 0.7 + valueNoise( Math.cos( th ) * 11 + 9, Math.sin( th ) * 11 + 9, 1 ) * 0.3; return 60 + 420 * n * n; };
	const rows = [];
	for ( let s = 0; s < segments; s ++ ) {

		const th = 2 * Math.PI * s / segments, c = Math.cos( th ), sn = Math.sin( th ), h = height( th );
		const mix = ( a, b, t ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ];
		rows.push( [
			mb.vertex( c * r0, - 1, sn * r0, COLORS.hillLow ),
			mb.vertex( c * ( r0 + r1 ) / 2, h, sn * ( r0 + r1 ) / 2, mix( COLORS.hillLow, COLORS.hill, Math.min( 1, h / 300 ) ) ),
			mb.vertex( c * r1, h * 0.35, sn * r1, COLORS.hill ),
		] );

	}

	for ( let s = 0; s < segments; s ++ ) {

		const a = rows[ s ], b = rows[ ( s + 1 ) % segments ];
		// las caras miran hacia adentro, donde está la ciudad
		mb.quad( a[ 0 ], b[ 0 ], b[ 1 ], a[ 1 ] );
		mb.quad( a[ 1 ], b[ 1 ], b[ 2 ], a[ 2 ] );

	}

	return mb.finish();

}

// Suelo plano y enorme bajo todo, para que el horizonte no quede vacío y siempre haya dónde pisar
export function groundPlane( extent = OPEN.groundExtent ) {

	const mb = new MeshBuilder();
	const c = COLORS.ground, col = [ c[ 0 ] * 0.92, c[ 1 ] * 0.92, c[ 2 ] * 0.92 ];
	const v = [ [ - extent, - extent ], [ extent, - extent ], [ extent, extent ], [ - extent, extent ] ].map( ( [ x, z ] ) => mb.vertex( x, - 0.03, z, col ) );
	mb.quad( v[ 0 ], v[ 3 ], v[ 2 ], v[ 1 ] );
	return mb.finish();

}
