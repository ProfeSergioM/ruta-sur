// Pruebas de las piezas del mundo que no necesitan navegador: la lectura de calles y
// edificios (con su memoria local), el mundo abierto y la vista que bloquea la red.
// La red se simula. Ejecutar: node tests/world.test.mjs
globalThis.requestAnimationFrame = cb => setTimeout( cb, 0 );
globalThis.cancelAnimationFrame = h => clearTimeout( h );
globalThis.window = globalThis; globalThis.self = globalThis;

// almacenamiento local simulado, con cuota
class Storage {

	constructor( quota = Infinity ) { this.m = new Map(); this.quota = quota; }
	get length() { return this.m.size; }
	key( i ) { return [ ...this.m.keys() ][ i ] ?? null; }
	getItem( k ) { return this.m.has( k ) ? this.m.get( k ) : null; }
	setItem( k, v ) { let size = 0; for ( const [ a, b ] of this.m ) if ( a !== k ) size += a.length + b.length; if ( size + k.length + String( v ).length > this.quota ) throw new Error( 'QuotaExceededError' ); this.m.set( k, String( v ) ); }
	removeItem( k ) { this.m.delete( k ); }

}

globalThis.localStorage = new Storage();

const { fetchRoads, fetchBuildings, noteBlocked, viewBlocks, EMBEDDED } = await import( '../src/world.js' );
const { OpenWorld } = await import( '../src/openworld.js' );
const { syntheticBuildings } = await import( './open-fixture.mjs' );
const { Geo } = await import( '../src/geo.js' );
const { buildGraph, overpassQuery, buildingsQuery } = await import( '../src/osm.js' );
const { cityRoadsOSM } = await import( '../src/testcity.js' );
const { overpassAnswer } = await import( './overpass-mock.mjs' );

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };
const json = ( body, status = 200 ) => ( { ok: status >= 200 && status < 300, status, json: async () => body } );
const LAT = - 38.739141, LON = - 72.590355;
const geo = new Geo( LAT, LON, 0 );
const full = cityRoadsOSM( geo );

