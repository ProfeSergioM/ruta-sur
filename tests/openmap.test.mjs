// Pruebas del mapa abierto: triangulación, prismas, conversión de OpenStreetMap y trozos.
// Ejecutar: node tests/openmap.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signedArea, triangulate, prism, openCity, chunkIndex, buildOpenChunk, groundPlane, chunkOf, hashId, ROAD_WIDTH, OPEN, LAYERS } from '../src/openmap.js';
import { buildingHeight, buildingsQuery } from '../src/osm.js';
import { MeshBuilder } from '../src/testcity.js';
import { Geo } from '../src/geo.js';
import { syntheticBuildings } from './open-fixture.mjs';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };
const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );

// --------------------------------------------------------------- triangulación
const triArea = ( poly, tris ) => { let a = 0; for ( let i = 0; i < tris.length; i += 3 ) a += Math.abs( signedArea( [ poly[ tris[ i ] ], poly[ tris[ i + 1 ] ], poly[ tris[ i + 2 ] ] ] ) ); return a; };
{

	const square = [ { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 } ];
	const t = triangulate( square );
	report( 'Un cuadrado se parte en dos triángulos que suman su área', t.length === 6 && Math.abs( triArea( square, t ) - 100 ) < 1e-9, `${ t.length / 3 } triángulos, ${ triArea( square, t ) } m²` );
	const L = [ { x: 0, z: 0 }, { x: 20, z: 0 }, { x: 20, z: 8 }, { x: 8, z: 8 }, { x: 8, z: 20 }, { x: 0, z: 20 } ];
	const tl = triangulate( L ), areaL = Math.abs( signedArea( L ) );
	report( 'Una planta en L (cóncava) se triangula completa', tl.length === 12 && Math.abs( triArea( L, tl ) - areaL ) < 1e-9, `${ tl.length / 3 } triángulos, ${ triArea( L, tl ) } de ${ areaL } m²` );
	const Lr = L.slice().reverse(), tr = triangulate( Lr );
	report( 'Con la orientación contraria también', tr.length === 12 && Math.abs( triArea( Lr, tr ) - areaL ) < 1e-9 );
	// los triángulos conservan la orientación del polígono
	const sameSign = ( poly, tris ) => { const s = Math.sign( signedArea( poly ) ); for ( let i = 0; i < tris.length; i += 3 ) if ( Math.sign( signedArea( [ poly[ tris[ i ] ], poly[ tris[ i + 1 ] ], poly[ tris[ i + 2 ] ] ] ) ) !== s ) return false; return true; };
	report( 'Los triángulos conservan la orientación del polígono', sameSign( L, tl ) && sameSign( Lr, tr ) );
	const bow = [ { x: 0, z: 0 }, { x: 10, z: 10 }, { x: 10, z: 0 }, { x: 0, z: 10 } ];
	const tb = triangulate( bow );
	report( 'Un polígono que se cruza no revienta: se cierra en abanico', tb.length === 6, `${ tb.length / 3 } triángulos` );
	// una planta real con muchas esquinas, casi colineales
	const ring = []; for ( let k = 0; k < 40; k ++ ) { const th = 2 * Math.PI * k / 40; ring.push( { x: 15 * Math.cos( th ), z: 9 * Math.sin( th ) } ); }
	const trr = triangulate( ring );
	report( 'Un óvalo de 40 esquinas se triangula entero', trr.length === 38 * 3 && Math.abs( triArea( ring, trr ) - Math.abs( signedArea( ring ) ) ) < 1e-6 );

}

// ----------------------------------------------------------------------- prisma
{

	const mb = new MeshBuilder();
	const square = [ { x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 10 }, { x: 0, z: 10 } ];
	prism( mb, square, 0, 6, [ 1, 1, 1 ] );
	const m = mb.finish();
	report( 'Un prisma cuadrado: 16 vértices de pared, 4 de techo, 10 triángulos', m.positions.length === 20 * 3 && m.indices.length === 30, `${ m.positions.length / 3 } vértices, ${ m.indices.length / 3 } triángulos` );
	// normales: las paredes miran hacia afuera y el techo hacia arriba
	const P = m.positions, I = m.indices;
	let outward = 0, up = 0, bad = 0;
	for ( let i = 0; i < I.length; i += 3 ) {

		const a = I[ i ] * 3, b = I[ i + 1 ] * 3, c = I[ i + 2 ] * 3;
		const e1 = [ P[ b ] - P[ a ], P[ b + 1 ] - P[ a + 1 ], P[ b + 2 ] - P[ a + 2 ] ], e2 = [ P[ c ] - P[ a ], P[ c + 1 ] - P[ a + 1 ], P[ c + 2 ] - P[ a + 2 ] ];
		const n = [ e1[ 1 ] * e2[ 2 ] - e1[ 2 ] * e2[ 1 ], e1[ 2 ] * e2[ 0 ] - e1[ 0 ] * e2[ 2 ], e1[ 0 ] * e2[ 1 ] - e1[ 1 ] * e2[ 0 ] ];
		const cx = ( P[ a ] + P[ b ] + P[ c ] ) / 3 - 5, cz = ( P[ a + 2 ] + P[ b + 2 ] + P[ c + 2 ] ) / 3 - 5;
		if ( Math.abs( n[ 1 ] ) > 1e-9 && Math.abs( n[ 0 ] ) < 1e-9 && Math.abs( n[ 2 ] ) < 1e-9 ) { if ( n[ 1 ] > 0 ) up ++; else bad ++; }
		else if ( n[ 0 ] * cx + n[ 2 ] * cz > 0 ) outward ++; else bad ++;

	}

	report( 'Las paredes miran hacia afuera y el techo hacia arriba', outward === 8 && up === 2 && bad === 0, `${ outward } paredes, ${ up } techos, ${ bad } al revés` );
	const mb2 = new MeshBuilder();
	prism( mb2, square.slice().reverse(), 0, 6, [ 1, 1, 1 ] );
	const m2 = mb2.finish();
	report( 'Con la planta al revés sale el mismo prisma', m2.indices.length === 30 );

}

