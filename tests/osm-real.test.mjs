// Prueba de la red vial con datos reales: el centro de Temuco, tal como lo
// entrega Overpass a la consulta del juego (radio de 350 m en torno a la Plaza
// Aníbal Pinto). La muestra se bajó desde un navegador el 4 de octubre de 2026;
// está en tests/fixtures/temuco-centro.json. © OpenStreetMap contributors, ODbL.
// Ejecutar: node tests/osm-real.test.mjs
import { readFileSync } from 'node:fs';
import { Geo } from '../src/geo.js';
import { buildGraph, route, RouteTracker, pickDestination, spawnPoint, maneuverText, turnReach, matchSegment } from '../src/osm.js';
import { Jobs } from '../src/jobs.js';
import { VEHICLES } from '../src/physics.js';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };
const osm = JSON.parse( readFileSync( new URL( './fixtures/temuco-centro.json', import.meta.url ), 'utf8' ) );
const geo = new Geo( - 38.739141, - 72.590355, 0 );
const g = buildGraph( osm, geo );
let seed = 7; const rng = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

// --- la respuesta real tiene la forma que el juego espera
report( 'Cada vía trae sus nodos, su geometría y sus etiquetas', osm.elements.length === 61 && osm.elements.every( e => Array.isArray( e.nodes ) && Array.isArray( e.geometry ) && e.nodes.length === e.geometry.length && e.tags && e.tags.highway ) );
const inMain = g.main.reduce( ( a, b ) => a + b, 0 );
const junctions = [ ...g.degree ].filter( d => d >= 3 ).length;
report( 'Grafo del centro de Temuco', g.count === 365 && g.ways.length === 61 && g.x.every( Number.isFinite ) && g.len.every( Number.isFinite ), `${ g.count } nodos, ${ g.ways.length } vías, ${ g.from.length } tramos dirigidos, ${ junctions } cruces` );
report( 'Todas las calles del centro son de un sentido', g.ways.every( w => w.oneway !== 0 ) && g.from.length === g.rev.filter( r => r < 0 ).length );
report( 'La red principal deja fuera los tramos que salen de la muestra sin retorno', inMain > 180 && inMain < g.count, `${ inMain } de ${ g.count } nodos` );
const short = [ ...g.len ].filter( l => l < 8 ).length;
console.log( `info  Tramos de menos de 8 m (pasos de peatones y líneas de detención junto a cada cruce): ${ short } de ${ g.len.length }` );

// --- aparición en la plaza
const PLAZA = new Set( [ 'Arturo Prat', 'Claro Solar', 'Manuel Bulnes', 'Antonio Varas' ] );
const sp = spawnPoint( g, 0, 0, Math.PI );
const hx = - Math.sin( sp.yaw ), hz = - Math.cos( sp.yaw );
{

	const m = matchSegment( g, sp.x, sp.z, hx, hz );
	const legal = ( m.dx * hx + m.dz * hz ) * m.way.oneway > 0;
	report( 'Pedir la Plaza Aníbal Pinto deja el camión en una de las cuatro calles que la rodean, en el sentido del tránsito', PLAZA.has( sp.way.name ) && Math.hypot( sp.x, sp.z ) < 120 && legal && m.dist < 0.5, `${ sp.way.name }, a ${ Math.hypot( sp.x, sp.z ).toFixed( 0 ) } m del centro de la plaza` );

}

// --- destinos y encargo
{

	const labels = new Set();
	let bad = 0, n = 0;
	for ( let k = 0; k < 120; k ++ ) {

		const d = pickDestination( g, sp.x, sp.z, hx, hz, 250, 900, rng );
		if ( ! d ) continue;
		n ++; labels.add( d.label );
		if ( ! g.main[ d.node ] || ! route( g, sp.x, sp.z, hx, hz, d.node ) ) bad ++;

	}

	report( 'Destinos: esquinas reales, alcanzables y con retorno', n > 100 && bad === 0 && [ ...labels ].every( l => / con /.test( l ) ), `${ labels.size } esquinas distintas; por ejemplo ${ [ ...labels ].slice( 0, 3 ).join( ' | ' ) }` );
	const jobs = new Jobs( { graph: g, spec: VEHICLES.articulado, rng } );
	const t = { x: sp.x, z: sp.z, yaw: sp.yaw, v: 0, damage: 0, cargoMass: 0 };
	const ok = jobs.offer( t );
	report( 'Se ofrece un encargo desde la plaza', ok && jobs.job.length >= 150, ok && `${ jobs.job.cargo } a ${ jobs.job.dest.label }, ${ jobs.job.length.toFixed( 0 ) } m: ${ jobs.job.route.maneuvers.map( maneuverText ).join( ' · ' ) }` );

}

