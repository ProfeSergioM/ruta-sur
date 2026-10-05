// Prueba de extremo a extremo del camino de teselas 3D, con los servicios simulados.
// Ejecutar: node tools/make-tileset.mjs && node tests/e2e-tiles.mjs [calidad] [solo-entrega]
//
// El entorno de pruebas no llega a Google, a Cesium ion ni a Overpass. Aquí se
// sirve un tileset propio con la misma estructura (ECEF, tilesets anidados con
// rutas absolutas, Draco, sesión) en las mismas direcciones del servicio real, y
// cada simulación responde como lo haría el servicio a lo que el juego le pide:
//   - Google exige la clave en todos los pedidos y la sesión vigente en los que no son la raíz;
//   - Overpass devuelve, para cada consulta, los campos del nivel de detalle pedido.
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { launch, state, waitFor, sleep, Report, ROOT, SHOTS, GAME } from './harness.mjs';
import { Geo } from '../src/geo.js';
import { cityRoadsOSM } from '../src/testcity.js';
import { overpassAnswer } from './overpass-mock.mjs';

const R = new Report();
const ORIGIN = { lat: - 38.739141, lon: - 72.590355, h: 110 };
const TILESET = resolve( ROOT, 'tests/tileset' );
const KEY = 'AIza' + 'x'.repeat( 35 );
const ION = 'eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJwcnVlYmEifQ.c2lnbmF0dXJl';
const MIME = { '.json': 'application/json', '.glb': 'model/gltf-binary' };
const CORS = { 'access-control-allow-origin': '*' };
const pilot = readFileSync( resolve( ROOT, 'tests/pilot.js' ), 'utf8' );
// Calidad del mapa: baja | media | alta. Las dos últimas activan el fundido entre niveles de detalle.
const QUALITY = process.argv[ 2 ] || 'baja';
const ONLY_FIRST = process.argv[ 3 ] === 'solo-entrega';
const wait = ms => new Promise( r => setTimeout( r, ms ) );
// SECCIONES=5,7 ejecuta solo esas secciones de la prueba
const ONLY = process.env.SECCIONES ? process.env.SECCIONES.split( ',' ).map( Number ) : null;
const skip = n => ONLY !== null && ! ONLY.includes( n );

/**
 * Simula los tres servicios. `net` acumula lo pedido y `net.flags` cambia el
 * comportamiento durante la prueba:
 *   badKey          la clave se rechaza con 403
 *   rootDelay       demora de la respuesta raíz [ms]
 *   glbDelay        demora de cada tesela [ms]
 *   glbStatus       las teselas responden con este código de error
 *   glbHang         las teselas no responden nunca
 *   expired         la sesión S1 venció: se rechaza con 403 y la raíz entrega la sesión S2
 *   overpassFails   Overpass responde 504
 *   overpassPlan    lista de { delay, only } para los pedidos sucesivos a Overpass
 */
