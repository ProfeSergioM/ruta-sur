// Pruebas de los encargos. Ejecutar: node tests/jobs.test.mjs
import { Geo, yawFromCompass } from '../src/geo.js';
import { buildGraph, route, RouteTracker } from '../src/osm.js';
import { cityRoadsOSM, CITY_START } from '../src/testcity.js';
import { Jobs, payFor, CARGAS } from '../src/jobs.js';
import { VEHICLES } from '../src/physics.js';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };

const geo = new Geo( - 38.739141, - 72.590355, 110 );
const g = buildGraph( cityRoadsOSM( geo ), geo );
let seed = 5; const rng = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
const truck = ( x, z, compass ) => ( { x, z, yaw: yawFromCompass( compass ), v: 0, damage: 0, cargoMass: 0 } );

// --- tarifa
{

	const a = payFor( 1000, 20000, 1 ), b = payFor( 2000, 20000, 1 ), c = payFor( 1000, 10000, 1 );
	report( 'Pago: base más distancia y más toneladas por kilómetro', a === 40000 && b === 65000 && c === 34500, `${ a }, ${ b }, ${ c }` );

}

// --- oferta, aceptación y entrega
const saved = [];
const jobs = new Jobs( { graph: g, spec: VEHICLES.articulado, rng, store: { get: () => null, set: v => saved.push( v ) } } );
const t = truck( CITY_START.x, - 1.75, CITY_START.compass );
report( 'Se ofrece un encargo alcanzable', jobs.offer( t ) && jobs.state === 'offer' && jobs.job.length >= 150, `${ jobs.job.cargo }, ${ jobs.job.mass / 1000 } t a ${ jobs.job.dest.label }, ${ jobs.job.length.toFixed( 0 ) } m, $ ${ jobs.job.pay }` );
const c = CARGAS.find( k => k.nombre === jobs.job.cargo );
report( 'La masa cae dentro del rango de la carga y bajo la carga útil', jobs.job.mass >= c.masa[ 0 ] * 1000 && jobs.job.mass <= c.masa[ 1 ] * 1000 && jobs.job.mass <= VEHICLES.articulado.maxCargo );
report( 'El pago sale de la tarifa', jobs.job.pay === payFor( jobs.job.length, jobs.job.mass, c.tarifa ) );
report( 'Sin aceptar, el camión sigue vacío', t.cargoMass === 0 && jobs.guidance( t ) === null );
jobs.accept( t );
report( 'Al aceptar, el camión queda cargado', jobs.state === 'active' && t.cargoMass === jobs.job.mass );

// indicación: la primera maniobra de la ruta
{

	const gd = jobs.guidance( t ), m = jobs.job.route.maneuvers[ 0 ];
	report( 'La indicación muestra la próxima maniobra y su distancia', gd && m && Math.abs( gd.dist - m.at ) < 2 && gd.lado === m.side, gd && `${ gd.dist.toFixed( 0 ) } m: ${ gd.texto }` );

}

// recorrer la ruta punto a punto, a 25 km/h
{

	const rt = jobs.job.route, pay = jobs.job.pay, len = jobs.job.length;
	let ev = null, time = 0;
	const dt = 0.1, speed = 6.9;
	for ( let s = 0; s <= rt.length && ! ev; s += speed * dt ) {

		let i = 0; while ( i < rt.cum.length - 2 && rt.cum[ i + 1 ] < s ) i ++;
		const f = ( s - rt.cum[ i ] ) / ( rt.cum[ i + 1 ] - rt.cum[ i ] || 1 );
		t.x = rt.points[ i ].x + ( rt.points[ i + 1 ].x - rt.points[ i ].x ) * f;
		t.z = rt.points[ i ].z + ( rt.points[ i + 1 ].z - rt.points[ i ].z ) * f;
		t.v = speed; time += dt;
		ev = jobs.update( t, dt );

	}

	report( 'En marcha no se entrega, aunque el camión pase por el destino', ev === null && jobs.state === 'active' );
	t.v = 0;
	ev = jobs.update( t, dt );
	report( 'Detenido en el destino, el encargo se entrega', ev === 'delivered' && jobs.state === 'done' && t.cargoMass === 0 );
	const bonus = Math.round( pay * 0.1 / 100 ) * 100;
	report( 'A 25 km/h de promedio se gana el bono de puntualidad', jobs.last.bonus === bonus && jobs.total === pay + bonus && jobs.entregas === 1, `${ time.toFixed( 0 ) } s para ${ len.toFixed( 0 ) } m, pago $ ${ pay } + bono $ ${ bonus }` );
	report( 'La caja se guarda', saved.length === 1 && saved[ 0 ].entregas === 1 && saved[ 0 ].total === jobs.total );
	let next = null;
	for ( let k = 0; k < 80 && ! next; k ++ ) next = jobs.update( t, 0.1 );
	report( 'Siete segundos después llega el encargo siguiente', next === 'offer' && jobs.state === 'offer' && jobs.job.folio === 2, `folio ${ jobs.job && jobs.job.folio }` );

}

