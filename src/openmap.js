// Ruta Sur · mapa abierto
// --------------------------------------------------------------------------
// Una ciudad levantada desde OpenStreetMap, sin credencial: las calles como
// franjas de asfalto con vereda, y los edificios como prismas de colores
// extruidos desde su planta, con la altura que OSM declare o una típica de su
// tipo. No hay fotografía ni relieve: el suelo es plano. Sirve para repartir
// encargos por las calles verdaderas de una ciudad sin pagar teselas.
//
// El módulo es puro (no depende de Three.js): recibe las respuestas de Overpass
// ya convertidas a coordenadas del juego y entrega mallas por trozos, en el
// mismo formato que la ciudad de pruebas. Ejes: +X oeste, +Y arriba, +Z norte.

import { ROAD_CLASSES, buildingHeight } from './osm.js';
import { MeshBuilder, valueNoise } from './testcity.js';

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
	ground: [ 0.46, 0.49, 0.36 ],
};
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

// Prisma vertical sobre un polígono en planta: paredes sombreadas según su orientación y techo plano
export function prism( mb, poly, y0, y1, col, roofShade = 0.8 ) {

	// la misma orientación que las cajas de la ciudad de pruebas: área positiva
	const pts = signedArea( poly ) < 0 ? poly.slice().reverse() : poly;
	const n = pts.length;
	for ( let k = 0; k < n; k ++ ) {

		const a = pts[ k ], b = pts[ ( k + 1 ) % n ];
		const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot( dx, dz );
		if ( len < 1e-6 ) continue;
		// normal exterior de la pared, con la orientación de las cajas
		const nx = dz / len, nz = - dx / len;
		const shade = 0.68 + 0.3 * ( 0.5 + 0.5 * ( nx * LX + nz * LZ ) );
		const v0 = mb.vertex( a.x, y0, a.z, col, shade * 0.9 ), v1 = mb.vertex( b.x, y0, b.z, col, shade * 0.9 );
		const v2 = mb.vertex( b.x, y1, b.z, col, shade ), v3 = mb.vertex( a.x, y1, a.z, col, shade );
		mb.quad( v0, v3, v2, v1 );

	}

	const top = pts.map( p => mb.vertex( p.x, y1, p.z, col, roofShade ) );
	const tris = triangulate( pts );
	// el techo mira hacia arriba con el orden inverso al de las paredes
	for ( let i = 0; i < tris.length; i += 3 ) mb.tri( top[ tris[ i ] ], top[ tris[ i + 2 ] ], top[ tris[ i + 1 ] ] );

}

// Franja plana a lo largo de una polilínea, con discos en los vértices interiores para cerrar los codos
function strip( mb, pts, width, y, col ) {

	const w = width / 2;
	for ( let i = 0; i < pts.length - 1; i ++ ) {

		const p = pts[ i ], q = pts[ i + 1 ];
		const dx = q.x - p.x, dz = q.z - p.z, len = Math.hypot( dx, dz );
		if ( len < 1e-6 ) continue;
		const nx = - dz / len * w, nz = dx / len * w;
		const a = mb.vertex( p.x + nx, y, p.z + nz, col ), b = mb.vertex( q.x + nx, y, q.z + nz, col );
		const c = mb.vertex( q.x - nx, y, q.z - nz, col ), d = mb.vertex( p.x - nx, y, p.z - nz, col );
		// mira hacia arriba (el orden importa: la cara de atrás no se dibuja)
		mb.quad( a, b, c, d );
		if ( i > 0 && w > 0.4 ) {

			const center = mb.vertex( p.x, y, p.z, col ), ring = [];
			for ( let k = 0; k < 8; k ++ ) { const th = Math.PI * 2 * k / 8; ring.push( mb.vertex( p.x + Math.cos( th ) * w, y, p.z + Math.sin( th ) * w, col ) ); }
			for ( let k = 0; k < 8; k ++ ) mb.tri( center, ring[ ( k + 1 ) % 8 ], ring[ k ] );

		}

	}

}

