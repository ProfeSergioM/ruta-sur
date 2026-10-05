// Prueba con ciudades al azar y datos desordenados, como los de OpenStreetMap:
// calles partidas en varias vías, nodos duplicados, sentidos únicos en ambos
// órdenes, una rotonda, una vía que vuelve sobre su primer nodo y otra de ida y
// vuelta. Se comprueban invariantes de la ruta y del seguimiento.
// Ejecutar: node tests/osm-fuzz.test.mjs
import { Geo } from '../src/geo.js';
import { buildGraph, route, startEdges, RouteTracker, pickDestination, spawnPoint } from '../src/osm.js';

const geo = new Geo( - 38.739141, - 72.590355, 110 );
function mulberry32( a ) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul( a ^ a >>> 15, 1 | a ); t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t; return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296; }; }

function randomCity( seed ) {

	const rnd = mulberry32( seed );
	const nodes = new Map(), elements = [];
	let wayId = 1000, extra = 5000;
	const node = ( id, x, z ) => { const p = geo.toGeo( x, 0, z ); nodes.set( id, { lat: p.lat, lon: p.lon, x, z } ); };
	const way = ( ids, tags ) => elements.push( { type: 'way', id: wayId ++, nodes: ids.slice(), geometry: ids.map( i => ( { lat: nodes.get( i ).lat, lon: nodes.get( i ).lon } ) ), tags: { highway: 'residential', ...tags } } );
	const N = 5 + Math.floor( rnd() * 3 ), P = 60 + rnd() * 80;
	const id = ( i, j ) => 1000 + i * 50 + j;
	for ( let i = 0; i < N; i ++ ) for ( let j = 0; j < N; j ++ ) node( id( i, j ), ( i - N / 2 ) * P + ( rnd() - 0.5 ) * 15, ( j - N / 2 ) * P + ( rnd() - 0.5 ) * 15 );
	const oneway = () => { const r = rnd(); return r < 0.25 ? { oneway: 'yes' } : ( r < 0.45 ? { oneway: '-1' } : {} ); };
	const classes = [ 'residential', 'residential', 'tertiary', 'secondary', 'primary', 'living_street', 'unclassified' ];
	const cls = () => classes[ Math.floor( rnd() * classes.length ) ];
	for ( let i = 0; i < N; i ++ ) {

		let ids = [];
		for ( let j = 0; j < N; j ++ ) {

			ids.push( id( i, j ) );
			if ( rnd() < 0.08 ) { const s = nodes.get( id( i, j ) ); node( ++ extra, s.x, s.z ); ids.push( extra ); }   // mismas coordenadas, otro id
			if ( rnd() < 0.15 && j < N - 1 ) { const a = nodes.get( id( i, j ) ), c = nodes.get( id( i, j + 1 ) ); node( ++ extra, ( a.x + c.x ) / 2 + ( rnd() - 0.5 ) * 8, ( a.z + c.z ) / 2 ); ids.push( extra ); }
			if ( rnd() < 0.12 || j === N - 1 ) { if ( ids.length >= 2 ) way( ids, { name: `NS${ i }`, highway: cls(), ...oneway() } ); ids = rnd() < 0.5 ? [ id( i, j ) ] : []; }

		}

	}

	for ( let j = 0; j < N; j ++ ) {

		let ids = [];
		for ( let i = 0; i < N; i ++ ) {

			ids.push( id( i, j ) );
			if ( rnd() < 0.12 || i === N - 1 ) { if ( ids.length >= 2 ) way( ids, { ...( rnd() < 0.8 ? { name: `EO${ j }` } : {} ), highway: cls(), ...oneway() } ); ids = rnd() < 0.5 ? [ id( i, j ) ] : []; }

		}

	}

	const c = nodes.get( id( 1, 1 ) ), ring = [], K = 6 + Math.floor( rnd() * 8 );
	for ( let k = 0; k < K; k ++ ) { node( ++ extra, c.x + 12 * Math.cos( 2 * Math.PI * k / K ), c.z + 12 * Math.sin( 2 * Math.PI * k / K ) ); ring.push( extra ); }
	ring.push( ring[ 0 ] );
	way( ring, { junction: 'roundabout', name: 'Rotonda' } );
	way( [ id( 1, 1 ), ring[ 0 ] ], { name: 'Acceso' } ); way( [ ring[ 2 ], id( 2, 1 ) ], { name: 'Acceso 2' } );
	way( [ id( 3, 2 ), id( 3, 3 ), id( 4, 3 ), id( 4, 2 ), id( 3, 2 ) ], { name: 'Lazo' } );
	way( [ id( 0, 0 ), id( 0, 1 ), id( 0, 0 ) ], { name: 'IdaVuelta' } );
	return { g: buildGraph( { elements }, geo ), rnd };

}

