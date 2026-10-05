// Pruebas de la red vial y de la ciudad de pruebas. Ejecutar: node tests/osm.test.mjs
import { Geo, yawFromCompass } from '../src/geo.js';
import { buildGraph, nearestSegment, matchSegment, route, RouteTracker, pickDestination, spawnPoint, maneuverText, searchEdges, startEdges, overpassQuery, TURN_COST } from '../src/osm.js';
import { generateCity, cityRoadsOSM, buildRegion, cityChunks, groundHeight, baseHeight, surfaceAt, CITY, CITY_START } from '../src/testcity.js';
import { overpassAnswer } from './overpass-mock.mjs';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };

const geo = new Geo( - 38.739141, - 72.590355, 110 );
const osm = cityRoadsOSM( geo );
const g = buildGraph( osm, geo );

report( 'Vías leídas', g.ways.length === 14, g.ways.length );
report( 'Nodos del grafo', g.count === 7 * 7 + 2 * 7 * 6 * 3, g.count );

// los nodos vuelven a su lugar tras pasar por latitud y longitud
let maxErr = 0;
for ( const w of g.ways ) for ( const n of w.nodes ) {

	const onNS = Math.abs( g.x[ n ] / CITY.pitch - Math.round( g.x[ n ] / CITY.pitch ) ) * CITY.pitch;
	const onEW = Math.abs( g.z[ n ] / CITY.pitch - Math.round( g.z[ n ] / CITY.pitch ) ) * CITY.pitch;
	maxErr = Math.max( maxErr, Math.min( onNS, onEW ) );

}

report( 'Error de posición de los nodos tras la conversión geográfica', maxErr < 0.02, ( maxErr * 100 ).toFixed( 2 ) + ' cm' );

// --- la consulta y la forma real de la respuesta ------------------------------
// El servicio responde según el nivel de detalle pedido. Con "out tags geom" las
// vías llegan sin su lista de nodos; el juego pide "body" y, por si acaso,
// reconoce los cruces también por coordenadas.
{

	const query = overpassQuery( - 38.739141, - 72.590355, 2500 );
	const real = overpassAnswer( query, osm );
	const gr = buildGraph( real, geo );
	report( 'La consulta pide los nodos de cada vía (nivel body) y su geometría', /out\s+body\s+geom/.test( query ) && real.elements.every( e => Array.isArray( e.nodes ) && Array.isArray( e.geometry ) && e.tags ), ( query.match( /^out[^;]*;/m ) || [ '' ] )[ 0 ] );
	report( 'Con la respuesta que da el servicio a esa consulta, el grafo queda completo', gr.count === g.count && gr.ways.length === g.ways.length && gr.from.length === g.from.length, `${ gr.count } nodos, ${ gr.ways.length } vías` );
	// la forma que rompía el juego: geometría sin lista de nodos
	const bare = overpassAnswer( '[out:json];way(1);out tags geom;', osm );
	const gb = buildGraph( bare, geo );
	let sameDegree = gb.count === g.count;
	if ( sameDegree ) for ( let n = 0; n < g.count; n ++ ) if ( gb.degree[ n ] !== g.degree[ n ] ) sameDegree = false;
	report( 'Una respuesta sin lista de nodos también arma el grafo: los cruces se reconocen por coordenadas', bare.elements.every( e => e.nodes === undefined ) && sameDegree && gb.from.length === g.from.length, `${ gb.count } nodos, ${ gb.from.length } aristas` );
	// puntos sin coordenadas dentro de una vía
	const holes = { elements: [ { type: 'way', id: 1, nodes: [ 1, 2, 3, 4 ], geometry: [ osm.elements[ 0 ].geometry[ 0 ], null, {}, osm.elements[ 0 ].geometry[ 1 ] ], tags: { highway: 'residential' } } ] };
	const gh = buildGraph( holes, geo );
	report( 'Los puntos sin coordenadas se omiten sin dejar valores inválidos', gh.count === 2 && gh.len.every( Number.isFinite ) && gh.x.every( Number.isFinite ), `${ gh.count } nodos, largo ${ gh.len[ 0 ].toFixed( 1 ) } m` );

}

// etiquetas de velocidad y de acceso
{

	const p0 = osm.elements[ 0 ].geometry[ 0 ], p1 = osm.elements[ 0 ].geometry[ 1 ];
	const one = tags => buildGraph( { elements: [ { type: 'way', id: 1, nodes: [ 1, 2 ], geometry: [ p0, p1 ], tags: { highway: 'residential', ...tags } } ] }, geo );
	const speed = v => one( { maxspeed: v } ).ways[ 0 ].maxspeed;
	const got = [ '50', '30 mph', 'CL:urban', 'signals', '30;50', '0', '-10', '120 km/h', undefined ].map( speed );
	report( 'Velocidad máxima: números, millas por hora y valores sin número', JSON.stringify( got ) === JSON.stringify( [ 50, 48, 50, 50, 50, 50, 50, 120, 50 ] ), got.join( ', ' ) );
	const kept = tags => one( tags ).ways.length === 1;
	const acc = [ kept( { access: 'no' } ), kept( { access: 'private' } ), kept( { hgv: 'no' } ), kept( { vehicle: 'no' } ), kept( { motor_vehicle: 'no' } ), kept( { access: 'no', hgv: 'yes' } ), kept( { access: 'no', motor_vehicle: 'yes' } ), kept( { access: 'destination' } ), kept( {} ) ];
	report( 'Acceso: decide la etiqueta más específica para un camión', JSON.stringify( acc ) === JSON.stringify( [ false, false, false, false, false, true, true, true, true ] ), acc.map( v => v ? 'pasa' : 'no' ).join( ', ' ) );

}