/**
 * Convierte las respuestas de Overpass (calles y edificios) a la ciudad del juego:
 * vías con sus puntos en planta y ancho, y edificios con su planta, altura y color.
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
		ways.push( { id: e.id, pts, width, line: ! e.tags.oneway && cls && cls.rank <= 6 && width >= 7 } );

	}

	const list = [];
	for ( const e of ( buildings && buildings.elements ) || [] ) {

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
		let cx = 0, cz = 0;
		for ( const p of poly ) { cx += p.x; cz += p.z; }
		cx /= poly.length; cz /= poly.length;
		const r = hashId( e.id );
		list.push( { id: e.id, poly, cx, cz, h: buildingHeight( e.tags, r ), color: PALETTE[ Math.floor( hashId( e.id + 7 ) * PALETTE.length ) ], tags: e.tags || {} } );

	}

	return { ways, buildings: list, chunk: OPEN.chunk, index: null };

}

const key = ( i, j ) => `${ i },${ j }`;
export const chunkOf = ( v, size = OPEN.chunk ) => Math.floor( v / size );

// Índice por trozo: qué tramos de vía y qué edificios dibuja cada uno. Un tramo
// va en todos los trozos que toca su caja; un edificio, en el de su centro.
export function chunkIndex( city, size = OPEN.chunk ) {

	const map = new Map();
	const get = ( i, j ) => { const k = key( i, j ); let c = map.get( k ); if ( ! c ) { c = { segments: [], buildings: [] }; map.set( k, c ); } return c; };
	city.ways.forEach( ( w, wi ) => {

		for ( let s = 0; s < w.pts.length - 1; s ++ ) {

			const p = w.pts[ s ], q = w.pts[ s + 1 ], m = w.width / 2 + SIDEWALK;
			const i0 = chunkOf( Math.min( p.x, q.x ) - m, size ), i1 = chunkOf( Math.max( p.x, q.x ) + m, size );
			const j0 = chunkOf( Math.min( p.z, q.z ) - m, size ), j1 = chunkOf( Math.max( p.z, q.z ) + m, size );
			for ( let i = i0; i <= i1; i ++ ) for ( let j = j0; j <= j1; j ++ ) get( i, j ).segments.push( wi, s );

		}

	} );
	city.buildings.forEach( ( b, bi ) => get( chunkOf( b.cx, size ), chunkOf( b.cz, size ) ).buildings.push( bi ) );
	city.index = map; city.chunk = size;
	return map;

}

/**
 * Mallas del trozo (i, j), en cuatro capas que el mundo dibuja con desplazamiento
 * de polígono creciente, para que el orden no dependa de la precisión del búfer
 * de profundidad: base (suelo y edificios), veredas, calzadas y líneas centrales.
 * Las capas van a milímetros una de otra; de lejos, sin el desplazamiento, se
 * mezclarían. Solo la base responde los rayos de la física.
 */
export function buildOpenChunk( city, i, j ) {

	const size = city.chunk, x0 = i * size, z0 = j * size, x1 = x0 + size, z1 = z0 + size;
	const mb = new MeshBuilder(), walk = new MeshBuilder(), road = new MeshBuilder(), line = new MeshBuilder();
	const entry = ( city.index || chunkIndex( city, size ) ).get( key( i, j ) ) || { segments: [], buildings: [] };

	// suelo: una grilla chica con un leve moteado
	const G = 4;
	for ( let b = 0; b <= G; b ++ ) for ( let a = 0; a <= G; a ++ ) {

		const x = x0 + size * a / G, z = z0 + size * b / G, n = 0.88 + 0.24 * valueNoise( x, z, 23 );
		mb.vertex( x, 0, z, [ COLORS.ground[ 0 ] * n, COLORS.ground[ 1 ] * n, COLORS.ground[ 2 ] * n ] );

	}

	for ( let b = 0; b < G; b ++ ) for ( let a = 0; a < G; a ++ ) {

		const v = b * ( G + 1 ) + a;
		mb.quad( v, v + G + 1, v + G + 2, v + 1 );

	}

	// calles: la vereda debajo, la calzada encima y la línea sobre la calzada
	const segs = entry.segments;
	for ( let s = 0; s < segs.length; s += 2 ) {

		const w = city.ways[ segs[ s ] ], k = segs[ s + 1 ], pts = [ w.pts[ k ], w.pts[ k + 1 ] ];
		strip( walk, pts, w.width + 2 * SIDEWALK, 0.01, COLORS.sidewalk );
		strip( road, pts, w.width, 0.02, COLORS.road );
		if ( w.line ) strip( line, pts, 0.22, 0.03, COLORS.line );

	}

	for ( const bi of entry.buildings ) {

		const b = city.buildings[ bi ];
		prism( mb, b.poly, - 0.5, b.h, b.color );

	}

	return { base: mb.finish(), walk: walk.finish(), road: road.finish(), line: line.finish() };

}

export const LAYERS = [ 'base', 'walk', 'road', 'line' ];

// Suelo plano y enorme bajo todo, para que el horizonte no quede vacío y siempre haya dónde pisar
export function groundPlane( extent = OPEN.groundExtent ) {

	const mb = new MeshBuilder();
	const c = COLORS.ground, col = [ c[ 0 ] * 0.92, c[ 1 ] * 0.92, c[ 2 ] * 0.92 ];
	const v = [ [ - extent, - extent ], [ extent, - extent ], [ extent, extent ], [ - extent, extent ] ].map( ( [ x, z ] ) => mb.vertex( x, - 0.03, z, col ) );
	mb.quad( v[ 0 ], v[ 3 ], v[ 2 ], v[ 1 ] );
	return mb.finish();

}