async function mockServices( page, net ) {

	const F = net.flags;
	await page.route( 'https://tile.googleapis.com/**', async route => {

		const url = new URL( route.request().url() );
		const rel = url.pathname.replace( /^\/v1\/3dtiles\//, '' );
		const isRoot = rel === 'root.json', session = url.searchParams.get( 'session' );
		net.google.push( url.pathname + url.search );
		if ( F.badKey || url.searchParams.get( 'key' ) !== KEY ) { net.rejected ++; return route.fulfill( { status: 403, contentType: 'application/json', body: '{"error":{"code":403,"message":"API key not valid"}}', headers: CORS } ); }
		const current = F.expired ? 'S2' : 'S1';
		if ( ! isRoot && session !== current ) {

			if ( session === 'S1' ) { net.expired ++; return route.fulfill( { status: 403, contentType: 'application/json', body: '{"error":{"code":403,"message":"session expired"}}', headers: CORS } ); }
			net.noSession ++;
			return route.fulfill( { status: 400, body: 'missing session', headers: CORS } );

		}

		const file = resolve( TILESET, rel );
		if ( ! existsSync( file ) ) return route.fulfill( { status: 404, body: 'not found', headers: CORS } );
		const isGlb = extname( file ) === '.glb';
		if ( isRoot ) { net.roots ++; if ( F.rootDelay ) await wait( F.rootDelay ); }
		if ( isGlb ) {

			net.glb ++;
			if ( F.glbHang ) return; // el pedido queda abierto para siempre
			if ( F.glbDelay ) await wait( F.glbDelay );
			if ( F.glbStatus ) return route.fulfill( { status: F.glbStatus, contentType: 'application/json', body: `{"error":{"code":${ F.glbStatus }}}`, headers: CORS } ).catch( () => {} );

		}

		let body = readFileSync( file );
		if ( extname( file ) === '.json' ) {

			// como en el servicio real, los tilesets nombran su contenido con rutas absolutas desde la raíz del servidor
			const dir = url.pathname.slice( 0, url.pathname.lastIndexOf( '/' ) + 1 );
			body = body.toString( 'utf8' ).replace( /"uri":\s*"(?!\/|https?:)/g, `"uri":"${ dir }` );
			if ( body.includes( `"uri":"${ dir }` ) ) net.absolute ++;
			if ( current !== 'S1' ) body = body.replace( /session=S1/g, `session=${ current }` );
			if ( session === 'S2' || ( isRoot && F.expired ) ) net.renewed ++;

		} else if ( session === 'S2' ) net.renewed ++;

		route.fulfill( { status: 200, body, contentType: MIME[ extname( file ) ] || 'application/octet-stream', headers: CORS } ).catch( () => {} ); // la página pudo cancelar el pedido

	} );

	// Cesium ion: el recurso 2275207 es externo y apunta al servicio de Google
	await page.route( 'https://api.cesium.com/**', route => {

		const url = new URL( route.request().url() );
		net.ion.push( url.pathname + url.search );
		if ( url.searchParams.get( 'access_token' ) !== ION ) return route.fulfill( { status: 401, contentType: 'application/json', body: '{"code":"InvalidCredentials"}', headers: CORS } );
		route.fulfill( { status: 200, contentType: 'application/json', headers: CORS,
			body: JSON.stringify( { type: '3DTILES', externalType: '3DTILES', options: { url: `https://tile.googleapis.com/v1/3dtiles/root.json?key=${ KEY }` }, attributions: [ { html: '<span>Cesium ion</span>', collapsible: false } ] } ) } );

	} );

	// Overpass: la red vial de la ciudad de pruebas, con los campos que corresponden a la consulta recibida
	const full = cityRoadsOSM( new Geo( ORIGIN.lat, ORIGIN.lon, ORIGIN.h ) );
	await page.route( /https:\/\/overpass[^/]*\/api\/interpreter.*/, async route => {

		const n = net.overpass.length;
		net.overpass.push( route.request().url() );
		const query = decodeURIComponent( ( route.request().postData() || '' ).replace( /^data=/, '' ).replace( /\+/g, ' ' ) );
		net.overpassQuery = query;
		if ( F.overpassFails ) return route.fulfill( { status: 504, body: 'timeout', headers: CORS } );
		const plan = ( F.overpassPlan && F.overpassPlan[ n ] ) || {};
		if ( plan.delay ) await wait( plan.delay );
		const answer = overpassAnswer( query, plan.only ? { elements: full.elements.slice( 0, plan.only ) } : full );
		route.fulfill( { status: 200, contentType: 'application/json', body: JSON.stringify( answer ), headers: CORS } ).catch( () => {} );

	} );

}

const newNet = ( flags = {} ) => ( { google: [], ion: [], overpass: [], roots: 0, glb: 0, rejected: 0, noSession: 0, expired: 0, renewed: 0, absolute: 0, flags } );

async function openMenu( page, credential ) {

	await page.goto( `${ GAME }?seed=5` );
	await page.evaluate( () => localStorage.clear() );
	await page.reload();
	await page.addScriptTag( { content: pilot } );
	await page.click( 'label:has(#ciudad-otro)' );
	await page.fill( '#coordenadas', `${ ORIGIN.lat }, ${ ORIGIN.lon }` );
	await page.click( `label:has(#calidad-${ QUALITY })` );
	await page.fill( '#credencial', credential );

}

const sessions = page => page.evaluate( () => JSON.parse( localStorage.getItem( 'rutasur.sesiones' ) ) );
const unexpected = log => log.errors.filter( e => ! /Failed to load resource|status of 4\d\d|status of 5\d\d/.test( e ) );

// ========================================================================
// 1. Clave de Google: flujo completo desde la pantalla inicial
// ========================================================================
s1: {

	if ( skip( 1 ) ) break s1;

	const { browser, page, log } = await launch( { width: 960, height: 540 } );
	const net = newNet();
	await mockServices( page, net );
	await openMenu( page, KEY );
	const note = await page.textContent( '#credencial-nota' );
	R.check( 'La pantalla inicial reconoce la clave de Google', /clave de Google Maps Platform/.test( note ), note );
	await page.screenshot( { path: `${ SHOTS }/tiles-00-inicio.png`, fullPage: true } );
	const t0 = Date.now();
	await page.click( '#conducir' );
	let s;
	try { s = await waitFor( page, s => s.state === 'driving', 240000, 'conducción sobre teselas' ); } catch ( e ) {

		console.log( String( e ) );
		console.log( 'pedidos:', net.google.slice( 0, 12 ), 'rechazados', net.rejected, 'sin sesión', net.noSession );
		console.log( 'errores:', log.errors.slice( 0, 8 ) );
		process.exit( 1 );

	}

	R.info( 'Calidad del mapa', QUALITY );
	R.info( 'Tiempo de carga con teselas (dibujando por software)', ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + ' s' );
	R.check( 'Se pidió una sola sesión de mapa (tileset raíz)', net.roots === 1, `${ net.roots } pedidos de raíz, ${ net.google.length } pedidos en total` );
	R.check( 'Todos los pedidos llevaron la clave y la sesión', net.rejected === 0 && net.noSession === 0, `${ net.rejected } sin clave, ${ net.noSession } sin sesión` );
	R.check( 'Los tilesets anidados se sirvieron con rutas absolutas, como en el servicio real', net.absolute >= 2 && net.google.some( u => u.startsWith( '/v1/3dtiles/datasets/files/' ) ), `${ net.absolute } tilesets` );
	R.check( 'La red vial se pidió a Overpass alrededor del punto elegido, con los nodos de cada vía', net.overpass.length === 1 && net.overpassQuery.includes( `around:2500,${ ORIGIN.lat.toFixed( 6 ) },${ ORIGIN.lon.toFixed( 6 ) }` ) && /out\s+body\s+geom/.test( net.overpassQuery ), ( net.overpassQuery.match( /^out[^;]*;/m ) || [ '' ] )[ 0 ] );
	R.check( 'Con la respuesta que Overpass da a esa consulta, el camión aparece sobre una calle', s.truck.grounded && s.truck.y > 105 && s.truck.y < 135 && s.graph === 301 && s.jobs.state === 'offer', `${ s.graph } nodos de calle, y = ${ s.truck.y.toFixed( 1 ) } m sobre el elipsoide, ${ s.truck.samples } muestras` );
	const fine = await page.evaluate( () => { const g = window.__rutaSur; return g.world.field.meshes.map( m => m.userData.tile && m.userData.tile.geometricError ); } );
	R.check( 'Bajo el camión está cargado el nivel de detalle más fino', fine.length > 0 && fine.every( e => e === 0 ), `${ fine.length } mallas cercanas` );
	await sleep( page, 3000 );
	const attr = await page.evaluate( () => ( { logo: document.getElementById( 'a-logo' ).textContent, src: document.getElementById( 'a-fuentes' ).textContent, via: document.getElementById( 'a-via' ).textContent, osm: document.getElementById( 'mapa-credito' ).textContent } ) );
	R.check( 'Atribución en pantalla: Google Maps y las fuentes de las teselas visibles', attr.logo === 'Google Maps' && /Ciudad de pruebas/.test( attr.src ) && /Ruta Sur/.test( attr.src ), `"${ attr.logo }" · "${ attr.src }"` );
	R.check( 'Crédito de OpenStreetMap en el minimapa', /OpenStreetMap/.test( attr.osm ), attr.osm );
	const n1 = await sessions( page );
	R.check( 'La sesión quedó anotada en el contador del mes', n1 && n1.count === 1, JSON.stringify( n1 ) );
	await page.screenshot( { path: `${ SHOTS }/tiles-${ QUALITY }-01-cabina.png` } );

	// entrega con el bucle real (las teselas se cargan mientras el camión avanza)
	await page.keyboard.press( 'Enter' );
	await sleep( page, 300 );
	await page.evaluate( () => { const g = window.__rutaSur; g.probe = { impacts: 0, maxRoll: 0, maxPitch: 0, noGround: 0, minSamples: 99, maxDy: 0, lastY: g.truck.y, rejected: 0, frames: 0, maxNear: 0 }; g.script = ( time, t ) => { const p = g.probe; p.frames ++; p.maxRoll = Math.max( p.maxRoll, Math.abs( t.roll ) ); p.maxPitch = Math.max( p.maxPitch, Math.abs( t.pitch ) ); if ( ! t.grounded ) p.noGround ++; p.minSamples = Math.min( p.minSamples, t.gTr.samples ); p.maxDy = Math.max( p.maxDy, Math.abs( t.y - p.lastY ) ); p.lastY = t.y; if ( t.gTr.rejected ) p.rejected ++; if ( g.lastImpact > 0.85 ) { p.impacts ++; g.lastImpact = 0; } p.maxNear = Math.max( p.maxNear, g.world.field.meshes.length ); return window.__pilot(); }; } );
	await sleep( page, 6000 );
	await page.keyboard.press( 'KeyC' );
	await sleep( page, 4000 );
	await page.screenshot( { path: `${ SHOTS }/tiles-${ QUALITY }-02-exterior.png` } );
	// sin dibujar, el bucle corre a ritmo real y las teselas se siguen pidiendo según avanza el camión
	await page.evaluate( () => { window.__rutaSur.noRender = true; } );
	s = await waitFor( page, s => s.jobs.state === 'done' || s.jobs.entregas > 0, 420000, 'entrega sobre teselas' );
	await page.evaluate( () => { window.__rutaSur.noRender = false; } );
	const probe = await page.evaluate( () => window.__rutaSur.probe );
	const sim = await page.evaluate( () => window.__rutaSur.simTime );
	R.check( 'Entrega completada sobre teselas que se cargan en marcha', s.jobs.entregas === 1, `${ sim.toFixed( 0 ) } s simulados, caja $ ${ s.jobs.total }` );
	R.check( 'Siempre hubo suelo cargado bajo el camión', probe.noGround === 0 && probe.minSamples >= 12, `mínimo de ${ probe.minSamples } muestras de suelo` );
	R.check( 'Sin choques y con postura estable', probe.impacts === 0 && probe.maxRoll < 0.1 && probe.maxPitch < 0.16, `alabeo máximo ${ ( probe.maxRoll * 57.3 ).toFixed( 1 ) }°, cabeceo máximo ${ ( probe.maxPitch * 57.3 ).toFixed( 1 ) }°, mayor cambio de altura por paso ${ ( probe.maxDy * 100 ).toFixed( 1 ) } cm` );
	const column = await page.evaluate( () => window.__rutaSur.world.column.enabled );
	R.check( 'La columna de carga del punto de partida quedó apagada al empezar a manejar', column === false );
	await page.evaluate( () => { window.__rutaSur.script = null; } );
	await page.keyboard.press( 'F3' );
	await sleep( page, 2500 );
	await page.screenshot( { path: `${ SHOTS }/tiles-${ QUALITY }-03-entrega.png` } );
	const dbg = await page.evaluate( () => document.getElementById( 'depura' ).textContent );
	R.info( 'Datos técnicos', '\n      ' + dbg.split( '\n' ).join( '\n      ' ) );
	R.check( 'Sigue habiendo una sola sesión tras manejar', net.roots === 1, `${ net.google.length } pedidos al servicio de teselas` );
	R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 4 ).join( ' | ' ) );
	// El decodificador Draco de las teselas viaja dentro del archivo: la red solo se usa para el mapa y las calles.
	const others = log.external.filter( u => ! /^https:\/\/(tile\.googleapis\.com|overpass[^/]*)\//.test( u ) );
	R.check( 'Los únicos pedidos a la red fueron al servicio de teselas y al de calles', others.length === 0 && net.glb > 0, others.length ? others.slice( 0, 3 ).join( ' ' ) : `${ net.glb } teselas comprimidas con Draco, decodificadas sin pedir el decodificador` );
	if ( log.warnings.length ) R.info( 'Advertencias', [ ...new Set( log.warnings ) ].slice( 0, 5 ).join( ' | ' ) );

	// --- la sesión vence en plena partida: el servicio rechaza la sesión vieja con 403
	if ( ! ONLY_FIRST ) {

		net.flags.expired = true;
		const before = net.google.length;
		// el camión aparece en otro barrio, donde hay que pedir teselas nuevas
		const far = await page.evaluate( () => { const g = window.__rutaSur; g.script = { accel: 0, decel: 1, steer: 0 }; return g.teleport( - 220, - 215, 90 ) || g.teleport( - 220, - 220, 90 ); } );
		await sleep( page, 500 );
		let renewedOk = false;
		for ( let i = 0; i < 120 && ! renewedOk; i ++ ) {

			await sleep( page, 500 );
			renewedOk = await page.evaluate( () => { const g = window.__rutaSur, t = g.truck; g.teleport( t.x, t.z, 90 ); const m = g.world.field.meshes; return t.grounded && m.length > 0 && m.every( o => o.userData.tile && o.userData.tile.geometricError === 0 ); } );

		}

		const n2 = await sessions( page );
		R.check( 'Sesión vencida: el juego pide una sesión nueva y las teselas siguen llegando', renewedOk && net.roots === 2 && net.expired > 0 && net.renewed > 0, `${ net.expired } pedidos rechazados con la sesión vieja, ${ net.renewed } servidos con la nueva, ${ net.google.length - before } pedidos en total` );
		R.check( 'La sesión nueva también se cuenta', n2 && n2.count === 2, JSON.stringify( n2 ) );
		R.check( 'Tras renovar la sesión, sin errores propios en la consola', unexpected( log ).length === 0, unexpected( log ).slice( 0, 3 ).join( ' | ' ) );
		R.check( 'El lugar solicitado estaba dentro de la ciudad', far === true );

	}

	await browser.close();

}

if ( ONLY_FIRST ) process.exit( R.fail ? 1 : 0 );

// ========================================================================
// 2. Token de Cesium ion
// ========================================================================
s2: {

	if ( skip( 2 ) ) break s2;

	const { browser, page, log } = await launch( { width: 640, height: 360 } );
	const net = newNet();
	await mockServices( page, net );
	await openMenu( page, ION );
	const note = await page.textContent( '#credencial-nota' );
	R.check( 'La pantalla inicial reconoce el token de Cesium ion', /token de Cesium ion/.test( note ), note );
	await page.click( '#conducir' );
	const s = await waitFor( page, s => s.state === 'driving', 240000, 'conducción con Cesium ion' );
	R.check( 'Cesium ion entrega la dirección del servicio y el juego carga las teselas', net.ion.length === 1 && /assets\/2275207\/endpoint/.test( net.ion[ 0 ] ) && net.roots === 1 && s.truck.grounded, `${ net.ion.length } pedido a ion, ${ net.google.length } a teselas` );
	R.check( 'Los pedidos de teselas usan la clave que entregó ion', net.rejected === 0 && net.noSession === 0 );
	await sleep( page, 2500 );
	const via = await page.evaluate( () => [ document.getElementById( 'a-logo' ).textContent, document.getElementById( 'a-via' ).textContent ] );
	R.check( 'Atribución: Google Maps y, aparte, Cesium ion', via[ 0 ] === 'Google Maps' && /Cesium ion/.test( via[ 1 ] ), via.join( ' · ' ) );
	const n = await sessions( page );
	const hardened = await page.evaluate( () => { const w = window.__rutaSur.world, p = w.tiles.getPluginByName( 'GOOGLE_CLOUD_AUTH_PLUGIN' ); return !! ( p && p.auth && p.auth._rutaSur ); } );
	R.check( 'Con Cesium ion la sesión también se cuenta y su renovación queda resguardada', n && n.count === 1 && hardened, JSON.stringify( n ) );
	R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 4 ).join( ' | ' ) );
	await browser.close();

}