// tramo más cercano
const s = nearestSegment( g, CITY_START.x, CITY_START.z );
report( 'El punto de partida cae sobre la Avenida Alameda', s && s.way.name === 'Avenida Alameda' && s.dist < 4, s && `${ s.way.name }, a ${ s.dist.toFixed( 1 ) } m` );

// sentido único: "1 Oriente" (i = 4) solo se recorre en un sentido
const w1 = g.ways.find( w => w.name === '1 Oriente' );
report( '1 Oriente es de sentido único', w1.oneway !== 0, w1.oneway );
{

	const a = w1.nodes[ 4 ], b = w1.nodes[ 8 ];
	const fromNode = n => g.adj[ n ].map( e => ( { edge: e, cost: g.cost[ e ] } ) );
	const fwd = searchEdges( g, fromNode( a ), b ).nodeDist[ b ];
	const back = searchEdges( g, fromNode( b ), a ).nodeDist[ a ];
	const direct = Math.hypot( g.x[ a ] - g.x[ b ], g.z[ a ] - g.z[ b ] ) * w1.costFactor;
	const along = w1.oneway > 0 ? fwd : back, against = w1.oneway > 0 ? back : fwd;
	report( 'A favor del sentido, el costo es el tramo directo', Math.abs( along - direct ) < 0.01, along.toFixed( 1 ) );
	report( 'En contra del sentido hay que dar la vuelta a la manzana', against > direct * 2, against.toFixed( 1 ) );

}

// ruta con giro: del punto de partida (mirando al este) a una esquina del noreste
const yaw = yawFromCompass( CITY_START.compass );
const hx = - Math.sin( yaw ), hz = - Math.cos( yaw );
const goalNode = g.ways.find( w => w.name === '2 Norte' ).nodes.find( n => Math.abs( g.x[ n ] + 220 ) < 1 );
const rt = route( g, CITY_START.x, CITY_START.z, hx, hz, goalNode );
report( 'Hay ruta al destino', !! rt, rt && `${ rt.length.toFixed( 0 ) } m, ${ rt.maneuvers.length } maniobras` );
if ( rt ) {

	// destino en (-220, 220): 280 m al este y 220 m al norte del punto de partida
	report( 'Largo de la ruta coherente con la grilla', rt.length >= 495 && rt.length < 900, rt.length.toFixed( 1 ) + ' m' );
	report( 'La ruta parte hacia el este (el rumbo del camión)', rt.points[ 1 ].x < rt.points[ 0 ].x, `${ rt.points[ 0 ].x.toFixed( 0 ) } -> ${ rt.points[ 1 ].x.toFixed( 0 ) }` );
	const m = rt.maneuvers[ 0 ];
	report( 'Primera maniobra: giro a la izquierda (del este al norte)', m && m.side === 'left', m && maneuverText( m ) );
	// respeta los sentidos únicos: cada arista existe en el grafo dirigido
	let okDir = true;
	for ( let i = 0; i < rt.nodes.length - 1; i ++ ) if ( ! g.adj[ rt.nodes[ i ] ].some( e => g.to[ e ] === rt.nodes[ i + 1 ] ) ) okDir = false;
	report( 'La ruta respeta los sentidos de tránsito', okDir );

	const tr = new RouteTracker( rt );
	tr.update( rt.points[ 0 ].x - 50, rt.points[ 0 ].z + 1.5 );
	report( 'Seguimiento: avance sobre la ruta', Math.abs( tr.along - 50 ) < 1 && Math.abs( tr.offset - 1.5 ) < 0.1, `avance ${ tr.along.toFixed( 1 ) } m, desvío ${ tr.offset.toFixed( 1 ) } m` );
	report( 'Seguimiento: próxima maniobra por delante', tr.next() === rt.maneuvers[ 0 ] );

}

// un camión que mira al oeste no debe recibir una ruta que le pida invertir la marcha en la avenida
{

	const yawW = yawFromCompass( 270 );
	const r2 = route( g, CITY_START.x, 3.2, - Math.sin( yawW ), - Math.cos( yawW ), goalNode );
	report( 'Mirando al oeste, la ruta parte hacia el oeste', r2 && r2.points[ 1 ].x > r2.points[ 0 ].x, r2 && `${ r2.length.toFixed( 0 ) } m` );

}

