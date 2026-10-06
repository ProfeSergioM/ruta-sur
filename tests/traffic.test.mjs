// Pruebas del tráfico, sin navegador. Ejecutar: node tests/traffic.test.mjs
import { Geo } from '../src/geo.js';
import { buildGraph, nearestSegment } from '../src/osm.js';
import { cityRoadsOSM, CITY_START } from '../src/testcity.js';
import { createTruck, VEHICLES } from '../src/physics.js';
import { Traffic, TRAFFIC, KINDS, boxGap, laneOffset, truckBodies } from '../src/traffic.js';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };
const rngOf = seed => { let a = seed | 0; return () => { a = a + 0x6D2B79F5 | 0; let t = Math.imul( a ^ a >>> 15, 1 | a ); t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t; return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296; }; };

const geo = new Geo( - 33.45, - 70.66, 0 );
const g = buildGraph( cityRoadsOSM( geo ), geo );
const H = 1 / 60;

// --- cajas en planta
{
	const a = { x: 0, z: 0, yaw: 0, half: 2, halfW: 1 }, b = { x: 0, z: - 10, yaw: 0, half: 2, halfW: 1 }, n = {};
	report( 'Dos cajas alineadas y separadas: la brecha es la distancia menos los largos', Math.abs( boxGap( a, b, n ) - 6 ) < 1e-9 && Math.abs( n.nz + 1 ) < 1e-9, `${ boxGap( a, b ).toFixed( 2 ) } m, normal (${ n.nx.toFixed( 2 ) }, ${ n.nz.toFixed( 2 ) })` );
	const c = { x: 0, z: - 3.5, yaw: 0, half: 2, halfW: 1 };
	report( 'Si se traslapan, la brecha es negativa y mide la penetración', Math.abs( boxGap( a, c ) + 0.5 ) < 1e-9, `${ boxGap( a, c ).toFixed( 2 ) } m` );
	const d = { x: 2.3, z: 0, yaw: Math.PI / 2, half: 2, halfW: 1 };
	report( 'Una caja girada 90° a 2,3 m de costado no toca (1 + 2 = 3 > 2,3): sí toca', boxGap( a, d ) < 0, `${ boxGap( a, d ).toFixed( 2 ) } m` );
	const e = { x: 3.2, z: 0, yaw: Math.PI / 2, half: 2, halfW: 1 };
	report( 'Y a 3,2 m queda libre por 0,2 m', Math.abs( boxGap( a, e ) - 0.2 ) < 1e-9, `${ boxGap( a, e ).toFixed( 2 ) } m` );
	const f = { x: 3, z: - 3, yaw: Math.PI / 4, half: 2, halfW: 1 };
	report( 'Una caja a 45° en diagonal: la brecha sale por el eje de la girada', boxGap( a, f ) > 0 && boxGap( a, f ) < 2, `${ boxGap( a, f ).toFixed( 2 ) } m` );
}

// --- el camión como cajas
{
	const t = createTruck( VEHICLES.articulado, { x: 10, z: 20, yaw: 0 } );
	const B = truckBodies( t );
	report( 'El tracto con semirremolque son dos cajas; el camión rígido, una', B.length === 2 && truckBodies( createTruck( VEHICLES.rigido ) ).length === 1 );
	const tr = VEHICLES.articulado.tractor, tl = VEHICLES.articulado.trailer;
	report( 'El tracto mide del parachoques al fin del chasis', Math.abs( B[ 0 ].half * 2 - ( tr.wheelbase + tr.frontOverhang + tr.rearOverhang ) ) < 1e-9 && Math.abs( B[ 0 ].halfW * 2 - tr.width ) < 1e-9 );
	report( 'El semirremolque mide su largo y queda detrás del tracto', Math.abs( B[ 1 ].half * 2 - tl.length ) < 1e-9 && B[ 1 ].z > B[ 0 ].z, `tracto en z ${ B[ 0 ].z.toFixed( 1 ) }, remolque en z ${ B[ 1 ].z.toFixed( 1 ) }` );
	report( 'Mirando a -Z, el frente del tracto está en z menor que el eje trasero', B[ 0 ].z - B[ 0 ].half < t.z );
}

report( 'En una calle de dos sentidos se circula corrido a la derecha; en una de un sentido, por el eje', laneOffset( { oneway: 0, rank: 5, width: 7 } ) === 1.5 && laneOffset( { oneway: 1, rank: 5, width: 7 } ) === 0 && laneOffset( { oneway: 0, rank: 3, width: 14 } ) === 1.8 );