// ---------------------------------------------------------------- red de calles
{

	// el servicio simulado responde lo que respondería Overpass a la consulta recibida
	const calls = [];
	globalThis.fetch = async ( url, opt ) => { const q = decodeURIComponent( String( opt.body ).replace( /^data=/, '' ) ); calls.push( { url, q, method: opt.method, type: opt.headers[ 'Content-Type' ] } ); return json( overpassAnswer( q, full ) ); };
	const roads = await fetchRoads( LAT, LON, 2500 );
	const g = buildGraph( roads, geo );
	report( 'La consulta sale por POST, como formulario simple (sin verificación previa entre orígenes)', calls.length === 1 && calls[ 0 ].method === 'POST' && calls[ 0 ].type === 'application/x-www-form-urlencoded' && calls[ 0 ].q === overpassQuery( LAT, LON, 2500 ) );
	report( 'Con la respuesta real a esa consulta se arma la red completa', g.count === 301 && g.ways.length === 14, `${ g.count } nodos, ${ g.ways.length } vías` );
	const keys = [ ...localStorage.m.keys() ];
	report( 'La red queda en la memoria local', keys.length === 1 && keys[ 0 ].startsWith( 'rutasur.calles.3.' ), keys[ 0 ] );
	const again = await fetchRoads( LAT, LON, 2500 );
	const g2 = buildGraph( again, geo );
	report( 'La segunda vez no se consulta al servicio, y la red guardada es la misma', calls.length === 1 && g2.count === 301 && g2.from.length === g.from.length && g2.ways.every( ( w, i ) => w.name === g.ways[ i ].name && w.oneway === g.ways[ i ].oneway ) );
	const stored = localStorage.getItem( keys[ 0 ] ).length, plain = JSON.stringify( roads ).length;
	report( 'El formato guardado es más compacto que el JSON de la respuesta', stored < plain * 0.8, `${ stored } caracteres frente a ${ plain }` );

	// memoria: entradas vencidas y de formatos anteriores
	localStorage.setItem( 'rutasur.roads.-33.438.-70.650.2500', JSON.stringify( { t: Date.now(), d: { elements: [] } } ) );
	localStorage.setItem( 'rutasur.calles.2.-33.438.-70.650.2500', JSON.stringify( { t: Date.now(), d: full } ) );
	localStorage.setItem( 'rutasur.calles.3.-36.827.-73.050.2500', JSON.stringify( { t: Date.now() - 15 * 864e5, w: [] } ) );
	localStorage.setItem( 'rutasur.calles.3.dañada', '{' );
	localStorage.setItem( 'rutasur.config', '{"city":"temuco"}' );
	await fetchRoads( LAT, LON, 2500 );
	const left = [ ...localStorage.m.keys() ].sort();
	report( 'Las redes vencidas, dañadas o de formatos anteriores se borran; lo demás se conserva', left.length === 2 && left.includes( 'rutasur.config' ) && left.some( k => k.startsWith( 'rutasur.calles.3.-38.739' ) ), left.join( ' | ' ) );

	// almacenamiento casi lleno: la red nueva desplaza a la más antigua y la configuración queda intacta
	{

		const one = localStorage.getItem( keys[ 0 ] ).length;
		globalThis.localStorage = new Storage( Math.round( one * 1.6 ) );
		localStorage.setItem( 'rutasur.config', '{"city":"temuco"}' );
		globalThis.fetch = async ( url, opt ) => json( overpassAnswer( decodeURIComponent( String( opt.body ).replace( /^data=/, '' ) ), full ) );
		await fetchRoads( LAT, LON, 2500 );
		await new Promise( r => setTimeout( r, 5 ) );
		await fetchRoads( LAT + 1, LON, 2500 );
		const k2 = [ ...localStorage.m.keys() ].sort();
		report( 'Sin espacio para dos ciudades, queda la más reciente y la configuración', k2.length === 2 && k2.includes( 'rutasur.config' ) && k2.some( k => k.includes( '-37.739' ) ), k2.join( ' | ' ) );
		globalThis.localStorage = new Storage();

	}

	// consulta sin tiempo: 200 con nota de error. Se prueba la otra instancia y no se guarda la respuesta parcial.
	globalThis.localStorage = new Storage();
	const seen = [];
	globalThis.fetch = async ( url, opt ) => { seen.push( url ); return seen.length === 1 ? json( { elements: full.elements.slice( 0, 2 ), remark: 'runtime error: Query timed out in "query" at line 2 after 26 seconds.' } ) : json( overpassAnswer( decodeURIComponent( String( opt.body ).replace( /^data=/, '' ) ), full ) ); };
	const r2 = await fetchRoads( LAT, LON, 2500 );
	report( 'Una respuesta parcial por tiempo agotado se descarta y se usa la otra instancia', seen.length === 2 && seen[ 0 ] !== seen[ 1 ] && r2.elements.length === 14, seen.map( u => new URL( u ).host ).join( ' -> ' ) );

	// sin calles en la zona: no se guarda una red vacía
	globalThis.localStorage = new Storage();
	globalThis.fetch = async () => json( { elements: [] } );
	const r3 = await fetchRoads( 10, 10, 2500 );
	report( 'Una zona sin calles no deja una red vacía en la memoria', r3.elements.length === 0 && localStorage.length === 0 );

	// ambas instancias fallan: el error llega a quien llamó
	globalThis.fetch = async () => json( {}, 504 );
	let err = null;
	try { await fetchRoads( 11, 11, 2500 ); } catch ( e ) { err = e; }
	report( 'Si las dos instancias fallan, se informa el error', err && /504/.test( err.message ), err && err.message );

	// almacenamiento lleno: la red igual se entrega
	globalThis.localStorage = new Storage( 2000 );
	globalThis.fetch = async ( url, opt ) => json( overpassAnswer( decodeURIComponent( String( opt.body ).replace( /^data=/, '' ) ), full ) );
	const r4 = await fetchRoads( LAT, LON, 2500 );
	report( 'Con el almacenamiento lleno la red se usa igual', r4.elements.length === 14 && localStorage.length === 0 );

}

