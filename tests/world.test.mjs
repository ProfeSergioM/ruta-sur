// Pruebas de las piezas del mundo que no necesitan navegador: la lectura de calles
// (con su memoria local), la renovación de la sesión del mapa y los mensajes de error.
// Se usa la librería real de teselas; la red se simula. Ejecutar: node tests/world.test.mjs
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

const { fetchRoads, hardenSession, describeLoadError, noteBlocked, viewBlocks, EMBEDDED } = await import( '../src/world.js' );
const { GoogleCloudAuthPlugin } = await import( '3d-tiles-renderer/plugins' );
const { Geo } = await import( '../src/geo.js' );
const { buildGraph, overpassQuery } = await import( '../src/osm.js' );
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

// ------------------------------------------------------------- sesión del mapa
// Root de ejemplo con el identificador de sesión en la dirección del contenido, como lo entrega el servicio.
const rootJson = session => ( { asset: { version: '1.0' }, root: { children: [ { content: { uri: `/v1/3dtiles/datasets/x.json?session=${ session }` } } ] } } );
const ROOT = 'https://tile.googleapis.com/v1/3dtiles/root.json', TILE = 'https://tile.googleapis.com/v1/3dtiles/datasets/files/a.glb';
const newAuth = () => { const a = new GoogleCloudAuthPlugin( { apiToken: 'K', autoRefreshToken: true } ).auth; a.authURL = ROOT; return a; };
{

	// 1. la librería tal cual: una renovación cancelada deja la sesión bloqueada
	const plain = newAuth();
	plain.sessionToken = 'S1';
	let calls = 0;
	globalThis.fetch = async ( url, opt = {} ) => { calls ++; if ( opt.signal && opt.signal.aborted ) throw Object.assign( new Error( 'The operation was aborted' ), { name: 'AbortError' } ); return String( url ).includes( 'root.json' ) ? json( rootJson( 'S2' ) ) : json( {}, 200 ); };
	const ctl = new AbortController(); ctl.abort();
	await plain.refreshToken( { signal: ctl.signal } ).catch( () => {} );
	const before = calls;
	let locked = false;
	try { await plain.fetch( TILE, {} ); } catch ( e ) { locked = true; }
	report( 'Sin el resguardo, una renovación cancelada bloquea todos los pedidos siguientes (comportamiento de la librería)', locked && calls === before, `${ calls - before } pedidos a la red tras el bloqueo` );

	// 2. con el resguardo: la renovación no hereda la cancelación de la tesela que la pidió
	const a = newAuth();
	a.sessionToken = 'S1';
	let renewed = 0;
	hardenSession( a, () => renewed ++ );
	const sent = [];
	globalThis.fetch = async ( url, opt = {} ) => { sent.push( { url: String( url ), signal: !! opt.signal } ); if ( opt.signal && opt.signal.aborted ) throw Object.assign( new Error( 'aborted' ), { name: 'AbortError' } ); return String( url ).includes( 'root.json' ) ? json( rootJson( 'S2' ) ) : json( {}, 200 ); };
	await a.refreshToken( { signal: ctl.signal } );
	report( 'Con el resguardo, la renovación se pide sin la señal de cancelación y la sesión se actualiza', a.sessionToken === 'S2' && renewed === 1 && sent.length === 1 && sent[ 0 ].signal === false, `sesión ${ a.sessionToken }, ${ renewed } aviso` );

	// 3. sesión vencida en plena marcha: 403 en una tesela, renovación y reintento con la sesión nueva
	const b = newAuth();
	b.sessionToken = 'S1';
	let n2 = 0;
	hardenSession( b, () => n2 ++ );
	const log = [];
	globalThis.fetch = async url => { const u = new URL( url ); log.push( u.pathname.split( '/' ).pop() + '?' + u.searchParams.get( 'session' ) ); if ( u.pathname.endsWith( 'root.json' ) ) return json( rootJson( 'S2' ) ); return u.searchParams.get( 'session' ) === 'S2' ? json( { ok: 1 } ) : json( {}, 403 ); };
	const res = await b.fetch( TILE, {} );
	report( 'Sesión vencida: la tesela se reintenta con la sesión nueva y se cuenta una sesión más', res.ok && n2 === 1 && log.join( ' ' ) === 'a.glb?S1 root.json?null a.glb?S2', log.join( ' -> ' ) );

	// 4. la renovación falla (servicio caído): el pedido falla, pero el siguiente puede volver a intentar
	const c = newAuth();
	c.sessionToken = 'S1';
	hardenSession( c, () => {} );
	let down = true, tries = 0;
	globalThis.fetch = async url => { const u = new URL( url ); if ( u.pathname.endsWith( 'root.json' ) ) { tries ++; return down ? json( {}, 503 ) : json( rootJson( 'S3' ) ); } return u.searchParams.get( 'session' ) === 'S3' ? json( { ok: 1 } ) : json( {}, 403 ); };
	let failed = false;
	try { await c.fetch( TILE, {} ); } catch ( e ) { failed = /503/.test( e.message ); }
	down = false;
	let ok2 = false;
	try { ok2 = ( await c.fetch( TILE, {} ) ).ok; } catch ( e ) { ok2 = false; }
	report( 'Si la renovación falla, el pedido siguiente vuelve a intentarla', failed && ok2 && c.sessionToken === 'S3' && tries === 2, `${ tries } intentos de renovación` );

	// 5. aplicar el resguardo dos veces no duplica los avisos
	const d = newAuth(); d.sessionToken = 'S1';
	let n5 = 0;
	hardenSession( d, () => n5 ++ ); hardenSession( d, () => n5 ++ );
	globalThis.fetch = async url => json( rootJson( 'S9' ) );
	await d.refreshToken( {} );
	report( 'El resguardo se aplica una sola vez por sesión', n5 === 1 );

}

