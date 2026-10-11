// Pruebas de los peatones, sin navegador. Ejecutar: node tests/pedestrians.test.mjs
import { Geo } from '../src/geo.js';
import { buildGraph, nearestSegment } from '../src/osm.js';
import { cityRoadsOSM, CITY_START } from '../src/testcity.js';
import { createTruck, VEHICLES } from '../src/physics.js';
import { Pedestrians, PED } from '../src/pedestrians.js';
import { Traffic, KINDS, boxGap } from '../src/traffic.js';
import { ROAD_WIDTH } from '../src/openmap.js';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };
const rngOf = seed => { let a = seed | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul( a ^ a >>> 15, 1 | a ); t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t; return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296; }; };

const geo = new Geo( - 33.45, - 70.66, 0 );
const g = buildGraph( cityRoadsOSM( geo ), geo );
const H = 1 / 60;
const truckAt = () => createTruck( VEHICLES.reparto, { x: CITY_START.x, z: CITY_START.z, yaw: Math.PI - CITY_START.compass * Math.PI / 180 } );

// --- aparecen en las veredas y caminan
{
	const t = truckAt();
	const P = new Pedestrians( { graph: g, rng: rngOf( 4 ), count: 14 } );
	for ( let i = 0; i < 120; i ++ ) P.step( t, H );
	report( 'En dos segundos hay tantos peatones como pide el cupo', P.list.length === 14, `${ P.list.length }` );
	const dists = P.list.map( p => Math.hypot( p.x - t.x, p.z - t.z ) );
	report( 'Aparecen cerca del camión, sin pegarse a él', Math.min( ...dists ) >= PED.spawnMin - 3 && Math.max( ...dists ) <= PED.spawnMax, `${ Math.min( ...dists ).toFixed( 0 ) } a ${ Math.max( ...dists ).toFixed( 0 ) } m` );
	// sobre la vereda: a medio ancho de calzada más el corrimiento del eje de su calle
	let onSidewalk = 0, samples = 0, maxErr = 0;
	for ( const p of P.list ) {

		if ( p.crossing || p.s < 6 || p.s > g.len[ p.edge ] - 6 ) continue; // en una esquina el tramo más cercano puede ser el de la otra calle
		const s = nearestSegment( g, p.x, p.z, 20 );
		if ( ! s ) continue;
		samples ++;
		const want = ( ROAD_WIDTH[ s.way.highway ] || 5 ) / 2 + PED.offset;
		maxErr = Math.max( maxErr, Math.abs( s.dist - want ) );
		if ( Math.abs( s.dist - want ) < 0.3 ) onSidewalk ++;

	}

	report( 'Caminan por la vereda, a la distancia de la solera que corresponde', samples >= 6 && onSidewalk === samples, `${ onSidewalk } de ${ samples }, desvío máximo ${ maxErr.toFixed( 2 ) } m` );
	const before = P.list.map( p => ( { id: p.id, x: p.x, z: p.z } ) );
	for ( let i = 0; i < 30 * 60; i ++ ) P.step( t, H );
	const moved = P.list.filter( p => { const b = before.find( q => q.id === p.id ); return b && Math.hypot( p.x - b.x, p.z - b.z ) > 15; } ).length;
	report( 'En 30 s se movieron decenas de metros', moved >= Math.min( 8, P.list.length - 2 ), `${ moved } de ${ P.list.length }` );
	report( 'Alguno cruzó una calle por una esquina', P.crossings > 0, `${ P.crossings } cruces` );
	const speeds = P.list.map( p => p.speed );
	report( 'Caminan entre 1 y 1,6 m/s, cada uno a su paso', Math.min( ...speeds ) >= PED.speedMin && Math.max( ...speeds ) <= PED.speedMax && new Set( speeds ).size > 3 );
	report( 'Sin atropellos con el camión detenido', P.hits === 0 );
}