// ------------------------------------------------------------------ edificios
{

	globalThis.localStorage = new Storage();
	const bld = syntheticBuildings( full, geo );
	// una vía sin cerrar, una con dos puntos y una sin etiqueta "building": se descartan
	const extra = { elements: [
		...bld.elements,
		{ type: 'way', id: 1, geometry: bld.elements[ 0 ].geometry.slice( 0, 2 ), tags: { building: 'yes' } },
		{ type: 'way', id: 2, geometry: bld.elements[ 0 ].geometry, tags: { amenity: 'parking' } },
		{ type: 'node', id: 3, lat: 0, lon: 0, tags: { building: 'yes' } },
		{ type: 'way', id: 4, geometry: bld.elements[ 1 ].geometry.slice( 0, 4 ), tags: { building: 'house', name: 'x'.repeat( 200 ), 'building:levels': '2', roof: 'flat' } },
	] };
	const calls = [];
	globalThis.fetch = async ( url, opt ) => { const q = decodeURIComponent( String( opt.body ).replace( /^data=/, '' ) ); calls.push( { url, q } ); return json( overpassAnswer( q, extra ) ); };
	const b = await fetchBuildings( LAT, LON, 1500 );
	report( 'Los edificios se piden a Overpass con la consulta del juego', calls.length === 1 && calls[ 0 ].q === buildingsQuery( LAT, LON, 1500 ) );
	const first = b.elements[ 0 ], ring = bld.elements[ 0 ].geometry;
	report( 'Quedan solo las vías cerradas con tres esquinas y etiqueta "building"; el cierre repetido se quita', b.elements.length === bld.elements.length + 1 && first.geometry.length === ring.length - 1 && b.elements.every( e => e.tags.building && e.geometry.length >= 3 ) );
	const named = b.elements.find( e => e.id === 4 );
	report( 'Se guardan solo las etiquetas útiles, recortadas', named && named.tags.name.length === 60 && named.tags[ 'building:levels' ] === '2' && named.tags.roof === undefined );
	const keys = [ ...localStorage.m.keys() ];
	report( 'Los edificios quedan en la memoria local, aparte de las calles', keys.length === 1 && keys[ 0 ].startsWith( 'rutasur.edificios.1.' ), keys[ 0 ] );
	const b2 = await fetchBuildings( LAT, LON, 1500 );
	report( 'La segunda vez no se consulta, y lo guardado es lo mismo', calls.length === 1 && b2.elements.length === b.elements.length && b2.elements[ 0 ].geometry[ 0 ].lat === first.geometry[ 0 ].lat && b2.elements[ 0 ].tags.building === first.tags.building );
	globalThis.fetch = async () => json( { remark: 'runtime error: Query timed out', elements: [] } );
	let err = null;
	try { await fetchBuildings( LAT + 2, LON, 1500 ); } catch ( e ) { err = e; }
	report( 'Una consulta sin tiempo en las dos instancias se informa', err && /timed out/.test( err.message ), err && err.message );

	// el mundo del mapa abierto, sin navegador: pide ambas cosas, arma trozos y responde rayos
	globalThis.localStorage = new Storage();
	const queries = [];
	globalThis.fetch = async ( url, opt ) => { const q = decodeURIComponent( String( opt.body ).replace( /^data=/, '' ) ); queries.push( q ); return json( overpassAnswer( q, /\["building"\]/.test( q ) ? bld : full ) ); };
	const scene = { children: [], add( o ) { this.children.push( o ); }, remove( o ) { this.children = this.children.filter( c => c !== o ); } };
	const world = new OpenWorld( { scene, lat: LAT, lon: LON } );
	await world.roads();
	for ( let i = 0; i < 50 && ! world.city; i ++ ) await new Promise( r => setTimeout( r, 5 ) );
	report( 'El mundo abierto pide calles y edificios una sola vez cada uno', queries.length === 2 && world.city && world.city.buildings.length === bld.elements.length && world.city.ways.length === 14, `${ queries.length } consultas` );
	const focus = { x: 0, y: 0, z: 0 };
	let steps = 0;
	while ( ! world.ready && steps < 400 ) { world.update( focus, 0.05 ); steps ++; }
	report( 'Alrededor del foco se levantan los trozos cercanos y la carga queda lista', world.ready && world.chunks.size >= 9 && world.progress.ready, `${ world.chunks.size } trozos en ${ steps } pasos, ${ world.buildMs.toFixed( 0 ) } ms` );
	const g = world.groundAt( 0, 0 );
	report( 'Hay suelo plano en el origen', g && Math.abs( g.y ) < 0.05 && g.ny > 0.99, g && `y = ${ g.y.toFixed( 3 ) }` );
	const far = world.groundAt( 3000, - 3000 );
	report( 'Lejos de los datos sigue habiendo suelo, el plano de fondo', far && far.y < 0 && far.y > - 0.1, far && `y = ${ far.y.toFixed( 3 ) }` );
	const bb = world.city.buildings.find( b => Math.hypot( b.cx, b.cz ) < 150 );
	const dx = bb.cx, dz = bb.cz, d = Math.hypot( dx, dz );
	const hit = world.terrain.castObstacle( 0, 1, 0, dx / d, 0, dz / d, d );
	report( 'Un rayo a un metro del suelo hacia un edificio cercano lo toca antes de su centro', hit < d && hit > 0, `${ hit.toFixed( 1 ) } m de ${ d.toFixed( 1 ) }` );
	const st = world.stats();
	report( 'Las estadísticas cuentan edificios y vías', st.edificios === bld.elements.length && st.vias === 14 && st.cercanas > 0 );
	world.update( { x: 5000, y: 0, z: 5000 }, 0.05 ); world.update( { x: 5000, y: 0, z: 5000 }, 0.3 );
	report( 'Al alejarse, los trozos viejos se liberan', [ ...world.chunks.values() ].every( c => Math.hypot( c.cx - 5000, c.cz - 5000 ) < 1500 ) );
	world.dispose();
	report( 'Al cerrar, el mundo sale de la escena', scene.children.length === 0 );

	// sin ninguna de las dos respuestas, el mundo informa el error
	globalThis.localStorage = new Storage();
	globalThis.fetch = async () => json( {}, 504 );
	const w2 = new OpenWorld( { scene, lat: LAT + 3, lon: LON } );
	await w2.roads().catch( () => {} );
	for ( let i = 0; i < 50 && ! w2.error; i ++ ) await new Promise( r => setTimeout( r, 5 ) );
	report( 'Sin OpenStreetMap, el mundo abierto explica el error', /OpenStreetMap/.test( w2.error || '' ) && /504/.test( w2.error || '' ), w2.error );
	w2.dispose();

}