// ------------------------------------------------------------------- mensajes
{

	const G = { type: 'google' }, I = { type: 'ion' };
	const ev = msg => ( { tile: null, error: new Error( msg ) } );
	const m400 = describeLoadError( ev( 'GoogleCloudAuth: Failed to load data with error code 400' ), G );
	const m403 = describeLoadError( ev( 'GoogleCloudAuth: Failed to load data with error code 403' ), G );
	const m429 = describeLoadError( ev( 'GoogleCloudAuth: Failed to load data with error code 429' ), G );
	const i401 = describeLoadError( ev( 'CesiumIonAuthPlugin: Failed to load data with error code 401' ), I );
	const i404 = describeLoadError( ev( 'CesiumIonAuthPlugin: Failed to load data with error code 404' ), I );
	report( 'Clave de Google: 400, 403 y 429 tienen explicación propia', /\(400\)/.test( m400 ) && /Map Tiles API/.test( m403 ) && /cuota/.test( m429 ) );
	report( 'Token de Cesium ion: 401 y 404 tienen explicación propia', /token/.test( i401 ) && /Asset Depot/.test( i404 ) );
	const m503 = describeLoadError( ev( 'GoogleCloudAuth: Failed to load data with error code 503' ), G );
	report( 'Un 503 se informa como falla pasajera del servicio', /503/.test( m503 ) && /pasajero/.test( m503 ), m503 );
	const warn = console.warn; let warned = '';
	console.warn = ( ...a ) => { warned = a.join( ' ' ); };
	const mType = describeLoadError( { tile: null, error: new TypeError( "Cannot read properties of undefined (reading 'content')" ) }, G );
	const mFetch = describeLoadError( { tile: null, error: new TypeError( 'Failed to fetch' ) }, I );
	console.warn = warn;
	report( 'Un error sin código no muestra el texto interno al jugador', ! /undefined|Failed to fetch/.test( mType + mFetch ) && /conexión/.test( mType ) && /credencial/.test( mFetch ) && /Failed to fetch/.test( warned ), mType );
	const t429 = describeLoadError( { tile: {}, error: new Error( 'Failed to load model with error code 429' ) }, G, true );
	const tIon = describeLoadError( { tile: {}, error: new Error( 'Failed to load model with error code 403' ) }, I, true );
	report( 'Error de teselas con el mapa ya abierto: se dice que el mapa abrió y cuál es el problema', /El mapa abrió/.test( t429 ) && /cuota/.test( t429 ) && /El mapa abrió/.test( tIon ) && /Map Tiles API/.test( tIon ), t429 );

	// --- la vista donde está abierto el juego bloquea los pedidos (política de seguridad de una vista previa)
	report( 'Fuera de un navegador no se supone un marco ni un bloqueo', EMBEDDED === false && ! viewBlocks( 'googleapis.com', 'cesium.com' ) && ! /otra aplicación|bloquea/.test( mFetch ), mFetch );
	noteBlocked( 'inline' ); noteBlocked( '' ); noteBlocked( undefined ); // avisos sin dirección: se ignoran
	noteBlocked( 'https://tile.googleapis.com/v1/3dtiles/root.json' );
	report( 'Un pedido bloqueado queda anotado por servidor', viewBlocks( 'googleapis.com' ) && viewBlocks( 'cesium.com', 'googleapis.com' ) && ! viewBlocks( 'cesium.com' ) && ! viewBlocks( 'apis.com' ) );
	console.warn = () => {};
	const bFetch = describeLoadError( { tile: null, error: new TypeError( 'Failed to fetch' ) }, G );
	const bTile = describeLoadError( { tile: {}, error: new TypeError( 'Failed to fetch' ) }, I, true );
	const bUrl = describeLoadError( { tile: null, error: new TypeError( 'Failed to fetch' ) }, { type: 'url' } );
	console.warn = warn;
	report( 'Con el servicio bloqueado por la vista, el mensaje dice la causa y la salida', /bloquea la conexión/.test( bFetch ) && /doble clic en Chrome o Edge/.test( bFetch ) && /ciudad de pruebas funciona/.test( bFetch ) && /bloquea la conexión/.test( bTile ), bFetch );
	report( 'Una respuesta del servicio sigue explicándose por su código', /\(403\)/.test( describeLoadError( ev( 'GoogleCloudAuth: Failed to load data with error code 403' ), G ) ) );
	report( 'Un tileset propio no se atribuye al bloqueo de los servicios de mapas', ! /bloquea/.test( bUrl ), bUrl );

}

console.log( fail ? `\n${ fail } comprobaciones fuera de lo esperado` : '\nMundo: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