// --- un camión no gira en U -------------------------------------------------
const reversals = rt => { let n = 0; for ( let i = 0; i < rt.edges.length - 1; i ++ ) if ( rt.edges[ i + 1 ] === g.rev[ rt.edges[ i ] ] ) n ++; return n; };
const junctionDist = ( x, z ) => { let d = Infinity; for ( let n = 0; n < g.count; n ++ ) if ( g.degree[ n ] >= 3 ) d = Math.min( d, Math.hypot( g.x[ n ] - x, g.z[ n ] - z ) ); return d; };

// el caso que falló en la prueba de extremo a extremo: el camión parte en plena
// intersección, por la pista derecha de la avenida norte-sur y mirando al norte
{

	const yawN = yawFromCompass( 0 ), nx = - Math.sin( yawN ), nz = - Math.cos( yawN );
	const m = matchSegment( g, - 1.75, 0, nx, nz );
	const plain = nearestSegment( g, - 1.75, 0 );
	report( 'En un cruce, el tramo más cercano es el de la calle que se cruza', plain.way.name === 'Avenida Alameda', `${ plain.way.name }, a ${ plain.dist.toFixed( 2 ) } m` );
	report( 'Con el rumbo, el camión queda asignado a la calle por la que va', m.way.name === 'Avenida Estación', `${ m.way.name }, a ${ m.dist.toFixed( 2 ) } m` );
	const goal = g.ways.find( w => w.name === '3 Poniente' ).nodes.find( n => Math.abs( g.z[ n ] + 220 ) < 1 );
	const r = route( g, - 1.75, 0, nx, nz, goal );
	const p0 = r.points[ 0 ], p1 = r.points[ 1 ];
	// el destino queda al suroeste, pero el camión ya está dentro del cruce: sigue al norte y dobla en la cuadra siguiente
	const m0 = r.maneuvers[ 0 ];
	report( 'Desde el cruce, la ruta parte en el sentido del camión', ! r.reverseStart && p1.z > p0.z + 1 && Math.abs( p1.x - p0.x ) < 0.5 && m0 && m0.at > 100, `primer tramo (${ p0.x.toFixed( 1 ) }, ${ p0.z.toFixed( 1 ) }) -> (${ p1.x.toFixed( 1 ) }, ${ p1.z.toFixed( 1 ) }), ${ maneuverText( m0 ) } a ${ m0.at.toFixed( 0 ) } m` );
	report( 'La ruta da la vuelta a la manzana en lugar de girar en U', reversals( r ) === 0 && r.maneuvers.every( m => m.kind !== 'uturn' ), `${ r.length.toFixed( 0 ) } m, maniobras: ${ r.maneuvers.map( m => m.side === 'left' ? 'izq' : 'der' ).join( ', ' ) }` );

}

// muestreo: posiciones, rumbos y destinos al azar sobre la grilla
{

	let seed = 11; const rng = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	let n = 0, rev = 0, revStart = 0, none = 0, extra = 0, worst = 0, turns = 0;
	for ( let k = 0; k < 400; k ++ ) {

		const w = g.ways[ Math.floor( rng() * g.ways.length ) ];
		const i = Math.floor( rng() * ( w.nodes.length - 1 ) ), t = rng();
		const a = w.nodes[ i ], b = w.nodes[ i + 1 ];
		let dx = g.x[ b ] - g.x[ a ], dz = g.z[ b ] - g.z[ a ]; const L = Math.hypot( dx, dz ); dx /= L; dz /= L;
		const dir = w.oneway !== 0 ? w.oneway : ( rng() < 0.5 ? 1 : - 1 );
		const hx2 = dx * dir, hz2 = dz * dir;
		const off = w.oneway === 0 ? 1.75 : 0;
		const px = g.x[ a ] + ( g.x[ b ] - g.x[ a ] ) * t - hz2 * off, pz = g.z[ a ] + ( g.z[ b ] - g.z[ a ] ) * t + hx2 * off;
		const goal = Math.floor( rng() * g.count );
		const r = route( g, px, pz, hx2, hz2, goal );
		if ( ! r ) { none ++; continue; }
		n ++; rev += reversals( r ); if ( r.reverseStart ) revStart ++;
		turns += r.maneuvers.length;
		// referencia: la distancia más corta si el camión pudiera girar sobre su eje
		const free = searchEdges( g, g.adj[ a ].concat( g.adj[ b ] ).map( e => ( { edge: e, cost: 0 } ) ), goal ).nodeDist[ goal ];
		const more = r.length - free; extra += Math.max( 0, more ); worst = Math.max( worst, more );

	}

	report( 'Muestreo de 400 rutas: todas existen', none === 0 && n === 400, `${ n } rutas` );
	report( 'Muestreo: ninguna ruta invierte la marcha', rev === 0 && revStart === 0, `${ rev } vueltas en U, ${ revStart } partidas hacia atrás` );
	console.log( `info  Costo de respetar el rumbo: ${ ( extra / n ).toFixed( 0 ) } m más por ruta en promedio, ${ worst.toFixed( 0 ) } m en el peor caso; ${ ( turns / n ).toFixed( 1 ) } giros por ruta` );

}