// daño: descuenta hasta el 60 % del pago
{

	jobs.accept( t );
	const pay = jobs.job.pay;
	t.damage += 0.5;
	report( 'Con 50 % de daño el pago baja 30 %', jobs.currentPay( t ) === Math.round( pay * 0.7 / 100 ) * 100, `$ ${ pay } -> $ ${ jobs.currentPay( t ) }` );
	t.damage += 3;
	report( 'El descuento por daño tiene tope de 60 %', jobs.currentPay( t ) === Math.round( pay * 0.4 / 100 ) * 100, `$ ${ jobs.currentPay( t ) }` );

}

// desvío: a más de 45 m de la ruta por más de 2 s, se calcula de nuevo desde donde está el camión
{

	const before = jobs.job.route;
	const p0 = before.points[ 0 ], p1 = before.points[ 1 ];
	const dx = p1.x - p0.x, dz = p1.z - p0.z, L = Math.hypot( dx, dz );
	// el camión se va 110 m hacia atrás por la misma calle: una cuadra completa fuera de la ruta
	t.x = p0.x - dx / L * 110; t.z = p0.z - dz / L * 110; t.v = 5;
	let ev = null, n = 0;
	for ( ; n < 40 && ev !== 'rerouted'; n ++ ) ev = jobs.update( t, 0.1 );
	const after = jobs.job.route;
	report( 'Fuera de la ruta, se recalcula tras 2 s', ev === 'rerouted' && n >= 20 && n <= 22 && after !== before, `${ ( n * 0.1 ).toFixed( 1 ) } s, ruta nueva de ${ after.length.toFixed( 0 ) } m` );
	report( 'La ruta nueva parte donde está el camión', Math.hypot( after.points[ 0 ].x - t.x, after.points[ 0 ].z - t.z ) < 3 && jobs.tracker.offset < 3 );

}

// partida hacia atrás: la indicación pide dar la vuelta mientras el camión siga de espaldas a la ruta
{

	const mk = ( id, x, z ) => { const p = geo.toGeo( x, 0, z ); return { id, lat: p.lat, lon: p.lon }; };
	const N = { 5: mk( 5, 0, 300 ), 6: mk( 6, 100, 300 ) };
	const g2 = buildGraph( { elements: [ { type: 'way', id: 12, nodes: [ 5, 6 ], geometry: [ N[ 5 ], N[ 6 ] ], tags: { highway: 'residential', name: 'Calle Única', oneway: 'yes' } } ] }, geo );
	let goal = - 1; for ( let n = 0; n < g2.count; n ++ ) if ( Math.hypot( g2.x[ n ] - 100, g2.z[ n ] - 300 ) < 0.5 ) goal = n;
	const j2 = new Jobs( { graph: g2, spec: VEHICLES.articulado, rng } );
	const t2 = { x: 50, z: 300, yaw: Math.atan2( 1, 0 ), v: 0, damage: 0, cargoMass: 0 }; // rumbo (-1, 0): contra el tránsito
	const rt = route( g2, t2.x, t2.z, - Math.sin( t2.yaw ), - Math.cos( t2.yaw ), goal );
	j2.job = { folio: 1, cargo: 'Harina', mass: 10000, dest: { node: goal, x: 100, z: 300, label: 'Calle Única' }, route: rt, length: rt.length, pay: 20000, tarifa: 1 };
	j2.tracker = new RouteTracker( rt ); j2.state = 'offer'; j2.accept( t2 );
	const gd = j2.guidance( t2 );
	report( 'De espaldas a la única ruta, la indicación pide dar la vuelta', rt.reverseStart && gd && gd.lado === 'uturn' && gd.dist === null, gd && gd.texto );
	t2.yaw = Math.atan2( - 1, 0 ); // ya dio la vuelta: rumbo (+1, 0)
	const gd2 = j2.guidance( t2 );
	report( 'Con el camión ya orientado, vuelve la indicación normal', gd2 && gd2.lado === 'arrive', gd2 && `${ gd2.texto }, ${ gd2.dist.toFixed( 0 ) } m` );

}

