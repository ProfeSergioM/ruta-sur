// Pruebas de semáforos y discos Pare, sin navegador. Ejecutar: node tests/signals.test.mjs
import { Geo } from '../src/geo.js';
import { buildGraph } from '../src/osm.js';
import { cityRoadsOSM, CITY_START } from '../src/testcity.js';
import { createTruck, VEHICLES } from '../src/physics.js';
import { Signals, CYCLE, PERIOD, phaseState, groupOfWay, RED_LIGHT_FINE } from '../src/signals.js';
import { Traffic, KINDS } from '../src/traffic.js';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };

const geo = new Geo( - 33.45, - 70.66, 0 );
const g = buildGraph( cityRoadsOSM( geo ), geo );
const H = 1 / 60;

// --- el ciclo
{
	let bothGreen = 0, bothRed = 0, green0 = 0, seq = [], last = null;
	for ( let t = 0; t < PERIOD; t += 0.1 ) {

		const a = phaseState( t, 0 ), b = phaseState( t, 1 );
		if ( a === 'green' && b === 'green' ) bothGreen ++;
		if ( a === 'red' && b === 'red' ) bothRed ++;
		if ( a === 'green' ) green0 ++;
		if ( a !== last ) { seq.push( a ); last = a; }

	}

	report( 'Los dos grupos nunca están en verde a la vez', bothGreen === 0 );
	report( 'Entre un verde y el otro hay un momento con todo en rojo', bothRed > 0 && Math.abs( bothRed * 0.1 - 2 * CYCLE.allRed ) < 0.3, `${ ( bothRed * 0.1 ).toFixed( 1 ) } s por ciclo` );
	report( 'El verde dura lo que dice el ciclo y la secuencia es verde, ámbar, rojo', Math.abs( green0 * 0.1 - CYCLE.green ) < 0.2 && seq.join( ',' ) === 'green,amber,red', seq.join( ',' ) );
	report( 'El ciclo da la vuelta', phaseState( PERIOD + 3, 0 ) === phaseState( 3, 0 ) && phaseState( - 1, 1 ) === phaseState( PERIOD - 1, 1 ) );
	const fake = { groups: new Map( [ [ 5, 0 ], [ 9, 1 ] ] ) };
	report( 'Las vías de este a oeste van en el grupo 0, las de norte a sur en el 1, y una vía ajena al cruce no tiene grupo', groupOfWay( fake, 5 ) === 0 && groupOfWay( fake, 9 ) === 1 && groupOfWay( fake, 3 ) === - 1 );
}

// --- cruces de la ciudad de pruebas
const S = new Signals( g );
report( 'La ciudad de pruebas tiene cruces con semáforo (avenida con avenida) y con Pare (calle con avenida)', S.lights > 0 && S.stops > 0, `${ S.lights } semáforos, ${ S.stops } Pare` );
report( 'Cada semáforo reparte dos vías principales o más; cada Pare tiene una principal y calles menores', S.crossings.every( c => c.kind === 'light' ? c.majorIds.length >= 2 : c.majorIds.length === 1 && c.minorIds.length > 0 ) );
report( 'En cada semáforo las vías principales quedan en los dos grupos (se cruzan)', S.crossings.filter( c => c.kind === 'light' ).every( c => new Set( c.majorIds.map( id => c.groups.get( id ) ) ).size === 2 ) );
report( 'Los cruces quedan ligados a los nodos del grafo', S.byNode.size >= S.crossings.length, `${ S.byNode.size } nodos` );
const light = S.crossings.find( c => c.kind === 'light' ), stop = S.crossings.find( c => c.kind === 'stop' );
report( 'Un Pare deja pasar a la principal y detiene a la menor', S.ruleFor( stop, stop.majorIds[ 0 ], 0 ) === 'go' && S.ruleFor( stop, stop.minorIds[ 0 ], 0 ) === 'stop' );

// arista que entra a un cruce por una de sus vías
function incoming( cr, wayIds ) {

	let node = - 1;
	for ( const [ n, c ] of S.byNode ) if ( c === cr ) { node = n; break; }
	for ( let e = 0; e < g.from.length; e ++ ) if ( g.to[ e ] === node && wayIds.includes( g.ways[ g.wayOf[ e ] ].id ) && g.len[ e ] > 20 ) return { e, node };
	return null;

}