let early = 0, routes = 0, nulls = 0, reverse = 0, trackBad = 0, trackWorst = 0, spawns = 0, spawnBad = 0, dests = 0, destBad = 0;
const viol = [];
const push = s => { if ( viol.length < 20 ) viol.push( s ); };
const SEEDS = 120, PER = 40;
for ( let seed = 1; seed <= SEEDS; seed ++ ) {

	const { g, rnd } = randomCity( seed );
	const E = g.from.length;
	if ( ! g.x.every( Number.isFinite ) || ! g.len.every( Number.isFinite ) ) push( `semilla ${ seed }: valores no finitos en el grafo` );
	for ( let k = 0; k < PER; k ++ ) {

		const w = g.ways[ Math.floor( rnd() * g.ways.length ) ], i = Math.floor( rnd() * ( w.nodes.length - 1 ) ), a = w.nodes[ i ], b = w.nodes[ i + 1 ], f = rnd();
		const far = rnd() < 0.1 ? 150 : 6;
		const px = g.x[ a ] + ( g.x[ b ] - g.x[ a ] ) * f + ( rnd() - 0.5 ) * far, pz = g.z[ a ] + ( g.z[ b ] - g.z[ a ] ) * f + ( rnd() - 0.5 ) * far;
		const ang = rnd() * 2 * Math.PI, unknown = rnd() < 0.1;
		const hx = unknown ? 0 : Math.cos( ang ), hz = unknown ? 0 : Math.sin( ang ), speed = rnd() < 0.5 ? 0 : rnd() * 25;
		const goal = Math.floor( rnd() * g.count );
		let r;
		try { r = route( g, px, pz, hx, hz, goal, speed ); } catch ( e ) { push( `semilla ${ seed }: route lanzó ${ e.message }` ); continue; }
		const st = startEdges( g, px, pz, hx, hz, speed );
		if ( ! r ) {

			nulls ++;
			// alcance sin costos: si el destino es alcanzable, route no puede devolver null
			if ( st ) {

				const seen = new Uint8Array( E ), q = [];
				let reach = false;
				for ( const s of st.starts ) { for ( const e of s.chain ) if ( g.to[ e ] === goal ) reach = true; if ( ! seen[ s.edge ] ) { seen[ s.edge ] = 1; q.push( s.edge ); } }
				while ( q.length ) { const e = q.pop(); if ( g.to[ e ] === goal ) reach = true; for ( const e2 of g.adj[ g.to[ e ] ] ) if ( ! seen[ e2 ] ) { seen[ e2 ] = 1; q.push( e2 ); } }
				if ( reach ) push( `semilla ${ seed }: sin ruta a un destino alcanzable` );

			}

			continue;

		}

		routes ++; if ( r.reverseStart ) reverse ++;
		if ( r.edges.length > E ) push( `semilla ${ seed }: ruta más larga que el grafo` );
		for ( let j = 0; j < r.edges.length - 1; j ++ ) if ( g.to[ r.edges[ j ] ] !== g.from[ r.edges[ j + 1 ] ] ) { push( `semilla ${ seed }: ruta discontinua` ); break; }
		if ( g.to[ r.edges[ r.edges.length - 1 ] ] !== goal ) push( `semilla ${ seed }: la ruta no termina en el destino` );
		if ( ! st.starts.some( s => s.chain[ 0 ] === r.edges[ 0 ] ) ) push( `semilla ${ seed }: la ruta no parte por un tramo de partida` );
		// alcance desde los estados de partida, que obligan a pasar derecho el cruce cercano
		const seenC = new Uint8Array( E ), qC = [];
		let reachC = false;
		for ( const s of st.starts ) { for ( const e of s.chain ) if ( g.to[ e ] === goal ) reachC = true; if ( ! seenC[ s.edge ] ) { seenC[ s.edge ] = 1; qC.push( s.edge ); } }
		while ( qC.length ) { const e = qC.pop(); if ( g.to[ e ] === goal ) reachC = true; for ( const e2 of g.adj[ g.to[ e ] ] ) if ( ! seenC[ e2 ] ) { seenC[ e2 ] = 1; qC.push( e2 ); } }
		if ( r.earlyTurn ) {

			// el giro anticipado solo se acepta cuando pasar derecho no lleva al destino
			early ++;
			if ( reachC ) push( `semilla ${ seed }: giro anticipado sin necesidad` );

		} else {

			// la ruta recorre completo el tramo obligado (o termina dentro de él)
			const own = st.starts.filter( s => s.chain[ 0 ] === r.edges[ 0 ] );
			if ( ! own.some( s => { const n = Math.min( s.chain.length, r.edges.length ); for ( let j = 0; j < n; j ++ ) if ( s.chain[ j ] !== r.edges[ j ] ) return false; return true; } ) ) push( `semilla ${ seed }: la ruta se aparta del tramo que debe recorrer derecho` );

		}
		if ( r.points.some( p => ! Number.isFinite( p.x ) || ! Number.isFinite( p.z ) ) || ! r.cum.every( Number.isFinite ) ) push( `semilla ${ seed }: valores no finitos en la ruta` );
		for ( let j = 1; j < r.cum.length; j ++ ) if ( r.cum[ j ] < r.cum[ j - 1 ] ) { push( `semilla ${ seed }: distancias acumuladas que retroceden` ); break; }
		for ( const m of r.maneuvers ) if ( ! ( m.at >= 0 && m.at <= r.length + 0.5 ) ) push( `semilla ${ seed }: maniobra fuera de la ruta` );

		// seguimiento: un camión que recorre la ruta, desplazado hasta 1,2 m a un lado y con su rumbo
		const tr = new RouteTracker( r ), lateral = ( rnd() - 0.5 ) * 2.4;
		let worst = 0;
		for ( let s = 0; s <= r.length; s += 0.4 ) {

			let j = 0; while ( j < r.cum.length - 2 && r.cum[ j + 1 ] < s ) j ++;
			const L = r.cum[ j + 1 ] - r.cum[ j ]; if ( L < 1e-6 ) continue;
			const fr = ( s - r.cum[ j ] ) / L, ux = ( r.points[ j + 1 ].x - r.points[ j ].x ) / L, uz = ( r.points[ j + 1 ].z - r.points[ j ].z ) / L;
			tr.update( r.points[ j ].x + ux * L * fr - uz * lateral, r.points[ j ].z + uz * L * fr + ux * lateral, ux, uz );
			worst = Math.max( worst, Math.abs( tr.along - s ) );

		}

		trackWorst = Math.max( trackWorst, worst );
		if ( worst > 6 ) trackBad ++;

	}

	// destinos y aparición
	for ( let k = 0; k < 6; k ++ ) {

		const px = ( rnd() - 0.5 ) * 400, pz = ( rnd() - 0.5 ) * 400;
		const sp = spawnPoint( g, px, pz, rnd() * 6.28 );
		if ( sp ) { spawns ++; if ( ! Number.isFinite( sp.x ) || ! Number.isFinite( sp.z ) || ! Number.isFinite( sp.yaw ) ) spawnBad ++; }
		if ( ! sp ) continue;
		const d = pickDestination( g, sp.x, sp.z, - Math.sin( sp.yaw ), - Math.cos( sp.yaw ), 150, 900, rnd );
		if ( d ) { dests ++; if ( ! g.main[ d.node ] || ! route( g, sp.x, sp.z, - Math.sin( sp.yaw ), - Math.cos( sp.yaw ), d.node ) ) destBad ++; }

	}

}

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };
report( 'Rutas sobre ciudades desordenadas: invariantes', viol.length === 0, `${ routes } rutas en ${ SEEDS } ciudades, ${ nulls } sin ruta posible, ${ reverse } con partida hacia atrás, ${ early } con giro anticipado por falta de alternativa${ viol.length ? '\n      ' + viol.join( '\n      ' ) : '' }` );
report( 'Seguimiento de todas las rutas, con el camión hasta 1,2 m del eje', trackBad === 0, `${ trackBad } rutas con error mayor que 6 m; error máximo ${ trackWorst.toFixed( 1 ) } m` );
report( 'Aparición y destinos sobre la red principal', spawnBad === 0 && destBad === 0 && spawns > 0 && dests > 0, `${ spawns } apariciones, ${ dests } destinos` );
process.exit( fail ? 1 : 0 );