// ------------------------------------------------- vista que bloquea la red
{

	report( 'Fuera de un navegador no se supone un marco', EMBEDDED === false );
	noteBlocked( 'inline' ); noteBlocked( '' ); noteBlocked( undefined ); // avisos sin dirección: se ignoran
	report( 'Sin pedidos bloqueados, nada se atribuye a la vista', ! viewBlocks( 'overpass-api.de', 'private.coffee' ) );
	noteBlocked( 'https://overpass-api.de/api/interpreter' );
	report( 'Un pedido bloqueado queda anotado por servidor', viewBlocks( 'overpass-api.de' ) && viewBlocks( 'private.coffee', 'overpass-api.de' ) && ! viewBlocks( 'private.coffee' ) && ! viewBlocks( 'api.de' ) );
	// con el pedido bloqueado, el mundo abierto explica la causa y la salida
	globalThis.localStorage = new Storage();
	globalThis.fetch = async () => { throw new TypeError( 'Failed to fetch' ); };
	const scene = { children: [], add( o ) { this.children.push( o ); }, remove( o ) { this.children = this.children.filter( c => c !== o ); } };
	const w = new OpenWorld( { scene, lat: LAT + 4, lon: LON } );
	await w.roads().catch( () => {} );
	for ( let i = 0; i < 50 && ! w.error; i ++ ) await new Promise( r => setTimeout( r, 5 ) );
	report( 'Con OpenStreetMap bloqueado por la vista, el mensaje dice la causa y la salida', /bloquea la conexión con OpenStreetMap/.test( w.error || '' ) && /doble clic en Chrome o Edge/.test( w.error || '' ) && /ciudad de pruebas funciona/.test( w.error || '' ), w.error );
	w.dispose();

}

console.log( fail ? `\n${ fail } comprobaciones fuera de lo esperado` : '\nMundo: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