// un giro necesita distancia: con el cruce encima, la ruta lo cruza derecho y dobla más adelante
{

	const goal = g.ways.find( w => w.name === 'Avenida Estación' ).nodes.find( n => Math.abs( g.z[ n ] - 110 ) < 1 );
	const first = r => r.maneuvers[ 0 ];
	const near = route( g, 5, - 1.75, hx, hz, goal );          // 5 m antes del cruce, detenido
	report( 'A 5 m del cruce, la ruta sigue derecho y dobla en la cuadra siguiente', near && ! near.reverseStart && reversals( near ) === 0 && first( near ).at > 100, near && `${ near.length.toFixed( 0 ) } m, primer giro a ${ first( near ).at.toFixed( 0 ) } m` );
	const far = route( g, 12, - 1.75, hx, hz, goal );          // 12 m antes, detenido
	report( 'A 12 m del cruce y detenido, la ruta dobla en ese cruce', far && Math.abs( first( far ).at - 12 ) < 0.5 && Math.abs( far.length - 122 ) < 0.5, far && `${ far.length.toFixed( 0 ) } m, primer giro a ${ first( far ).at.toFixed( 0 ) } m` );
	const fast = route( g, 12, - 1.75, hx, hz, goal, 8.33 );   // 12 m antes, a 30 km/h
	report( 'A 12 m del cruce y a 30 km/h, la ruta sigue derecho', fast && first( fast ).at > 100, fast && `${ fast.length.toFixed( 0 ) } m, primer giro a ${ first( fast ).at.toFixed( 0 ) } m` );
	const corner = g.ways.find( w => w.name === 'Avenida Estación' ).nodes.find( n => Math.abs( g.z[ n ] ) < 1 );
	const here = route( g, 5, - 1.75, hx, hz, corner );
	report( 'Si el destino es el cruce que está delante, la ruta llega directo', here && Math.abs( here.length - 5 ) < 0.1 && here.maneuvers.length === 0, here && `${ here.length.toFixed( 1 ) } m` );
	// calle que termina en T a 5 m: no hay cómo seguir derecho, así que el giro se permite
	const edgeGoal = g.ways.find( w => w.name === '3 Oriente' ).nodes.find( n => Math.abs( g.z[ n ] - 110 ) < 1 );
	const tee = route( g, - 325, - 1.75, hx, hz, edgeGoal );
	report( 'En una T a 5 m, la ruta dobla porque la calle no continúa', tee && ! tee.reverseStart && reversals( tee ) === 0 && Math.abs( first( tee ).at - 5 ) < 0.5, tee && `${ tee.length.toFixed( 0 ) } m, ${ maneuverText( first( tee ) ) } a ${ first( tee ).at.toFixed( 0 ) } m` );

}

// la primera esquina también se anuncia (antes se omitía la maniobra en el primer nodo de la ruta)
{

	const goal = g.ways.find( w => w.name === 'Avenida Estación' ).nodes.find( n => Math.abs( g.z[ n ] - 110 ) < 1 );
	const r = route( g, 15, - 1.75, hx, hz, goal ); // 15 m antes del cruce, mirando al este
	const m = r && r.maneuvers[ 0 ];
	report( 'Una esquina a 15 m del punto de partida se anuncia', m && Math.abs( m.at - 15 ) < 0.5 && m.side === 'left', m && `${ maneuverText( m ) } a ${ m.at.toFixed( 1 ) } m` );

}