// --- rutas desde posiciones al azar, en el sentido del tránsito
{

	let routes = 0, none = 0, reverse = 0, uturns = 0, illegal = 0, early = 0, earliest = Infinity, trackWorst = 0, turns = 0, merges = 0, forced = 0;
	for ( let k = 0; k < 600; k ++ ) {

		const w = g.ways[ Math.floor( rng() * g.ways.length ) ], i = Math.floor( rng() * ( w.nodes.length - 1 ) ), a = w.nodes[ i ], b = w.nodes[ i + 1 ], f = rng();
		if ( ! g.main[ a ] || ! g.main[ b ] ) continue;
		let dx = g.x[ b ] - g.x[ a ], dz = g.z[ b ] - g.z[ a ]; const L = Math.hypot( dx, dz ); if ( L < 0.5 ) continue;
		dx = dx / L * w.oneway; dz = dz / L * w.oneway;
		const px = g.x[ a ] + ( g.x[ b ] - g.x[ a ] ) * f, pz = g.z[ a ] + ( g.z[ b ] - g.z[ a ] ) * f;
		let goal; do { goal = Math.floor( rng() * g.count ); } while ( ! g.main[ goal ] );
		const speed = rng() < 0.5 ? 0 : 8;
		const r = route( g, px, pz, dx, dz, goal, speed );
		if ( ! r ) { none ++; continue; }
		routes ++; if ( r.reverseStart ) reverse ++;
		for ( let j = 0; j < r.edges.length - 1; j ++ ) { if ( r.edges[ j + 1 ] === g.rev[ r.edges[ j ] ] ) uturns ++; if ( g.to[ r.edges[ j ] ] !== g.from[ r.edges[ j + 1 ] ] ) illegal ++; }
		turns += r.maneuvers.length;
		// un giro con alternativas no puede quedar más cerca que la distancia mínima
		const m = r.maneuvers[ 0 ];
		if ( r.earlyTurn ) forced ++;
		else if ( m && m.at < turnReach( speed ) - 0.01 ) {

			const e1 = r.edges[ r.nodes.indexOf( m.node ) ];
			if ( g.adj[ m.node ].filter( e => e !== g.rev[ e1 ] ).length > 1 ) { early ++; earliest = Math.min( earliest, m.at ); } else merges ++;

		}

		// seguimiento con el camión a 1,5 m del eje
		const tr = new RouteTracker( r ), lateral = ( rng() - 0.5 ) * 3;
		for ( let s = 0; s <= r.length; s += 0.5 ) {

			let j = 0; while ( j < r.cum.length - 2 && r.cum[ j + 1 ] < s ) j ++;
			const Ls = r.cum[ j + 1 ] - r.cum[ j ]; if ( Ls < 1e-6 ) continue;
			const fr = ( s - r.cum[ j ] ) / Ls, ux = ( r.points[ j + 1 ].x - r.points[ j ].x ) / Ls, uz = ( r.points[ j + 1 ].z - r.points[ j ].z ) / Ls;
			tr.update( r.points[ j ].x + ux * Ls * fr - uz * lateral, r.points[ j ].z + uz * Ls * fr + ux * lateral, ux, uz );
			trackWorst = Math.max( trackWorst, Math.abs( tr.along - s ) );

		}

	}

	report( 'Rutas entre puntos de la red principal: todas existen', routes > 350 && none === 0, `${ routes } rutas` );
	report( 'Ninguna pide invertir la marcha ni circular contra el tránsito', reverse === 0 && uturns === 0 && illegal === 0, `${ reverse } partidas hacia atrás, ${ uturns } vueltas en U` );
	report( 'Ningún giro con alternativas queda más cerca que la distancia mínima (8 m detenido, 24 m a 29 km/h)', early === 0, early ? `${ early } casos, el más cercano a ${ earliest.toFixed( 1 ) } m` : `${ forced } rutas doblan antes porque seguir derecho saca al camión de la muestra` );
	report( 'Seguimiento de las rutas con el camión hasta 1,5 m del eje', trackWorst < 6, `error máximo ${ trackWorst.toFixed( 1 ) } m` );
	console.log( `info  Indicaciones por ruta: ${ ( turns / routes ).toFixed( 1 ) } en promedio` );

}

console.log( fail ? `\n${ fail } comprobaciones fuera de lo esperado` : '\nRed real: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