// aceptar después de moverse: la ruta y el pago se calculan desde donde está el camión
{

	const j3 = new Jobs( { graph: g, spec: VEHICLES.articulado, rng } );
	const t3 = truck( CITY_START.x, - 1.75, CITY_START.compass );
	j3.offer( t3 );
	const before = { length: j3.job.length, pay: j3.job.pay, dest: j3.job.dest.node };
	// el camión avanza 40 m por la avenida antes de aceptar
	t3.x -= 40; j3.update( t3, 0.1 );
	const ok = j3.accept( t3 );
	report( 'Aceptar tras avanzar 40 m: ruta y pago se recalculan desde ahí', ok && j3.job.dest.node === before.dest && Math.abs( j3.job.length - ( before.length - 40 ) ) < 1 && j3.job.pay === payFor( j3.job.length, j3.job.mass, j3.job.tarifa ) && j3.job.pay < before.pay, `${ before.length.toFixed( 0 ) } m y $ ${ before.pay } -> ${ j3.job.length.toFixed( 0 ) } m y $ ${ j3.job.pay }` );

	// el camión llega al destino sin haber aceptado: el encargo se cambia por otro, sin entrega instantánea
	const j4 = new Jobs( { graph: g, spec: VEHICLES.articulado, rng } );
	const t4 = truck( CITY_START.x, - 1.75, CITY_START.compass );
	j4.offer( t4 );
	const d0 = j4.job.dest;
	t4.x = d0.x; t4.z = d0.z + 3; j4.update( t4, 0.1 );
	const ok4 = j4.accept( t4 );
	const ev = j4.update( t4, 0.1 );
	report( 'Aceptar parado en el destino no entrega: llega otro encargo', ok4 === false && j4.state === 'offer' && j4.job.dest.node !== d0.node && ev === null && j4.entregas === 0 && t4.cargoMass === 0, `nuevo destino: ${ j4.job.dest.label }` );

}

// sin destino alcanzable: no queda un encargo a medias y se reintenta solo
{

	const mk = ( id, x, z ) => { const p = geo.toGeo( x, 0, z ); return { id, lat: p.lat, lon: p.lon }; };
	// una calle corta aislada: no hay destino a más de 150 m
	const A = mk( 1, 2000, 2000 ), B = mk( 2, 2060, 2000 );
	const lonely = { type: 'way', id: 77, nodes: [ 1, 2 ], geometry: [ A, B ].map( p => ( { lat: p.lat, lon: p.lon } ) ), tags: { highway: 'residential', name: 'Calle Corta' } };
	const g5 = buildGraph( { elements: [ ...cityRoadsOSM( geo ).elements, lonely ] }, geo );
	const j5 = new Jobs( { graph: g5, spec: VEHICLES.articulado, rng } );
	const t5 = { x: 2030, z: 2000, yaw: yawFromCompass( 270 ), v: 0, damage: 0.2, cargoMass: 0 };
	const ok5 = j5.offer( t5 );
	report( 'Sin destino alcanzable no queda un encargo a medias', ok5 === false && j5.state === 'none' && j5.job === null && j5.tracker === null && j5.damage( t5 ) === 0 && j5.guidance( t5 ) === null );
	let ev = null;
	for ( let k = 0; k < 100 && ! ev; k ++ ) ev = j5.update( t5, 0.1 );
	report( 'Mientras siga aislado, los reintentos no ofrecen nada', ev === null && j5.state === 'none' );
	// el camión vuelve a la ciudad: el siguiente reintento encuentra encargo
	t5.x = CITY_START.x; t5.z = - 1.75; t5.yaw = yawFromCompass( CITY_START.compass );
	let n = 0;
	for ( ; n < 100 && ev !== 'offer'; n ++ ) ev = j5.update( t5, 0.1 );
	report( 'De vuelta en la red, el encargo llega solo en menos de 8 s', ev === 'offer' && j5.state === 'offer' && n <= 81, `${ ( n * 0.1 ).toFixed( 1 ) } s` );

}

console.log( fail ? `\n${ fail } comprobaciones fuera de lo esperado` : '\nEncargos: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