// fondo de saco: la única salida es volver, y la ruta lo dice
{

	const mk = ( id, x, z ) => { const p = geo.toGeo( x, 0, z ); return { id, lat: p.lat, lon: p.lon }; };
	const N = { 1: mk( 1, 0, 0 ), 2: mk( 2, 100, 0 ), 3: mk( 3, 200, 0 ), 4: mk( 4, 100, 80 ), 5: mk( 5, 0, 300 ), 6: mk( 6, 100, 300 ) };
	const way = ( id, name, ids ) => ( { type: 'way', id, nodes: ids, geometry: ids.map( i => ( { lat: N[ i ].lat, lon: N[ i ].lon } ) ), tags: { highway: 'residential', name } } );
	const oneWay = way( 12, 'Calle Única', [ 5, 6 ] ); oneWay.tags.oneway = 'yes';
	const g2 = buildGraph( { elements: [ way( 10, 'Calle Larga', [ 1, 2, 3 ] ), way( 11, 'Pasaje Corto', [ 2, 4 ] ), oneWay ] }, geo );
	const node = ( x, z ) => { for ( let n = 0; n < g2.count; n ++ ) if ( Math.hypot( g2.x[ n ] - x, g2.z[ n ] - z ) < 0.5 ) return n; return - 1; };
	// camión dentro del pasaje, mirando hacia el fondo
	const r = route( g2, 100, 40, 0, 1, node( 200, 0 ) );
	report( 'Fondo de saco: hay ruta y avisa que hay que dar la vuelta', r && r.maneuvers.some( m => m.kind === 'uturn' ) && ! r.reverseStart, r && `${ r.length.toFixed( 0 ) } m: ${ r.maneuvers.map( maneuverText ).join( ' · ' ) }` );
	// camión en la calle larga, de espaldas al destino y sin manzana que rodear: sigue hasta el final de la calle y vuelve
	const r2 = route( g2, 50, 0, - 1, 0, node( 200, 0 ) );
	report( 'Sin manzana que rodear, la ruta sigue hasta el final de la calle y vuelve', r2 && ! r2.reverseStart && Math.abs( r2.length - 250 ) < 0.5 && r2.maneuvers[ 0 ].kind === 'uturn' && Math.abs( r2.maneuvers[ 0 ].at - 50 ) < 0.5, r2 && `${ r2.length.toFixed( 0 ) } m, ${ maneuverText( r2.maneuvers[ 0 ] ) } a ${ r2.maneuvers[ 0 ].at.toFixed( 0 ) } m` );
	// camión contra el tránsito en una calle de un sentido: la única ruta parte hacia atrás y queda marcada
	const r3 = route( g2, 50, 300, - 1, 0, node( 100, 300 ) );
	report( 'Contra el tránsito en una calle de un sentido, la ruta queda marcada como partida hacia atrás', r3 && r3.reverseStart && Math.abs( r3.length - 50 ) < 0.5, r3 && `${ r3.length.toFixed( 0 ) } m, reverseStart = ${ r3.reverseStart }` );

}

// destinos
{

	let seed = 3; const rng = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	let ok = 0, minD = Infinity, maxD = 0, labels = new Set();
	for ( let i = 0; i < 40; i ++ ) {

		const d = pickDestination( g, CITY_START.x, CITY_START.z, hx, hz, 250, 600, rng );
		if ( ! d ) continue;
		const r = route( g, CITY_START.x, CITY_START.z, hx, hz, d.node );
		if ( r ) { ok ++; minD = Math.min( minD, r.length ); maxD = Math.max( maxD, r.length ); labels.add( d.label ); }

	}

	report( 'Destinos generados y alcanzables', ok === 40, `${ ok } de 40, rutas de ${ minD.toFixed( 0 ) } a ${ maxD.toFixed( 0 ) } m` );
	report( 'Los destinos se nombran por su esquina', [ ...labels ].every( l => / con /.test( l ) ), [ ...labels ].slice( 0, 3 ).join( ' | ' ) );

}

// punto de aparición
{

	const sp = spawnPoint( g, 40, 37 );
	report( 'Aparición: se ajusta a la calle más cercana', sp && Math.hypot( sp.x - 40, sp.z - 37 ) < 60, sp && `(${ sp.x.toFixed( 1 ) }, ${ sp.z.toFixed( 1 ) }) en ${ sp.way.name }` );
	// pedir el centro exacto de un cruce: el camión aparece a media cuadra y alineado con su calle
	const yawN = yawFromCompass( 0 );
	const sc = spawnPoint( g, 0, 0, yawN );
	const jd = junctionDist( sc.x, sc.z );
	const fx = - Math.sin( sc.yaw ), fz = - Math.cos( sc.yaw );
	const ms = matchSegment( g, sc.x, sc.z, fx, fz );
	const al = Math.abs( ( ms.dx * fx + ms.dz * fz ) / Math.hypot( ms.dx, ms.dz ) );
	report( 'Aparición pedida en un cruce: queda a media cuadra', jd >= 18 && jd <= 60, `(${ sc.x.toFixed( 1 ) }, ${ sc.z.toFixed( 1 ) }) en ${ sc.way.name }, a ${ jd.toFixed( 1 ) } m del cruce` );
	report( 'Aparición: alineado con la calle y por la pista derecha', ms.way === sc.way && al > 0.999 && Math.abs( ms.dist - 1.75 ) < 0.01, `alineación ${ al.toFixed( 4 ) }, a ${ ms.dist.toFixed( 2 ) } m del eje` );
	// la derecha del avance: con rumbo (fx, fz) y +X al oeste, es (-fz, fx)
	const side = ( sc.x - ms.x ) * - fz + ( sc.z - ms.z ) * fx;
	report( 'Aparición: la pista elegida está a la derecha del avance', side > 1.7, side.toFixed( 2 ) + ' m' );
	let bad = 0, minJ = Infinity;
	for ( let k = 0; k < 200; k ++ ) {

		const px = ( ( k * 37 ) % 661 ) - 330, pz = ( ( k * 101 ) % 661 ) - 330;
		const q = spawnPoint( g, px, pz, yawN );
		const d = junctionDist( q.x, q.z );
		minJ = Math.min( minJ, d );
		const qx = - Math.sin( q.yaw ), qz = - Math.cos( q.yaw );
		const r = route( g, q.x, q.z, qx, qz, goalNode );
		if ( d < 18 || ! r || r.reverseStart ) bad ++;

	}

	report( 'Aparición desde 200 puntos de la ciudad: siempre a media cuadra y con ruta hacia adelante', bad === 0, `distancia mínima a un cruce ${ minJ.toFixed( 1 ) } m` );

}