// ========================================================================
// 3. Clave rechazada
// ========================================================================
s3: {

	if ( skip( 3 ) ) break s3;

	const { browser, page } = await launch( { width: 640, height: 360 } );
	const net = newNet( { badKey: true } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	await page.click( '#conducir' );
	await page.waitForFunction( () => /403/.test( document.getElementById( 'carga-texto' ).textContent ), null, { timeout: 60000 } ).catch( () => {} );
	const text = await page.textContent( '#carga-texto' );
	R.check( 'Una clave rechazada se explica en pantalla', /403/.test( text ) && /Map Tiles API/.test( text ), text );
	const title = await page.textContent( '#carga-titulo' );
	R.check( 'La señal de carga deja de anunciar avance', /Ruta cortada/i.test( title ) && await page.isHidden( '#carga .guiones' ), title );
	await page.screenshot( { path: `${ SHOTS }/tiles-04-clave-rechazada.png` } );
	await page.click( '#carga-volver' );
	await sleep( page, 300 );
	R.check( 'Volver regresa a la pantalla inicial', await page.isVisible( '#menu' ) );
	const n = await sessions( page );
	R.check( 'Una clave rechazada no cuenta como sesión', ! n || n.count === 0, JSON.stringify( n ) );
	await browser.close();

}

// ========================================================================
// 4. Sin red vial: modo libre
// ========================================================================
s4: {

	if ( skip( 4 ) ) break s4;

	const { browser, page, log } = await launch( { width: 640, height: 360 } );
	const net = newNet( { overpassFails: true } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	await page.click( '#conducir' );
	const s = await waitFor( page, s => s.state === 'driving', 240000, 'conducción sin red vial' );
	R.check( 'Sin red vial el juego sigue en modo libre', s.graph === 0 && s.jobs.state === 'libre' && s.truck.grounded, `se probaron ${ net.overpass.length } instancias de Overpass` );
	const spot = await page.evaluate( () => { const g = window.__rutaSur, t = g.truck; return { x: t.x, z: t.z }; } );
	R.info( 'Punto de aparición elegido sin red vial', `(${ spot.x.toFixed( 1 ) }, ${ spot.z.toFixed( 1 ) })` );
	await sleep( page, 2000 );
	await page.screenshot( { path: `${ SHOTS }/tiles-05-modo-libre.png` } );
	R.check( 'Sin errores inesperados en la consola', unexpected( log ).length === 0, unexpected( log ).slice( 0, 4 ).join( ' | ' ) );
	await browser.close();

}

// ========================================================================
// 5. Salir a mitad de la carga, varias veces, y volver a entrar
// ========================================================================
// Cada salida ocurre con teselas a medio descargar y decodificar. Si esos trabajos
// quedaran colgados en la cola compartida de la librería, la partida siguiente no
// terminaría nunca de cargar.
s5: {

	if ( skip( 5 ) ) break s5;

	const { browser, page, log } = await launch( { width: 640, height: 360 } );
	const net = newNet( { glbDelay: 250 } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	let exits = 0;
	for ( let k = 0; k < 4; k ++ ) {

		const before = net.glb;
		await page.click( '#conducir' );
		const t0 = Date.now();
		while ( net.glb < before + 6 && Date.now() - t0 < 60000 ) await sleep( page, 50 );
		await sleep( page, 120 + 90 * k ); // algunas teselas ya llegaron y se están decodificando
		await page.click( '#carga-volver' );
		await sleep( page, 400 );
		if ( await page.isVisible( '#menu' ) ) exits ++;

	}

	net.flags.glbDelay = 0;
	await page.click( '#conducir' );
	let s = null, err = '';
	try { s = await waitFor( page, s => s.state === 'driving', 150000, 'conducción tras salir cuatro veces a mitad de carga' ); } catch ( e ) { err = String( e.message || e ); }
	const q = await page.evaluate( () => { const t = window.__rutaSur.world && window.__rutaSur.world.tiles; return t ? { parsing: t.parseQueue.currJobs, max: t.parseQueue.maxJobs, down: t.downloadQueue.currJobs } : null; } );
	R.check( 'Tras salir cuatro veces a mitad de carga, la partida siguiente carga completa', exits === 4 && !! s && s.truck.grounded && s.graph === 301, err || `cola de decodificación: ${ q && q.parsing } de ${ q && q.max } cupos en uso` );
	R.check( 'No quedan cupos de decodificación tomados por partidas abandonadas', !! q && q.parsing === 0, JSON.stringify( q ) );
	const n = await sessions( page );
	R.check( 'Cada carga iniciada abrió una sesión y todas quedaron contadas', n && n.count === net.roots, `${ net.roots } pedidos de raíz, contador ${ n && n.count }` );
	R.check( 'Sin errores inesperados en la consola', unexpected( log ).length === 0, unexpected( log ).slice( 0, 4 ).join( ' | ' ) );
	await browser.close();

}

// ========================================================================
// 6. La respuesta de calles de una carga abandonada no contamina la siguiente
// ========================================================================
s6: {

	if ( skip( 6 ) ) break s6;

	const { browser, page, log } = await launch( { width: 640, height: 360 } );
	// el primer pedido a Overpass demora 5 s y trae solo dos calles; el segundo responde de inmediato con la ciudad
	const net = newNet( { overpassPlan: [ { delay: 5000, only: 2 }, {} ] } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	await page.click( '#conducir' );
	await sleep( page, 1200 );
	await page.click( '#carga-volver' );
	await sleep( page, 300 );
	await page.click( '#conducir' );
	const s = await waitFor( page, s => s.state === 'driving', 240000, 'segunda carga' );
	await sleep( page, 6000 ); // la respuesta atrasada de la primera carga ya llegó
	const s2 = await state( page );
	R.check( 'La red vial es la de la carga vigente, antes y después de llegar la respuesta atrasada', net.overpass.length === 2 && s.graph === 301 && s2.graph === 301 && s2.jobs.state === 'offer', `${ s.graph } y luego ${ s2.graph } nodos` );
	R.check( 'Sin errores inesperados en la consola', unexpected( log ).length === 0, unexpected( log ).slice( 0, 4 ).join( ' | ' ) );
	await browser.close();

}

// ========================================================================
// 7. El mapa abre, pero las teselas fallan
// ========================================================================
s7: {

	if ( skip( 7 ) ) break s7;

	const { browser, page } = await launch( { width: 640, height: 360 } );
	const net = newNet( { glbStatus: 429 } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	const t0 = Date.now();
	await page.click( '#conducir' );
	await page.waitForFunction( () => document.getElementById( 'carga' ).dataset.estado === 'error', null, { timeout: 120000 } ).catch( () => {} );
	const text = await page.textContent( '#carga-texto' );
	R.check( 'Teselas rechazadas por cuota: la pantalla dice que el mapa abrió y cuál es el problema', /El mapa abrió/.test( text ) && /429/.test( text ), `${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 0 ) } s: ${ text }` );
	await page.screenshot( { path: `${ SHOTS }/tiles-06-teselas-fallan.png` } );
	await browser.close();

}

// ========================================================================
// 8. El servicio deja de responder a mitad de la carga
// ========================================================================
s8: {

	if ( skip( 8 ) ) break s8;

	const { browser, page } = await launch( { width: 640, height: 360 } );
	const net = newNet( { glbHang: true } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	const t0 = Date.now();
	await page.click( '#conducir' );
	await page.waitForFunction( () => document.getElementById( 'carga' ).dataset.estado === 'error', null, { timeout: 150000 } ).catch( () => {} );
	const text = await page.textContent( '#carga-texto' );
	const secs = ( Date.now() - t0 ) / 1000;
	R.check( 'Descarga detenida: la carga no espera para siempre y lo explica', /se detuvo/.test( text ) && secs < 120, `${ secs.toFixed( 0 ) } s: ${ text }` );
	await page.click( '#carga-volver' );
	await sleep( page, 300 );
	R.check( 'Tras el aviso se puede volver al inicio', await page.isVisible( '#menu' ) );
	await browser.close();

}

// ========================================================================
// 9. Salir mientras se conecta: la sesión pedida igual se cuenta
// ========================================================================
s9: {

	if ( skip( 9 ) ) break s9;

	const { browser, page } = await launch( { width: 640, height: 360 } );
	const net = newNet( { rootDelay: 3000 } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	await page.click( '#conducir' );
	await sleep( page, 1000 );
	await page.click( '#carga-volver' );
	const early = await sessions( page );
	await sleep( page, 4500 );
	const late = await sessions( page );
	const shown = await page.textContent( '#sesiones' );
	R.check( 'Una sesión pedida y abandonada antes de la respuesta queda contada cuando el servicio responde', net.roots === 1 && ( ! early || early.count === 0 ) && late && late.count === 1, `antes ${ early ? early.count : 0 }, después ${ late ? late.count : 0 }` );
	R.info( 'Texto del contador en la pantalla inicial', shown );
	await browser.close();

}

// ========================================================================
// 10. La red de calles llega tarde: la partida empieza libre y luego ofrece encargos
// ========================================================================
// Medido con el servicio real: la consulta de 2,5 km en torno al centro de Temuco tardó 15 s.
// Con el servicio más cargado puede superar la espera de la carga.
s10: {

	if ( skip( 10 ) ) break s10;
	const { browser, page, log } = await launch( { width: 640, height: 360 } );
	const net = newNet( { overpassPlan: [ { delay: 42000 } ] } );
	await mockServices( page, net );
	await openMenu( page, KEY );
	const t0 = Date.now();
	await page.click( '#conducir' );
	const s = await waitFor( page, s => s.state === 'driving', 240000, 'conducción antes de que lleguen las calles' );
	const tDrive = ( Date.now() - t0 ) / 1000;
	const toast1 = await page.textContent( '#aviso' );
	R.check( 'Sin esperar más de la cuenta, la partida empieza en modo libre y lo avisa', s.graph === 0 && s.jobs.state === 'libre' && tDrive < 42 && /todavía no llega/.test( toast1 ), `${ tDrive.toFixed( 0 ) } s: ${ toast1 }` );
	let s2 = null, err = '';
	try { s2 = await waitFor( page, s => s.jobs.state === 'offer', 60000, 'encargo tras la llegada tardía de las calles' ); } catch ( e ) { err = String( e.message || e ); }
	const toast2 = await page.textContent( '#aviso' );
	R.check( 'Cuando llega la red, aparecen los encargos sin reiniciar la partida', !! s2 && s2.graph === 301 && s2.state === 'driving' && /Llegó la red de calles/.test( toast2 ), err || `${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 0 ) } s: ${ toast2 }` );
	await page.keyboard.press( 'Enter' );
	await sleep( page, 400 );
	const s3 = await state( page );
	R.check( 'El encargo se puede aceptar', s3.jobs.state === 'active' && s3.truck.cargo > 0, `${ s3.truck.cargo / 1000 } t, ${ s3.jobs.length.toFixed( 0 ) } m` );
	R.check( 'Sin errores inesperados en la consola', unexpected( log ).length === 0, unexpected( log ).slice( 0, 4 ).join( ' | ' ) );
	await browser.close();

}

process.exit( R.fail ? 1 : 0 );