// --- el tráfico frena ante un peatón que cruza
{
	const t = createTruck( VEHICLES.reparto, { x: CITY_START.x + 160, z: CITY_START.z + 160, yaw: 0 } );
	const P = new Pedestrians( { graph: g, rng: rngOf( 1 ), count: 0 } );
	const T = new Traffic( { graph: g, rng: rngOf( 2 ), count: 0, pedestrians: P } );
	const car = T.spawnAhead( truckAt(), 10 ); car.stun = 0; car.v = 11;
	// un peatón cruza la calle 25 m por delante del auto, de un lado al otro, despacio
	const fx = - Math.sin( car.yaw ), fz = - Math.cos( car.yaw ), rx = Math.cos( car.yaw ), rz = - Math.sin( car.yaw );
	const cx = car.x + fx * 25, cz = car.z + fz * 25;
	const p = { id: 99, side: 1, speed: 0.9, x: cx + rx * 5, z: cz + rz * 5, y: 0, yaw: 0, edge: car.edge, s: 0, crossing: { x0: cx + rx * 5, z0: cz + rz * 5, x1: cx - rx * 5, z1: cz - rz * 5, t: 0, len: 10 }, hit: 0, hitCool: 0, phase: 0, mesh: null, half: PED.half, halfW: PED.half, groundT: 0, tall: 1.7 };
	P.list.push( p );
	let minV = Infinity, minGap = Infinity, crossedAt = null;
	for ( let i = 0; i < 12 * 60; i ++ ) {

		P.step( t, H ); T.step( t, H );
		if ( p.crossing ) { minGap = Math.min( minGap, boxGap( car, p ) ); minV = Math.min( minV, car.v ); } else if ( crossedAt === null ) crossedAt = i * H;

	}

	report( 'El auto frena ante el peatón que cruza y no lo toca', minGap > 0.5 && minV < 1, `brecha mínima ${ minGap.toFixed( 1 ) } m, mínimo ${ ( minV * 3.6 ).toFixed( 0 ) } km/h` );
	report( 'Cuando el peatón termina de cruzar, el auto sigue', crossedAt !== null && car.v > 3, `cruzó a los ${ crossedAt && crossedAt.toFixed( 1 ) } s, luego ${ ( car.v * 3.6 ).toFixed( 0 ) } km/h` );
}

// --- atropello
{
	const t = truckAt();
	const P = new Pedestrians( { graph: g, rng: rngOf( 7 ), count: 0 } );
	// un peatón parado en la calle, 12 m por delante del camión
	const fx = - Math.sin( t.yaw ), fz = - Math.cos( t.yaw );
	const p = { id: 5, side: 1, speed: 0, x: t.x + fx * 12, z: t.z + fz * 12, y: 0, yaw: 0, edge: 0, s: 0, crossing: { x0: t.x + fx * 12, z0: t.z + fz * 12, x1: t.x + fx * 12, z1: t.z + fz * 12, t: 0, len: 1e9 }, hit: 0, hitCool: 0, phase: 0, mesh: null, half: PED.half, halfW: PED.half, groundT: 0, tall: 1.7 };
	P.list.push( p );
	t.v = 20 / 3.6;
	let hit = 0, hits = 0;
	for ( let i = 0; i < 5 * 60; i ++ ) { t.x += fx * t.v * H; t.z += fz * t.v * H; const ev = P.step( t, H ); if ( ev.hit > 0 ) { hits ++; hit = Math.max( hit, ev.hit ); } }
	report( 'El camión a 20 km/h atropella al peatón: una vez, con su velocidad de cierre', hits === 1 && Math.abs( hit * 3.6 - 20 ) < 2 && P.hits === 1, `${ ( hit * 3.6 ).toFixed( 1 ) } km/h, ${ hits } veces` );
	report( 'El peatón vuelve a la vereda y deja de cruzar', ! p.crossing && Math.hypot( p.x - t.x, p.z - t.z ) > 1.5 );
	const P2 = new Pedestrians( { graph: g, rng: rngOf( 7 ), count: 0 } );
	P2.list.push( { ...p, crossing: { ...p.crossing }, x: t.x + fx * 6, z: t.z + fz * 6, hitCool: 0 } );
	let ghost = 0;
	for ( let i = 0; i < 3 * 60; i ++ ) { t.x += fx * t.v * H; t.z += fz * t.v * H; ghost += P2.step( t, H, false ).hit; }
	report( 'Con los choques desactivados no hay atropello', ghost === 0 && P2.hits === 0 );
	report( 'La multa por atropello es la mayor de todas', PED.fine > 40000 );
}

console.log( fail ? `\n${ fail } pruebas fallaron.` : '\nPeatones: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