report( 'Consulta Overpass', /around:2500,-38\.739141,-72\.590355/.test( overpassQuery( - 38.739141, - 72.590355, 2500 ) ) );

// --- tramos sin retorno --------------------------------------------------------
// Una vía de un sentido que sale de la ciudad: se puede entrar, pero no volver.
{

	const mk = ( id, x, z ) => { const p = geo.toGeo( x, 0, z ); return { id, lat: p.lat, lon: p.lon }; };
	const corner = g.ways.find( w => w.name === 'Avenida Alameda' ).nodes.find( n => Math.abs( g.x[ n ] + 330 ) < 1 ); // extremo este de la avenida
	const cp = geo.toGeo( g.x[ corner ], 0, g.z[ corner ] );
	const spur = { type: 'way', id: 9001, nodes: [ 700001, 700002, 700003 ], geometry: [ { lat: cp.lat, lon: cp.lon }, mk( 0, - 500, 0 ), mk( 0, - 700, 0 ) ].map( p => ( { lat: p.lat, lon: p.lon } ) ), tags: { highway: 'primary', name: 'Salida', oneway: 'yes' } };
	// el primer nodo de la salida es el mismo nodo de la esquina (mismo id que usa la ciudad de pruebas)
	const cornerId = osm.elements.find( e => e.tags.name === 'Avenida Alameda' ).nodes.find( ( id, i, arr ) => { const q = osm.elements.find( e => e.tags.name === 'Avenida Alameda' ).geometry[ i ]; const w = geo.toWorld( q.lat, q.lon, geo.h0 ); return Math.abs( w.x + 330 ) < 1; } );
	spur.nodes[ 0 ] = cornerId;
	const g3 = buildGraph( { elements: [ ...osm.elements, spur ] }, geo );
	const far = [];
	for ( let n = 0; n < g3.count; n ++ ) if ( g3.x[ n ] < - 400 ) far.push( n );
	report( 'La salida de un sentido queda fuera de la red principal', far.length === 2 && far.every( n => g3.main[ n ] === 0 ) && g3.main.reduce( ( a, b ) => a + b, 0 ) === g3.count - 2, `${ far.length } nodos sin retorno de ${ g3.count }` );
	let seed = 9; const rng = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	let onSpur = 0, total = 0;
	for ( let i = 0; i < 300; i ++ ) {

		// camión en el extremo este de la avenida, mirando hacia la salida
		const d = pickDestination( g3, - 300, - 1.75, - 1, 0, 250, 900, rng );
		if ( ! d ) continue;
		total ++; if ( g3.x[ d.node ] < - 400 ) onSpur ++;

	}

	report( 'Ningún destino cae en un tramo sin retorno', total > 250 && onSpur === 0, `${ total } destinos, ${ onSpur } en la salida` );
	const sp = spawnPoint( g3, - 600, 0, yawFromCompass( 90 ) );
	report( 'La aparición prefiere una calle con retorno, aunque otra quede más cerca', sp && sp.way.name !== 'Salida', sp && `${ sp.way.name } (${ sp.x.toFixed( 0 ) }, ${ sp.z.toFixed( 0 ) })` );

}

// --- rotondas: una indicación con el número de la salida ---------------------------
{

	const mk = ( x, z ) => { const p = geo.toGeo( x, 0, z ); return { lat: p.lat, lon: p.lon }; };
	const R = 15, K = 8, ringIds = [], ringGeo = [];
	// sentido antihorario visto desde arriba (tránsito por la derecha). Con +X al oeste, el ángulo crece hacia el este.
	for ( let k = 0; k < K; k ++ ) { const a = - Math.PI / 2 + 2 * Math.PI * k / K; ringIds.push( 100 + k ); ringGeo.push( mk( - R * Math.cos( a ), R * Math.sin( a ) ) ); }
	ringIds.push( ringIds[ 0 ] ); ringGeo.push( ringGeo[ 0 ] );
	const arm = ( id, name, k, x, z ) => ( { type: 'way', id, nodes: [ 100 + k, id * 10 ], geometry: [ ringGeo[ k ], mk( x, z ) ], tags: { highway: 'secondary', name } } );
	const gr = buildGraph( { elements: [
		{ type: 'way', id: 50, nodes: ringIds, geometry: ringGeo, tags: { highway: 'secondary', junction: 'roundabout', name: 'Rotonda' } },
		arm( 51, 'Sur', 0, 0, - 120 ), arm( 52, 'Este', 2, - 120, 0 ), arm( 53, 'Norte', 4, 0, 120 ), arm( 54, 'Oeste', 6, 120, 0 ),
	] }, geo );
	const node = ( x, z ) => { for ( let n = 0; n < gr.count; n ++ ) if ( Math.hypot( gr.x[ n ] - x, gr.z[ n ] - z ) < 0.5 ) return n; return - 1; };
	const texts = [ [ - 120, 0 ], [ 0, 120 ], [ 120, 0 ] ].map( ( [ x, z ] ) => { const r = route( gr, 0, - 100, 0, 1, node( x, z ) ); return r ? r.maneuvers.map( maneuverText ).join( ' | ' ) : 'sin ruta'; } );
	report( 'Rotonda: primera salida', texts[ 0 ] === 'En la rotonda, toma la 1.ª salida por Este | Sal de la rotonda por Este', texts[ 0 ] );
	report( 'Rotonda: segunda salida', texts[ 1 ] === 'En la rotonda, toma la 2.ª salida por Norte | Sal de la rotonda por Norte', texts[ 1 ] );
	report( 'Rotonda: tercera salida', texts[ 2 ] === 'En la rotonda, toma la 3.ª salida por Oeste | Sal de la rotonda por Oeste', texts[ 2 ] );

}