// instante en que el grupo de `wayId` está en rojo y lo seguirá por `hold` segundos
function redTime( cr, wayId, hold = 10 ) {

	for ( let t = 0; t < PERIOD; t += 0.1 ) if ( S.state( cr, wayId, t ) === 'red' && S.state( cr, wayId, t + hold ) === 'red' ) return t;
	return null;

}

// --- el tráfico se detiene en rojo y sigue en verde
{
	const t = createTruck( VEHICLES.rigido, { x: light.x + 160, z: light.z + 160, yaw: 0 } ); // el camión aparte, fuera del cruce: no interviene
	const T = new Traffic( { graph: g, count: 0, signals: S } );
	const wayId = light.majorIds[ 0 ], inc = incoming( light, [ wayId ] );
	report( 'Hay una arista de 20 m o más que entra al semáforo por su primera vía', !! inc, inc && `${ g.len[ inc.e ].toFixed( 1 ) } m` );
	const K = KINDS.auto;
	const v = { id: 1, kind: 'auto', K, color: [ 1, 1, 1 ], x: 0, z: 0, y: 0, yaw: 0, v: 10, stun: 0, hit: 0, hitCool: 0, since: 0, stopWait: 0, passedNode: - 1, groundT: 0, mesh: null, half: K.length / 2, halfW: K.width / 2, brakingFor: 0 };
	T._place( v, inc.e, 1 ); T.vehicles.push( v );
	T.time = redTime( light, wayId, 12 );
	let minRemaining = Infinity;
	for ( let i = 0; i < 10 * 60; i ++ ) { T.step( t, H ); if ( v.edge === inc.e ) minRemaining = Math.min( minRemaining, g.len[ inc.e ] - v.s ); }
	report( 'Con luz roja el auto frena y queda en la línea de detención', v.edge === inc.e && v.v < 0.05 && minRemaining > light.stopBack - 1 && minRemaining < light.stopBack + 1.5, `a ${ minRemaining.toFixed( 1 ) } m del centro (línea a ${ light.stopBack.toFixed( 1 ) } m), ${ ( v.v * 3.6 ).toFixed( 1 ) } km/h, ${ T.waiting } esperando` );
	// avanza el reloj hasta el verde
	let waited = 0;
	while ( S.state( light, wayId, T.time ) !== 'green' && waited < PERIOD ) { T.step( t, H ); waited += H; }
	for ( let i = 0; i < 8 * 60 && v.edge === inc.e; i ++ ) T.step( t, H );
	report( 'Con luz verde cruza', v.edge !== inc.e && v.v > 2, `${ ( v.v * 3.6 ).toFixed( 0 ) } km/h tras esperar ${ waited.toFixed( 1 ) } s` );
	// ámbar lejos: alcanza a frenar; ámbar encima: sigue
	const w2 = { ...v, id: 2, v: 10, stopWait: 0, passedNode: - 1 };
	T.vehicles = [ w2 ]; T._place( w2, inc.e, 1 );
	let amber = null; for ( let τ = 0; τ < PERIOD; τ += 0.1 ) if ( S.state( light, wayId, τ ) === 'amber' && S.state( light, wayId, τ - 0.1 ) === 'green' ) { amber = τ; break; }
	T.time = amber;
	for ( let i = 0; i < 6 * 60; i ++ ) T.step( t, H );
	report( 'Si el ámbar lo encuentra lejos, se detiene', w2.edge === inc.e && w2.v < 0.05 );
	const w3 = { ...v, id: 3, v: 12, stopWait: 0, passedNode: - 1 };
	T.vehicles = [ w3 ]; T._place( w3, inc.e, g.len[ inc.e ] - light.stopBack - 2 );
	T.time = amber;
	for ( let i = 0; i < 3 * 60 && w3.edge === inc.e; i ++ ) T.step( t, H );
	report( 'Si el ámbar lo encuentra encima de la línea, sigue', w3.edge !== inc.e );
}

