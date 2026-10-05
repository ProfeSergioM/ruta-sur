// Edificios sintéticos sobre calles reales, para las pruebas del mapa abierto.
// El entorno de desarrollo no llega a Overpass, así que no hay una muestra real
// de edificios: se reparten plantas cuadradas (y una en L) en las manzanas de la
// muestra real del centro de Temuco, lejos de las calles, con las etiquetas que
// usa el juego (tipo, pisos, altura). Una de cada once celdas es una plaza, una
// de cada veintitrés un espejo de agua, y hay árboles mapeados uno por uno.
// Responde en el formato de Overpass.
import { Geo } from '../src/geo.js';

function hash( i ) { const s = Math.sin( i * 127.1 + 311.7 ) * 43758.5453; return s - Math.floor( s ); }

// Distancia de un punto a un segmento en planta
function distSeg( px, pz, ax, az, bx, bz ) {

	const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
	const t = l2 > 0 ? Math.max( 0, Math.min( 1, ( ( px - ax ) * dx + ( pz - az ) * dz ) / l2 ) ) : 0;
	return Math.hypot( px - ( ax + dx * t ), pz - ( az + dz * t ) );

}

/**
 * roads: respuesta de Overpass con las calles; geo: la conversión del juego.
 * Devuelve { elements } con vías cerradas etiquetadas "building", plazas, agua y árboles.
 */
export function syntheticBuildings( roads, geo, { step = 30, clear = 14, margin = 40 } = {} ) {

	const g = { x: 0, y: 0, z: 0 }, segs = [];
	let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	for ( const e of roads.elements ) {

		const pts = ( e.geometry || [] ).filter( Boolean ).map( p => { geo.toWorld( p.lat, p.lon, 0, g ); return [ g.x, g.z ]; } );
		for ( let i = 0; i < pts.length - 1; i ++ ) segs.push( [ ...pts[ i ], ...pts[ i + 1 ] ] );
		for ( const [ x, z ] of pts ) { x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); z0 = Math.min( z0, z ); z1 = Math.max( z1, z ); }

	}

	const elements = [];
	const geoPt = ( x, z ) => { const o = geo.toGeo( x, 0, z ); return { lat: o.lat, lon: o.lon }; };
	const closed = pts => { const ring = pts.map( ( [ x, z ] ) => geoPt( x, z ) ); ring.push( ring[ 0 ] ); return ring; };
	let id = 900000000, n = 0;
	for ( let x = x0 - margin; x <= x1 + margin; x += step ) for ( let z = z0 - margin; z <= z1 + margin; z += step ) {

		n ++;
		let d = Infinity;
		for ( const s of segs ) { d = Math.min( d, distSeg( x, z, s[ 0 ], s[ 1 ], s[ 2 ], s[ 3 ] ) ); if ( d < clear ) break; }
		if ( d < clear ) continue;
		const r = hash( n ), size = 9 + 7 * hash( n + 1 ), h = size / 2;
		if ( n % 11 === 0 || n % 23 === 0 ) {

			// plaza o agua, del tamaño de la celda, y dos árboles mapeados en la plaza
			const w = step / 2 - 2;
			const tags = n % 23 === 0 ? { natural: 'water' } : { leisure: 'park' };
			elements.push( { type: 'way', id: id ++, geometry: closed( [ [ x - w, z - w ], [ x + w, z - w ], [ x + w, z + w ], [ x - w, z + w ] ] ), tags } );
			if ( n % 23 !== 0 ) for ( const [ dx, dz ] of [ [ - 4, - 3 ], [ 5, 4 ] ] ) elements.push( { type: 'node', id: id ++, ...geoPt( x + dx, z + dz ), tags: { natural: 'tree' } } );
			continue;

		}

		const tags = r < 0.5 ? { building: 'house' } : ( r < 0.8 ? { building: 'apartments', 'building:levels': String( 3 + Math.floor( hash( n + 2 ) * 5 ) ) } : { building: 'commercial', height: `${ ( 7 + 6 * hash( n + 3 ) ).toFixed( 1 ) } m` } );
		// una de cada siete en forma de L, para probar la triangulación de plantas cóncavas
		const pts = n % 7 === 0
			? [ [ x - h, z - h ], [ x + h, z - h ], [ x + h, z ], [ x, z ], [ x, z + h ], [ x - h, z + h ] ]
			: [ [ x - h, z - h ], [ x + h, z - h ], [ x + h, z + h ], [ x - h, z + h ] ];
		elements.push( { type: 'way', id: id ++, geometry: closed( pts ), tags } );

	}

	return { elements };

}

export const geoOf = ( lat, lon ) => new Geo( lat, lon, 0 );