// --- seguimiento sobre rutas que pasan dos veces por el mismo lugar ----------------
{

	// vuelta a la manzana: la ruta cruza su propia partida
	const mk = ( id, x, z ) => { const p = geo.toGeo( x, 0, z ); return { id, lat: p.lat, lon: p.lon }; };
	const N = { 1: mk( 1, 0, - 60 ), 2: mk( 2, 0, 0 ), 3: mk( 3, 0, 100 ), 4: mk( 4, - 100, 100 ), 5: mk( 5, - 100, 0 ), 6: mk( 6, 60, 0 ) };
	const way = ( id, name, ids, tags = {} ) => ( { type: 'way', id, nodes: ids, geometry: ids.map( i => ( { lat: N[ i ].lat, lon: N[ i ].lon } ) ), tags: { highway: 'residential', name, ...tags } } );
	const gc = buildGraph( { elements: [ way( 1, 'NS', [ 1, 2, 3 ], { oneway: 'yes' } ), way( 2, 'Norte', [ 3, 4 ], { oneway: 'yes' } ), way( 3, 'Este', [ 4, 5 ], { oneway: 'yes' } ), way( 4, 'EO', [ 5, 2, 6 ], { oneway: 'yes' } ) ] }, geo );
	const goal = ( () => { for ( let n = 0; n < gc.count; n ++ ) if ( Math.hypot( gc.x[ n ] - 60, gc.z[ n ] ) < 0.5 ) return n; return - 1; } )();
	const r = route( gc, 0, - 5, 0, 1, goal );
	report( 'Vuelta a la manzana: la ruta pasa dos veces por el cruce de partida', r && Math.abs( r.length - 465 ) < 1 && r.points.filter( p => Math.hypot( p.x, p.z ) < 0.5 ).length === 2, r && `${ r.length.toFixed( 0 ) } m` );
	let worst = 0, worstOff = 0;
	for ( const lateral of [ 0, 1.5, - 1.5 ] ) {

		const tr = new RouteTracker( r );
		for ( let s = 0; s <= r.length; s += 0.5 ) {

			let i = 0; while ( i < r.cum.length - 2 && r.cum[ i + 1 ] < s ) i ++;
			const a = r.points[ i ], b = r.points[ i + 1 ], L = r.cum[ i + 1 ] - r.cum[ i ], f = ( s - r.cum[ i ] ) / L;
			const ux = ( b.x - a.x ) / L, uz = ( b.z - a.z ) / L;
			// camión desplazado hacia un lado de la ruta, con su rumbo
			tr.update( a.x + ( b.x - a.x ) * f - uz * lateral, a.z + ( b.z - a.z ) * f + ux * lateral, ux, uz );
			worst = Math.max( worst, Math.abs( tr.along - s ) ); worstOff = Math.max( worstOff, tr.offset );

		}

	}

	// en una esquina, un camión desplazado 1,5 m proyecta hasta 3 m antes o después del vértice
	report( 'El avance no salta a la segunda pasada, con el camión a 1,5 m del eje', worst <= 3.5 && worstOff < 3, `error máximo ${ worst.toFixed( 1 ) } m, desvío máximo ${ worstOff.toFixed( 1 ) } m` );

	// fondo de saco: ida y vuelta por la misma calle
	const N2 = { 1: mk( 1, 0, 0 ), 2: mk( 2, 100, 0 ), 3: mk( 3, 200, 0 ) };
	const gd = buildGraph( { elements: [ { type: 'way', id: 1, nodes: [ 1, 2, 3 ], geometry: [ N2[ 1 ], N2[ 2 ], N2[ 3 ] ].map( p => ( { lat: p.lat, lon: p.lon } ) ), tags: { highway: 'residential', name: 'Calle Larga' } } ] }, geo );
	const end = ( () => { for ( let n = 0; n < gd.count; n ++ ) if ( Math.abs( gd.x[ n ] - 200 ) < 0.5 ) return n; return - 1; } )();
	const r2 = route( gd, 60, 0, - 1, 0, end ); // de espaldas al destino: sigue hasta el fondo y vuelve
	const tr = new RouteTracker( r2 );
	let w2 = 0;
	for ( let s = 0; s <= r2.length; s += 0.5 ) {

		let i = 0; while ( i < r2.cum.length - 2 && r2.cum[ i + 1 ] < s ) i ++;
		const a = r2.points[ i ], b = r2.points[ i + 1 ], L = r2.cum[ i + 1 ] - r2.cum[ i ], f = ( s - r2.cum[ i ] ) / L;
		tr.update( a.x + ( b.x - a.x ) * f, a.z + ( b.z - a.z ) * f, ( b.x - a.x ) / L, ( b.z - a.z ) / L );
		w2 = Math.max( w2, Math.abs( tr.along - s ) );

	}

	report( 'Ida y vuelta por la misma calle: el rumbo distingue la ida de la vuelta', r2 && Math.abs( r2.length - 260 ) < 1 && w2 < 1, `ruta de ${ r2.length.toFixed( 0 ) } m, error máximo ${ w2.toFixed( 2 ) } m` );

	// atajo: el camión deja la ruta y la retoma más adelante
	const tr3 = new RouteTracker( r );
	tr3.update( 0, - 5, 0, 1 ); tr3.update( 0, 0, 0, 1 );
	for ( let x = 0; x >= - 100; x -= 0.5 ) tr3.update( x, 0, - 1, 0 ); // se va derecho al este por una calle que la ruta recorre al final y en sentido contrario
	const lost = tr3.offset;
	for ( let z = 0; z <= 30; z += 0.5 ) tr3.update( - 100, z, 0, 1 );   // ...y dobla por donde la ruta baja
	report( 'Fuera de la ruta el desvío crece, sin saltar a un tramo que la ruta recorre en sentido contrario', lost > 45, `desvío ${ lost.toFixed( 0 ) } m (con más de 45 m el juego recalcula)` );
	// atajo de verdad: el camión corta por fuera de la red y retoma la ruta más adelante, en el sentido correcto
	const tr4 = new RouteTracker( r );
	tr4.update( 0, - 5, 0, 1 ); tr4.update( 0, 30, 0, 1 );
	const d45 = Math.SQRT1_2;
	for ( let k = 0; k <= 70; k += 0.5 ) tr4.update( - k * d45, 30 + k * d45, - d45, d45 );  // en diagonal hacia la calle Norte
	for ( let x = - 50; x >= - 70; x -= 0.5 ) tr4.update( x, 100, - 1, 0 );               // ya sobre la calle Norte, hacia el este
	report( 'Tras un atajo, el seguimiento retoma la ruta más adelante', Math.abs( tr4.along - ( 105 + 70 ) ) < 2 && tr4.offset < 1, `avance ${ tr4.along.toFixed( 0 ) } m, desvío ${ tr4.offset.toFixed( 1 ) } m` );

}