// --- Pare: se detiene un segundo y sigue
{
	const t = createTruck( VEHICLES.rigido, { x: stop.x + 160, z: stop.z + 160, yaw: 0 } );
	const T = new Traffic( { graph: g, count: 0, signals: S } );
	const inc = incoming( stop, stop.minorIds );
	report( 'Hay una arista de 20 m o más que llega al Pare por la calle menor', !! inc );
	const K = KINDS.auto;
	const v = { id: 9, kind: 'auto', K, color: [ 1, 1, 1 ], x: 0, z: 0, y: 0, yaw: 0, v: 8, stun: 0, hit: 0, hitCool: 0, since: 0, stopWait: 0, passedNode: - 1, groundT: 0, mesh: null, half: K.length / 2, halfW: K.width / 2, brakingFor: 0 };
	T._place( v, inc.e, 1 ); T.vehicles.push( v );
	let stoppedAt = null, stoppedFor = 0, crossedAt = null;
	for ( let i = 0; i < 30 * 60; i ++ ) {

		T.step( t, H );
		if ( v.edge === inc.e && v.v < 0.15 ) { if ( stoppedAt === null ) stoppedAt = g.len[ inc.e ] - v.s; stoppedFor += H; }
		if ( v.edge !== inc.e ) { crossedAt = i * H; break; }

	}

	report( 'Ante el Pare se detiene en la línea, espera un segundo y sigue', stoppedAt !== null && Math.abs( stoppedAt - stop.stopBack ) < 1.5 && stoppedFor >= 0.9 && stoppedFor < 3 && crossedAt !== null, `detenido ${ stoppedFor.toFixed( 1 ) } s a ${ stoppedAt && stoppedAt.toFixed( 1 ) } m del centro; cruza a los ${ crossedAt && crossedAt.toFixed( 1 ) } s` );
	// por la avenida no se detiene
	const inc2 = incoming( stop, stop.majorIds );
	const w = { ...v, id: 10, v: 10, stopWait: 0, passedNode: - 1 };
	T.vehicles = [ w ]; T._place( w, inc2.e, 1 );
	let minV = Infinity;
	for ( let i = 0; i < 12 * 60 && w.edge === inc2.e; i ++ ) { T.step( t, H ); minV = Math.min( minV, w.v ); }
	report( 'Por la avenida pasa el Pare sin frenar', w.edge !== inc2.e && minV > 2.5, `mínimo ${ ( minV * 3.6 ).toFixed( 0 ) } km/h` );
}

// --- el camión y la luz roja
{
	const wayId = light.majorIds[ 0 ], inc = incoming( light, [ wayId ] );
	const e = inc.e, ux = g.ux[ e ], uz = g.uz[ e ];
	const drive = ( time, speed, from = 30 ) => {

		const t = createTruck( VEHICLES.rigido, { x: light.x - ux * from, z: light.z - uz * from, yaw: Math.atan2( - ux, - uz ) } );
		t.v = speed;
		const S2 = new Signals( g );
		let hits = 0, crossings = 0;
		for ( let i = 0; i < 10 * 60; i ++ ) {

			t.x += ux * t.v * H; t.z += uz * t.v * H;
			const r = S2.watch( t, time + i * H );
			if ( r === 'red' ) hits ++;
			if ( r !== null ) crossings ++;

		}

		return { hits, crossings };

	};

	const red = redTime( light, wayId, 12 ), green = ( () => { for ( let τ = 0; τ < PERIOD; τ += 0.1 ) if ( S.state( light, wayId, τ ) === 'green' && S.state( light, wayId, τ + 8 ) === 'green' ) return τ; } )();
	report( 'Cruzar la línea con luz roja a 30 km/h se anota una sola vez', drive( red, 30 / 3.6 ).hits === 1, JSON.stringify( drive( red, 30 / 3.6 ) ) );
	report( 'Con luz verde no hay multa', drive( green, 30 / 3.6 ).hits === 0 );
	report( 'Detenido ante la luz roja no hay multa', drive( red, 0 ).hits === 0 );
	report( 'La multa por luz roja es mayor que la de chocar un auto', RED_LIGHT_FINE > 20000 );
}

console.log( fail ? `\n${ fail } pruebas fallaron.` : '\nSemáforos: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