// ---------------------------------------------------------- alturas y consulta
{

	report( 'Altura declarada en metros', buildingHeight( { height: '12.5 m' } ) === 12.5 && buildingHeight( { height: '7,5' } ) === 7.5 );
	report( 'Altura por pisos: 4 pisos ≈ 13 m', Math.abs( buildingHeight( { 'building:levels': '4' } ) - 13.3 ) < 0.01 );
	report( 'Altura típica por tipo, con dispersión acotada', buildingHeight( { building: 'house' }, 0 ) === 5.5 * 0.85 && buildingHeight( { building: 'house' }, 1 ) === 5.5 * 1.15 && buildingHeight( {}, 0.5 ) === 6 );
	report( 'Una altura absurda se acota', buildingHeight( { height: '99999' } ) === 300 );
	const q = buildingsQuery( - 38.739141, - 72.590355, 1500 );
	report( 'La consulta de edificios pide vías con "building", etiquetas y geometría', /way\["building"\]\(around:1500,-38\.739141,-72\.590355\)/.test( q ) && /out tags geom/.test( q ) && /\[out:json\]/.test( q ), q.replace( /\n/g, ' ' ) );
	report( 'El ancho de calzada cubre todas las clases de vía del juego', Object.keys( ROAD_WIDTH ).length >= 13 && ROAD_WIDTH.residential === 7 );
	const r = [ hashId( 1 ), hashId( 2 ), hashId( 900000001 ) ];
	report( 'El identificador da un número determinista en [0, 1)', r.every( v => v >= 0 && v < 1 ) && r[ 0 ] !== r[ 1 ] && hashId( 1 ) === r[ 0 ] );

}