// --- vehículos sobre la red
{
	const t = createTruck( VEHICLES.rigido, { x: CITY_START.x, z: CITY_START.z, yaw: Math.PI - CITY_START.compass * Math.PI / 180 } );
	const T = new Traffic( { graph: g, rng: rngOf( 3 ), count: 16 } );
	report( 'Hay aristas donde aparecer', T._edges.length > 100, `${ T._edges.length } aristas` );
	for ( let i = 0; i < 120; i ++ ) T.step( t, H );
	report( 'En dos segundos el tráfico llega a su cupo', T.vehicles.length === 16, `${ T.vehicles.length } vehículos` );
	const dists = T.vehicles.map( v => Math.hypot( v.x - t.x, v.z - t.z ) );
	report( 'Todos aparecen lejos del camión, pero no demasiado (en dos segundos algunos ya se acercaron)', dists.every( d => d >= TRAFFIC.spawnMin - 25 && d <= TRAFFIC.spawnMax ), `${ Math.min( ...dists ).toFixed( 0 ) } a ${ Math.max( ...dists ).toFixed( 0 ) } m` );
	const kinds = new Set( T.vehicles.map( v => v.kind ) );
	report( 'Hay más de un tipo de vehículo', kinds.size >= 2, [ ...kinds ].join( ', ' ) );
	// 40 s de circulación
	const before = T.vehicles.map( v => ( { id: v.id, x: v.x, z: v.z } ) );
	let maxOff = 0, minGap = Infinity, maxV = 0, wrongWay = 0;
	for ( let i = 0; i < 40 * 60; i ++ ) {

		T.step( t, H );
		if ( i % 30 ) continue;
		for ( const v of T.vehicles ) {

			const s = nearestSegment( g, v.x, v.z, 30 );
			maxOff = Math.max( maxOff, s ? s.dist : 99 );
			maxV = Math.max( maxV, v.v );
			// sentido: el rumbo acompaña a la arista que recorre, y en una vía de un sentido esa arista va con la vía
			if ( - Math.sin( v.yaw ) * g.ux[ v.edge ] - Math.cos( v.yaw ) * g.uz[ v.edge ] < 0.999 ) wrongWay ++;
			if ( v.way.oneway === 1 && ! v.way.fwd.includes( v.edge ) ) wrongWay ++;
			for ( const o of T.vehicles ) {

				if ( o === v ) continue;
				const gap = boxGap( v, o );
				if ( gap < minGap ) minGap = gap;

			}

		}

	}

	const moved = T.vehicles.filter( v => { const b = before.find( p => p.id === v.id ); return ! b || Math.hypot( v.x - b.x, v.z - b.z ) > 20; } );
	report( 'Tras 40 s, los vehículos se movieron por las calles', moved.length >= T.vehicles.length * 0.8, `${ moved.length } de ${ T.vehicles.length }` );
	report( 'Nunca se salen de la calzada (a lo más el corrimiento de carril)', maxOff <= 2.0, `desvío máximo ${ maxOff.toFixed( 2 ) } m` );
	report( 'Respetan los límites: nunca más de 54 km/h', maxV * 3.6 <= 54.1, `${ ( maxV * 3.6 ).toFixed( 0 ) } km/h` );
	report( 'Siempre en el sentido de su arista, y nunca contra el tránsito en una vía de un sentido', wrongWay === 0, `${ wrongWay } muestras` );
	report( 'Nunca se montan uno sobre otro', minGap > 0, `brecha mínima ${ minGap.toFixed( 2 ) } m` );
	report( 'Sin choques contra el camión detenido lejos', T.hits === 0 );
}