// --- geometría de la ciudad
const city = generateCity( 7 );
report( 'Ciudad: edificios, autos, árboles', city.buildings.length > 100 && city.cars.length > 100 && city.trees.length > 100, `${ city.buildings.length }, ${ city.cars.length }, ${ city.trees.length }` );
report( 'Superficies: calzada en el eje, vereda en el borde, manzana adentro', surfaceAt( 0, 50 ) === 0 && surfaceAt( 9.5, 50 ) === 1 && surfaceAt( 55, 55 ) === 2 && surfaceAt( 600, 0 ) === 3, [ surfaceAt( 0, 50 ), surfaceAt( 9.5, 50 ), surfaceAt( 55, 55 ), surfaceAt( 600, 0 ) ].join( ',' ) );
report( 'Solera de 15 cm', Math.abs( ( groundHeight( 9.5, 50, false ) - baseHeight( 9.5, 50 ) ) - CITY.curb ) < 1e-9 && Math.abs( groundHeight( 0, 50, false ) - baseHeight( 0, 50 ) ) < 1e-9 );
{

	let tris = 0, verts = 0, maxTris = 0, bad = 0;
	const chunks = cityChunks();
	for ( const c of chunks ) {

		const m = buildRegion( city, c.x0, c.z0, c.x1, c.z1, { step: 1 } );
		tris += m.indices.length / 3; verts += m.positions.length / 3;
		maxTris = Math.max( maxTris, m.indices.length / 3 );
		for ( let i = 0; i < m.positions.length; i ++ ) if ( ! Number.isFinite( m.positions[ i ] ) ) bad ++;
		for ( let i = 0; i < m.indices.length; i ++ ) if ( m.indices[ i ] >= m.positions.length / 3 ) bad ++;

	}

	report( 'Malla de la ciudad', bad === 0, `${ chunks.length } teselas, ${ ( tris / 1e6 ).toFixed( 2 ) } M de triángulos, máximo ${ maxTris } por tesela` );

}

process.exit( fail ? 1 : 0 );