// ---------------------------------------------- ciudad desde la muestra de Temuco
{

	const roads = JSON.parse( readFileSync( resolve( root, 'tests/fixtures/temuco-centro.json' ), 'utf8' ) );
	const geo = new Geo( - 38.739141, - 72.590355, 0 );
	const buildings = syntheticBuildings( roads, geo );
	report( 'La muestra sintética tiene edificios con plantas cerradas', buildings.elements.length > 100 && buildings.elements.every( e => e.geometry[ 0 ].lat === e.geometry[ e.geometry.length - 1 ].lat ), `${ buildings.elements.length } edificios` );
	const city = openCity( roads, buildings, geo );
	const known = roads.elements.filter( e => ROAD_WIDTH[ e.tags.highway ] ).length;
	report( 'Cada vía con clase conocida se convierte en una franja', city.ways.length === known && city.ways.every( w => w.pts.length >= 2 && w.width > 0 ), `${ city.ways.length } vías` );
	report( 'Cada edificio pierde el punto repetido del cierre y tiene altura y color', city.buildings.length === buildings.elements.length && city.buildings.every( ( b, i ) => b.poly.length === buildings.elements[ i ].geometry.length - 1 && b.h > 2 && b.color.length === 3 ) );
	const lShaped = city.buildings.filter( b => b.poly.length === 6 ).length;
	report( 'Las plantas en L se conservan con sus seis esquinas', lShaped > 5, `${ lShaped }` );
	const index = chunkIndex( city );
	let once = 0, split = 0;
	const seen = new Map();
	for ( const [ k, c ] of index ) { for ( const bi of c.buildings ) seen.set( bi, ( seen.get( bi ) || 0 ) + 1 ); }
	for ( const [ , n ] of seen ) if ( n === 1 ) once ++;
	report( 'Cada edificio va en un solo trozo', once === city.buildings.length && seen.size === city.buildings.length );
	// un tramo que cruza el borde de un trozo se dibuja en ambos
	for ( const w of city.ways ) for ( let s = 0; s < w.pts.length - 1; s ++ ) if ( chunkOf( w.pts[ s ].x ) !== chunkOf( w.pts[ s + 1 ].x ) ) split ++;
	let both = 0;
	for ( const w of city.ways ) for ( let s = 0; s < w.pts.length - 1; s ++ ) {

		const i0 = chunkOf( w.pts[ s ].x ), i1 = chunkOf( w.pts[ s + 1 ].x );
		if ( i0 === i1 ) continue;
		const j = chunkOf( w.pts[ s ].z ), wi = city.ways.indexOf( w );
		const has = ( i, jj ) => { const c = index.get( `${ i },${ jj }` ); if ( ! c ) return false; for ( let q = 0; q < c.segments.length; q += 2 ) if ( c.segments[ q ] === wi && c.segments[ q + 1 ] === s ) return true; return false; };
		if ( has( i0, j ) && has( i1, j ) ) both ++;

	}

	report( 'Un tramo que cruza el borde de un trozo se dibuja en los dos', split > 0 && both === split, `${ both } de ${ split }` );
	const i = chunkOf( 0 ), j = chunkOf( 0 );
	const parts = buildOpenChunk( city, i, j );
	// todas las capas juntas, para las comprobaciones de forma
	const m = { positions: Float32Array.from( [].concat( ...LAYERS.map( n => [ ...parts[ n ].positions ] ) ) ), indices: [] };
	{ let off = 0; for ( const n of LAYERS ) { for ( const ix of parts[ n ].indices ) m.indices.push( ix + off ); off += parts[ n ].positions.length / 3; } }
	let minY = Infinity, maxY = - Infinity;
	for ( let k = 1; k < m.positions.length; k += 3 ) { minY = Math.min( minY, m.positions[ k ] ); maxY = Math.max( maxY, m.positions[ k ] ); }
	report( 'El trozo del centro tiene suelo, calles y edificios', m.positions.length > 3 * 100 && m.indices.length % 3 === 0 && minY === - 0.5 && maxY > 3 && maxY < 300, `${ m.positions.length / 3 } vértices, ${ m.indices.length / 3 } triángulos, alturas de ${ minY } a ${ maxY.toFixed( 1 ) } m` );
	report( 'Las capas van aparte: base con edificios, veredas, calzadas y líneas', parts.base.indices.length > 96 && parts.walk.indices.length > 0 && parts.road.indices.length > 0 && parts.walk.indices.length === parts.road.indices.length, LAYERS.map( n => `${ n } ${ parts[ n ].indices.length / 3 }` ).join( ', ' ) );
	// todo lo horizontal (suelo, veredas, calzadas, líneas, techos) mira hacia arriba
	let down = 0, flat = 0;
	for ( let k = 0; k < m.indices.length; k += 3 ) {

		const a = m.indices[ k ] * 3, b = m.indices[ k + 1 ] * 3, c = m.indices[ k + 2 ] * 3, P = m.positions;
		const e1 = [ P[ b ] - P[ a ], P[ b + 1 ] - P[ a + 1 ], P[ b + 2 ] - P[ a + 2 ] ], e2 = [ P[ c ] - P[ a ], P[ c + 1 ] - P[ a + 1 ], P[ c + 2 ] - P[ a + 2 ] ];
		const ny = e1[ 2 ] * e2[ 0 ] - e1[ 0 ] * e2[ 2 ], nx = e1[ 1 ] * e2[ 2 ] - e1[ 2 ] * e2[ 1 ], nz = e1[ 0 ] * e2[ 1 ] - e1[ 1 ] * e2[ 0 ];
		if ( Math.abs( ny ) > 1e-9 && Math.abs( nx ) < 1e-9 && Math.abs( nz ) < 1e-9 ) { flat ++; if ( ny < 0 ) down ++; }

	}

	report( 'Suelo, calles y techos miran hacia arriba', flat > 50 && down === 0, `${ flat } triángulos horizontales, ${ down } al revés` );
	const empty = buildOpenChunk( city, 500, 500 );
	report( 'Un trozo sin datos es solo suelo', empty.base.positions.length === 25 * 3 && empty.base.indices.length === 16 * 6 && empty.walk.indices.length === 0 && empty.road.indices.length === 0 );
	const g = groundPlane( 1000 );
	report( 'El suelo plano es un cuadrado', g.positions.length === 12 && g.indices.length === 6 );
	report( 'Los radios de carga están ordenados', OPEN.readyRadius < OPEN.buildRadius && OPEN.buildRadius < OPEN.showRadius && OPEN.showRadius < OPEN.dropRadius );

}

console.log( fail ? `\n${ fail } pruebas fallaron.` : '\nMapa abierto: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