// --- frenan ante el camión y chocan si el camión los embiste
{
	const t = createTruck( VEHICLES.rigido, { x: CITY_START.x, z: CITY_START.z, yaw: Math.PI - CITY_START.compass * Math.PI / 180 } );
	const T = new Traffic( { graph: g, rng: rngOf( 5 ), count: 0 } );
	const v = T.spawnAhead( t, 40 );
	report( 'Se puede dejar un auto 40 m por delante del camión, en su calle', !! v && Math.abs( Math.hypot( v.x - t.x, v.z - t.z ) - 40 ) < 6, v && `${ Math.hypot( v.x - t.x, v.z - t.z ).toFixed( 1 ) } m` );
	// un segundo auto, más atrás, que viene a 50 km/h: debe frenar detrás del detenido
	const w = T.spawnAhead( t, 12 ); w.stun = 0; w.v = 14;
	let minGap = Infinity;
	for ( let i = 0; i < 8 * 60; i ++ ) { T.step( t, H ); minGap = Math.min( minGap, boxGap( w, v ) ); }
	report( 'Un auto a 50 km/h frena y queda detrás del detenido, sin tocarlo', minGap > 0.5 && w.v < 0.1 && minGap < TRAFFIC.gap + 1, `brecha ${ minGap.toFixed( 1 ) } m, ${ ( w.v * 3.6 ).toFixed( 0 ) } km/h` );
	// el camión avanza a 30 km/h y embiste al auto detenido
	v.stun = 1e9; w.drop = true; T._purge();
	t.v = 30 / 3.6;
	let hit = 0, hitAt = 0;
	for ( let i = 0; i < 6 * 60; i ++ ) {

		t.x += - Math.sin( t.yaw ) * t.v * H; t.z += - Math.cos( t.yaw ) * t.v * H;
		const ev = T.step( t, H );
		if ( ev.hit > hit ) { hit = ev.hit; hitAt = i * H; }

	}

	report( 'El camión a 30 km/h choca al auto detenido: velocidad de cierre de 30 km/h', Math.abs( hit * 3.6 - 30 ) < 2 && hitAt > 2 && hitAt < 5, `${ ( hit * 3.6 ).toFixed( 1 ) } km/h a los ${ hitAt.toFixed( 1 ) } s` );
	report( 'El choque se cuenta una vez y el auto queda aturdido', T.hits === 1 && v.hit === 1 && v.stun > 0 );
	report( 'El auto queda fuera del camión, empujado', boxGap( truckBodies( t )[ 0 ], v ) >= - 0.05, `brecha ${ boxGap( truckBodies( t )[ 0 ], v ).toFixed( 2 ) } m` );
	// sin choques activos, el camión atraviesa y no hay evento
	const T2 = new Traffic( { graph: g, rng: rngOf( 5 ), count: 0 } );
	const t2 = createTruck( VEHICLES.rigido, { x: CITY_START.x, z: CITY_START.z, yaw: Math.PI - CITY_START.compass * Math.PI / 180 } );
	T2.spawnAhead( t2, 20 ); t2.v = 30 / 3.6;
	let ghostHit = 0;
	for ( let i = 0; i < 5 * 60; i ++ ) { t2.x += - Math.sin( t2.yaw ) * t2.v * H; t2.z += - Math.cos( t2.yaw ) * t2.v * H; ghostHit = Math.max( ghostHit, T2.step( t2, H, false ).hit ); }
	report( 'Con los choques desactivados no hay evento', ghostHit === 0 && T2.hits === 0 );
}

// --- aturdido y de vuelta
{
	const t = createTruck( VEHICLES.rigido, { x: CITY_START.x, z: CITY_START.z, yaw: Math.PI - CITY_START.compass * Math.PI / 180 } );
	const T = new Traffic( { graph: g, rng: rngOf( 9 ), count: 0 } );
	const v = T.spawnAhead( t, 30 ); v.stun = TRAFFIC.stunned;
	for ( let i = 0; i < 2 * 60; i ++ ) T.step( t, H );
	const stillStopped = v.v === 0;
	for ( let i = 0; i < 6 * 60; i ++ ) T.step( t, H );
	report( 'Tras el choque el auto espera unos segundos y luego sigue su camino', stillStopped && v.v > 3, `${ ( v.v * 3.6 ).toFixed( 0 ) } km/h a los 8 s` );
	T.clearNear( v.x, v.z, 10 );
	report( 'clearNear saca los vehículos cercanos a un punto', T.vehicles.length === 0 );
	T.enabled = false;
	for ( let i = 0; i < 60; i ++ ) T.step( t, H );
	report( 'Desactivado, no aparece nadie', T.vehicles.length === 0 );
	report( 'Los tipos tienen medidas y masas plausibles', KINDS.auto.length < KINDS.camioneta.length && KINDS.camioneta.length < KINDS.micro.length && KINDS.micro.mass > 5000 );
}

console.log( fail ? `\n${ fail } pruebas fallaron.` : '\nTráfico: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
