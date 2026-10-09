// Pruebas del mapa abierto: triangulación, prismas, conversión de OpenStreetMap y trozos.
// Ejecutar: node tests/openmap.test.mjs
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { signedArea, triangulate, prism, openCity, chunkIndex, buildOpenChunk, groundPlane, hillRing, chunkOf, hashId, ROAD_WIDTH, OPEN, LAYERS, RAY_LAYERS, TEXTURE_METERS } from '../src/openmap.js';
import { boxAt } from '../src/furniture.js';
import { MeshBuilder } from '../src/testcity.js';
import { buildingHeight, buildingsQuery } from '../src/osm.js';
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
	const bWays = buildings.elements.filter( e => e.tags.building ), gWays = buildings.elements.filter( e => e.tags.leisure || e.tags.natural === 'water' ), tNodes = buildings.elements.filter( e => e.type === 'node' );
	report( 'La muestra sintética tiene edificios con plantas cerradas, plazas, agua y árboles', bWays.length > 100 && gWays.length > 10 && tNodes.length > 10 && bWays.every( e => e.geometry[ 0 ].lat === e.geometry[ e.geometry.length - 1 ].lat ), `${ bWays.length } edificios, ${ gWays.length } manchas, ${ tNodes.length } árboles` );
	// una caja girada tiene la misma orientación que las de la ciudad de pruebas: la tapa mira hacia arriba
	{

		const a = new MeshBuilder(), b = new MeshBuilder();
		a.box( - 1, 1, - 2, 2, 0, 1, [ 1, 1, 1 ] ); boxAt( b, 0, 0, 0, 4, 2, 0, 1, [ 1, 1, 1 ] );
		const top = m => { const P = m.p, I = m.i; let up = 0, down = 0; for ( let k = 0; k < I.length; k += 3 ) { const [ i0, i1, i2 ] = [ I[ k ], I[ k + 1 ], I[ k + 2 ] ]; if ( P[ i0 * 3 + 1 ] !== 1 || P[ i1 * 3 + 1 ] !== 1 || P[ i2 * 3 + 1 ] !== 1 ) continue; const ux = P[ i1 * 3 ] - P[ i0 * 3 ], uz = P[ i1 * 3 + 2 ] - P[ i0 * 3 + 2 ], vx = P[ i2 * 3 ] - P[ i0 * 3 ], vz = P[ i2 * 3 + 2 ] - P[ i0 * 3 + 2 ]; if ( uz * vx - ux * vz > 0 ) up ++; else down ++; } return { up, down }; };
		const ta = top( a ), tb = top( b );
		report( 'Las cajas giradas del mobiliario miran hacia arriba, como las de la ciudad de pruebas', ta.up === 2 && ta.down === 0 && tb.up === 2 && tb.down === 0, `ciudad ${ ta.up }/${ ta.down }, mobiliario ${ tb.up }/${ tb.down }` );
		const c = new MeshBuilder(); boxAt( c, 10, 20, Math.PI / 2, 4, 2, 0, 1, [ 1, 1, 1 ] );
		let minX = Infinity, maxX = - Infinity, minZ = Infinity, maxZ = - Infinity;
		for ( let k = 0; k < c.p.length; k += 3 ) { minX = Math.min( minX, c.p[ k ] ); maxX = Math.max( maxX, c.p[ k ] ); minZ = Math.min( minZ, c.p[ k + 2 ] ); maxZ = Math.max( maxZ, c.p[ k + 2 ] ); }
		report( 'Girada 90°, el largo de la caja queda a lo ancho', Math.abs( maxX - minX - 4 ) < 1e-9 && Math.abs( maxZ - minZ - 2 ) < 1e-9 && Math.abs( ( minX + maxX ) / 2 - 10 ) < 1e-9 && Math.abs( ( minZ + maxZ ) / 2 - 20 ) < 1e-9 );

	}

	const city = openCity( roads, buildings, geo );
	report( 'Las manchas y los árboles mapeados pasan a la ciudad con su tipo', city.greens.length === gWays.length && city.trees.length === tNodes.length && city.greens.some( g => g.kind === 'water' ) && city.greens.some( g => g.kind === 'green' ), `${ city.greens.length } manchas, ${ city.trees.length } árboles` );
	const known = roads.elements.filter( e => ROAD_WIDTH[ e.tags.highway ] ).length;
	report( 'Cada vía con clase conocida se convierte en una franja', city.ways.length === known && city.ways.every( w => w.pts.length >= 2 && w.width > 0 ), `${ city.ways.length } vías` );
	report( 'Cada edificio pierde el punto repetido del cierre y tiene altura y color', city.buildings.length === bWays.length && city.buildings.every( ( b, i ) => b.poly.length === bWays[ i ].geometry.length - 1 && b.h > 2 && b.color.length === 3 ) );
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
	report( 'Las capas van aparte: suelo, edificios, manchas, veredas, calzadas, líneas y decoración', parts.ground.indices.length === 96 && parts.buildings.indices.length > 0 && parts.walk.indices.length > 0 && parts.road.indices.length > 0 && parts.walk.indices.length === parts.road.indices.length && parts.decor.indices.length > 0 && parts.trees > 0, LAYERS.map( n => `${ n } ${ parts[ n ].indices.length / 3 }` ).join( ', ' ) + `, ${ parts.trees } árboles, ${ parts.lamps } faroles` );
	// un trozo con una plaza de la muestra: lleva la mancha y árboles adentro
	const gi = city.greens.findIndex( g => g.kind === 'green' ), gp = city.greens[ gi ];
	const gParts = buildOpenChunk( city, chunkOf( gp.cx ), chunkOf( gp.cz ) );
	report( 'Una plaza se dibuja como mancha verde y recibe árboles', gParts.park.indices.length >= 6 && gParts.trees >= 2, `${ gParts.park.indices.length / 3 } triángulos de mancha, ${ gParts.trees } árboles` );
	// las fachadas llevan celdas de ventana enteras: u de 0 a un entero por pared
	{

		const uv = parts.buildings.uvs, P = parts.buildings.positions;
		let whole = true, cells = 0;
		for ( let q = 0; q + 3 < P.length / 3 && cells < 50; q += 4 ) {

			const u1 = uv[ ( q + 1 ) * 2 ];
			if ( Math.abs( uv[ q * 2 ] - 0.02 ) < 1e-6 ) break; // llegó al techo (en punto flotante de 32 bits)
			if ( ! Number.isInteger( u1 ) || u1 < 1 ) whole = false;
			cells ++;

		}

		report( 'Las paredes llevan celdas de ventana enteras', cells > 0 && whole, `${ cells } paredes revisadas` );

	}

	// faroles: solo en vías anchas; en algún trozo con una vía principal los hay
	let lamps = 0;
	for ( const w of city.ways ) if ( w.width >= 8 ) { lamps += buildOpenChunk( city, chunkOf( w.pts[ 0 ].x ), chunkOf( w.pts[ 0 ].z ) ).lamps; if ( lamps ) break; }
	report( 'Las vías terciarias y mayores llevan faroles', lamps > 0, `${ lamps }` );
	// con faroles, hay lámparas en la capa que se enciende y charcos de luz en la capa que se suma
	let lit = null;
	for ( const w of city.ways ) if ( w.width >= 8 ) { const p = buildOpenChunk( city, chunkOf( w.pts[ 0 ].x ), chunkOf( w.pts[ 0 ].z ) ); if ( p.lamps ) { lit = p; break; } }
	report( 'Cada farol lleva su lámpara y su charco de luz', lit && lit.glow.indices.length >= lit.lamps * 30 && lit.pool.indices.length === lit.lamps * 36, lit && `${ lit.lamps } faroles, ${ lit.glow.indices.length / 3 } triángulos de lámpara, ${ lit.pool.indices.length / 3 } de charco` );
	// mobiliario urbano: en toda la ciudad hay de cada cosa, y cada pieza queda anotada con su posición
	{

		const tot = { poles: 0, parked: 0, stops: 0, signs: 0, lights: 0, benches: 0, trees: 0, lamps: 0, objects: 0, solid: 0, sign: 0, decor: 0 };
		const kinds = {};
		let parkedOnLane = 0, parkedChecked = 0;
		for ( const [ k ] of index ) {

			const [ ci, cj ] = k.split( ',' ).map( Number ), p = buildOpenChunk( city, ci, cj );
			for ( const n of [ 'poles', 'parked', 'stops', 'signs', 'lights', 'benches', 'trees', 'lamps' ] ) tot[ n ] += p[ n ];
			tot.objects += p.objects.length; tot.solid += p.solid.indices.length; tot.sign += p.sign.indices.length; tot.decor += p.decor.indices.length;
			for ( const o of p.objects ) {

				kinds[ o.kind ] = ( kinds[ o.kind ] || 0 ) + 1;
				if ( o.kind !== 'estacionado' ) continue;
				// un auto estacionado queda junto a la solera: su centro a más de medio ancho de calzada menos 0,6 m del eje
				let best = Infinity, bw = 0;
				for ( const w of city.ways ) for ( let s = 0; s < w.pts.length - 1; s ++ ) { const a = w.pts[ s ], b = w.pts[ s + 1 ], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1, t = Math.max( 0, Math.min( 1, ( ( o.x - a.x ) * ex + ( o.z - a.z ) * ez ) / l2 ) ), d = Math.hypot( o.x - a.x - ex * t, o.z - a.z - ez * t ); if ( d < best ) { best = d; bw = w.width; } }
				parkedChecked ++;
				if ( best < bw / 2 - 0.6 ) parkedOnLane ++;

			}

		}

		report( 'Hay mobiliario por toda la ciudad: postes, estacionados, paraderos, señales, semáforos y bancas', tot.poles > 50 && tot.parked > 50 && tot.stops > 3 && tot.signs > 10 && tot.lights > 5 && tot.benches > 10, JSON.stringify( tot ) );
		report( 'Cada pieza queda anotada con su tipo y posición (más los árboles y faroles)', tot.objects === tot.poles + tot.parked + tot.stops + tot.signs + tot.lights + tot.benches + tot.trees + tot.lamps + ( kinds.basurero || 0 ), Object.entries( kinds ).map( ( [ k, v ] ) => `${ k } ${ v }` ).join( ', ' ) );
		report( 'Lo sólido, las placas y la decoración van en capas aparte, con contenido', tot.solid > 0 && tot.sign > 0 && tot.decor > 0 && RAY_LAYERS.includes( 'solid' ) && ! RAY_LAYERS.includes( 'decor' ) );
		report( 'Ningún auto estacionado invade la calzada', parkedChecked > 50 && parkedOnLane === 0, `${ parkedOnLane } de ${ parkedChecked }` );
		// ningún semáforo ni señal queda sobre una calzada (en una avenida de dos calzadas, la esquina de una cae en la otra)
		let onRoad = 0, checked = 0;
		for ( const [ k ] of index ) for ( const o of buildOpenChunk( city, ...k.split( ',' ).map( Number ) ).objects ) {

			if ( o.kind !== 'semaforo' && o.kind !== 'senal' ) continue;
			checked ++;
			for ( const w of city.ways ) for ( let s = 0; s < w.pts.length - 1; s ++ ) { const a = w.pts[ s ], b = w.pts[ s + 1 ], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1, t = Math.max( 0, Math.min( 1, ( ( o.x - a.x ) * ex + ( o.z - a.z ) * ez ) / l2 ) ); if ( Math.hypot( o.x - a.x - ex * t, o.z - a.z - ez * t ) < w.width / 2 + 0.3 ) { onRoad ++; s = 1e9; break; } }

		}

		report( 'Ningún semáforo ni señal queda sobre una calzada', checked > 20 && onRoad === 0, `${ onRoad } de ${ checked }` );
		// ni un árbol (los de los parques que OpenStreetMap dibuja sobre la calle, o los mapeados junto a la solera)
		let treesOnRoad = 0, treesChecked = 0;
		for ( const [ k ] of index ) for ( const o of buildOpenChunk( city, ...k.split( ',' ).map( Number ) ).objects ) {

			if ( o.kind !== 'arbol' ) continue;
			treesChecked ++;
			for ( const w of city.ways ) for ( let s = 0; s < w.pts.length - 1; s ++ ) { const a = w.pts[ s ], b = w.pts[ s + 1 ], ex = b.x - a.x, ez = b.z - a.z, l2 = ex * ex + ez * ez || 1, t = Math.max( 0, Math.min( 1, ( ( o.x - a.x ) * ex + ( o.z - a.z ) * ez ) / l2 ) ); if ( Math.hypot( o.x - a.x - ex * t, o.z - a.z - ez * t ) < w.width / 2 + 0.75 ) { treesOnRoad ++; s = 1e9; break; } }

		}

		report( 'Ningún árbol queda sobre una calzada ni pegado a la solera', treesChecked > 500 && treesOnRoad === 0, `${ treesOnRoad } de ${ treesChecked }` );
		const majors = city.crossings.filter( c => new Set( c.approaches.filter( a => a.width >= 8 ).map( a => a.wi ) ).size >= 2 ).length;
		const mixed = city.crossings.filter( c => c.approaches.some( a => a.width >= 8 ) && c.approaches.some( a => a.width < 8 ) ).length;
		report( 'Los cruces se reconocen: entre vías principales (semáforos) y de una menor a una principal (Pare)', city.crossings.length > 30 && majors > 5 && mixed > 5 && city.crossings.every( c => c.ways.length >= 2 && c.approaches.length >= 3 ), `${ city.crossings.length } cruces, ${ majors } principal con principal, ${ mixed } menor con principal` );
		// un cruce de dos calles de un sentido como una T: tres aproximaciones; una X: cuatro
		const tees = city.crossings.filter( c => c.approaches.length === 3 ).length, exes = city.crossings.filter( c => c.approaches.length === 4 ).length;
		report( 'Hay cruces en T y en X', tees > 0 && exes > 0, `${ tees } en T, ${ exes } en X` );

	}

	const hills = hillRing( 1000, 1500, 60 );
	report( 'Los cerros del horizonte son un anillo cerrado con alturas variadas', hills.positions.length === 60 * 3 * 3 && hills.indices.length === 60 * 2 * 6 && Math.max( ...[ ...hills.positions ].filter( ( v, i ) => i % 3 === 1 ) ) > 100 );
	// coordenadas de textura de la calzada: u cruza la franja (0 o 1) y v avanza en metros / TEXTURE_METERS
	{

		const uv = parts.road.uvs, P = parts.road.positions;
		let us = new Set(), spanOk = true, n = 0;
		for ( let q = 0; q + 3 < P.length / 3; q += 4 ) {

			// cada tramo aporta cuatro esquinas seguidas: a (u0,va), b (u0,vb), c (u1,vb), d (u1,va); los discos de los codos vienen después
			const len = Math.hypot( P[ ( q + 1 ) * 3 ] - P[ q * 3 ], P[ ( q + 1 ) * 3 + 2 ] - P[ q * 3 + 2 ] );
			const dv = uv[ ( q + 1 ) * 2 + 1 ] - uv[ q * 2 + 1 ];
			if ( uv[ q * 2 ] !== 0 || uv[ ( q + 2 ) * 2 ] !== 1 ) { us.add( uv[ q * 2 ] ); continue; }
			n ++;
			if ( Math.abs( dv - len / TEXTURE_METERS ) > 1e-3 ) spanOk = false;
			break;

		}

		report( 'La calzada lleva coordenadas de textura: u de 0 a 1 y v en metros a lo largo', uv.length === P.length / 3 * 2 && n === 1 && spanOk );

	}
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
	report( 'Un trozo sin datos es solo suelo', empty.ground.positions.length === 25 * 3 && empty.ground.indices.length === 16 * 6 && empty.walk.indices.length === 0 && empty.road.indices.length === 0 && empty.decor.indices.length === 0 );
	const g = groundPlane( 1000 );
	report( 'El suelo plano es un cuadrado', g.positions.length === 12 && g.indices.length === 6 );
	report( 'Los radios de carga están ordenados', OPEN.readyRadius < OPEN.buildRadius && OPEN.buildRadius < OPEN.showRadius && OPEN.showRadius < OPEN.dropRadius );

}

console.log( fail ? `\n${ fail } pruebas fallaron.` : '\nMapa abierto: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
