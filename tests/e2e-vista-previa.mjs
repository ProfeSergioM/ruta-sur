// El archivo del juego abierto dentro de otra aplicación. Ejecutar: node tests/e2e-vista-previa.mjs
//
// Una vista previa muestra el HTML en un marco aislado: de otro origen, sin
// almacenamiento, y con una política de seguridad que no deja salir pedidos a otros
// servidores. La primera versión del juego pedía ahí sus bibliotecas a una CDN: cada
// pedido bloqueado era un error y la pantalla inicial quedaba sin programa.
// Esta prueba abre el archivo en esas condiciones y comprueba que:
//   - abre sin errores y sin pedir nada a la red;
//   - la ciudad de pruebas se puede manejar;
//   - el mapa real, que sí necesita red, explica el bloqueo y dice qué hacer;
//   - donde la vista no ejecuta scripts, queda a la vista un aviso con la salida.
import { launch, sleep, Report, GAME, SHOTS } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const R = new Report();
const html = readFileSync( fileURLToPath( GAME ), 'utf8' );
const only = process.env.SECCIONES ? process.env.SECCIONES.split( ',' ) : null;
const run = name => ! only || only.includes( name );

// La política más estricta que deja correr la página: scripts y estilos propios, y nada más.
// Sin connect-src, font-src ni worker-src, todo eso queda prohibido por default-src.
const STRICT = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:";

// Página anfitriona con el juego en un marco aislado. `how` decide cómo llega el HTML al marco.
async function open( { csp = '', sandbox = 'allow-scripts', how = 'src', width = 1100, height = 700 } = {} ) {

	const ctx = await launch( { width, height } );
	const { page } = ctx;
	const attrs = sandbox === null ? '' : `sandbox="${ sandbox }"`;
	const host = {
		src: `<iframe id="vista" ${ attrs } src="https://contenido.test/ruta-sur.html"></iframe>`,
		// el contenido se entrega como texto y el marco lo recibe por el atributo srcdoc o como blob:
		srcdoc: `<iframe id="vista" ${ attrs }></iframe><script>fetch( 'https://contenido.test/ruta-sur.html' ).then( r => r.text() ).then( t => { document.getElementById( 'vista' ).srcdoc = t; } );</script>`,
		blob: `<iframe id="vista" ${ attrs }></iframe><script>fetch( 'https://contenido.test/ruta-sur.html' ).then( r => r.blob() ).then( b => { document.getElementById( 'vista' ).src = URL.createObjectURL( new Blob( [ b ], { type: 'text/html' } ) ); } );</script>`,
	}[ how ];
	await page.route( 'https://app.test/', r => r.fulfill( { status: 200, contentType: 'text/html', body: `<!doctype html><meta charset="utf-8"><title>Aplicación anfitriona</title><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style>${ host }` } ) );
	await page.route( 'https://contenido.test/ruta-sur.html', r => r.fulfill( { status: 200, contentType: 'text/html; charset=utf-8', body: html, headers: { 'access-control-allow-origin': '*', ...( csp ? { 'content-security-policy': csp } : {} ) } } ) );
	await page.goto( 'https://app.test/' );
	let frame = null;
	for ( let i = 0; i < 100 && ! frame; i ++ ) {

		frame = page.frames().find( f => f !== page.mainFrame() && f.url() !== 'about:blank' && f.url() !== '' ) || null;
		if ( ! frame ) await sleep( page, 100 );

	}

	if ( ! frame ) throw new Error( 'El marco de la vista previa no cargó' );
	await frame.waitForLoadState( 'load' );
	await sleep( page, 1500 );
	return { ...ctx, frame };

}

// pedidos a la red hechos por el juego: se descuentan los dos de la página anfitriona
const outside = log => log.external.filter( u => ! /^https:\/\/(app|contenido)\.test\//.test( u ) );
const game = ( frame, fn, arg ) => frame.evaluate( fn, arg );
const menu = frame => game( frame, () => ( {
	arranco: !! ( window.__rsGuardia && window.__rsGuardia.listo ),
	estado: window.__rutaSur ? window.__rutaSur.state : null,
	ciudades: document.querySelectorAll( '#ciudades input' ).length,
	camiones: document.querySelectorAll( '#camiones input' ).length,
	calidades: document.querySelectorAll( '#calidades input' ).length,
	avisoFijo: getComputedStyle( document.getElementById( 'sin-motor' ) ).display,
	falla: ! document.getElementById( 'falla' ).hidden,
	marco: document.getElementById( 'marco-nota' ).hidden ? '' : document.getElementById( 'marco-nota' ).textContent,
	fuentes: [ ...document.fonts ].map( f => `${ f.family } ${ f.status }` ).join( ', ' ),
	overpass: document.fonts.check( '16px Overpass' ) && document.fonts.check( '16px "Overpass Mono"' ),
} ) );

async function waitState( page, frame, want, ms, label ) {

	const t0 = Date.now();
	for ( ;; ) {

		const s = await game( frame, () => ( { state: window.__rutaSur.state, error: window.__rutaSur.world ? window.__rutaSur.world.error : null } ) );
		if ( s.state === want ) return s;
		if ( Date.now() - t0 > ms ) throw new Error( `Tiempo agotado esperando "${ label }": ${ JSON.stringify( s ) }` );
		await sleep( page, 250 );

	}

}

// ---------------------------------------------------------------------------
// 1. Vista previa estricta
// ---------------------------------------------------------------------------
if ( run( 'estricta' ) ) {

	console.log( '\n# Vista previa estricta: marco aislado, de otro origen, sin salida a la red' );
	const { browser, page, frame, log } = await open( { csp: STRICT } );
	let m = await menu( frame );
	R.check( 'Abre sin errores', log.errors.length === 0, log.errors.length ? log.errors.slice( 0, 3 ).join( ' | ' ) : '0 errores' );
	R.check( 'Abre sin pedir nada a la red', outside( log ).length === 0, outside( log ).slice( 0, 3 ).join( ' ' ) || '0 pedidos' );
	R.check( 'El programa arranca y la pantalla inicial queda completa', m.arranco && m.estado === 'menu' && m.ciudades === 4 && m.camiones === 2 && m.calidades === 3, `${ m.ciudades } ciudades, ${ m.camiones } camiones, ${ m.calidades } calidades` );
	R.check( 'Sin avisos de falla a la vista', m.avisoFijo === 'none' && ! m.falla );
	R.check( 'Las tipografías incluidas se instalan aunque la política prohíba cargar tipografías', m.overpass, m.fuentes );
	R.check( 'La pantalla inicial avisa que está dentro de otra aplicación y qué hacer para el mapa real', /dentro de otra aplicación/.test( m.marco ) && /ciudad de pruebas funciona/.test( m.marco ) && /Chrome o Edge/.test( m.marco ), m.marco.slice( 0, 60 ) + '…' );
	await page.screenshot( { path: `${ SHOTS }/vista-previa-01-inicio.png` } );

	// --- la ciudad de pruebas se maneja dentro de la vista
	await frame.click( '#pista' );
	await waitState( page, frame, 'driving', 120000, 'conducción en la ciudad de pruebas' );
	await page.keyboard.press( 'Enter' );
	await page.keyboard.down( 'KeyW' );
	let v = 0;
	for ( let i = 0; i < 80 && v < 1.5; i ++ ) { await sleep( page, 250 ); v = await game( frame, () => window.__rutaSur.truck.v ); }
	await page.keyboard.up( 'KeyW' );
	const d = await game( frame, () => { const g = window.__rutaSur; return { v: g.truck.v, grounded: g.truck.grounded, jobs: g.jobs.state, graph: g.graph ? g.graph.count : 0 }; } );
	R.check( 'La ciudad de pruebas se maneja con el teclado dentro de la vista', d.v > 1 && d.grounded && d.jobs === 'active' && d.graph === 301, `${ ( d.v * 3.6 ).toFixed( 1 ) } km/h, encargo ${ d.jobs }` );
	await sleep( page, 1500 );
	await page.screenshot( { path: `${ SHOTS }/vista-previa-02-ciudad.png` } );
	R.check( 'Manejar no produjo errores ni pedidos a la red', log.errors.length === 0 && outside( log ).length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );

	// --- el teclado llega al juego solo mientras el marco tiene el foco
	// El navegador de pruebas mantiene el foco en todos los marcos, así que aquí se
	// simula la pérdida: se comprueba el aviso del juego, no el comportamiento del navegador.
	const toast = () => game( frame, () => { const a = document.getElementById( 'aviso' ); return a.hidden ? '' : a.textContent; } );
	await sleep( page, 5500 ); // los avisos del inicio ya se retiraron
	const quiet = await toast();
	await game( frame, () => { document.hasFocus = () => false; } );
	let hint = '';
	// el juego revisa el foco cada 4 s de su reloj, que con dibujo por software corre más lento que el de pared
	for ( let i = 0; i < 240 && ! /clic sobre el juego/.test( hint ); i ++ ) { await sleep( page, 250 ); hint = await toast(); }
	await game( frame, () => { delete document.hasFocus; } );
	R.check( 'Si el marco pierde el foco del teclado, el juego dice cómo recuperarlo', ! /clic sobre el juego/.test( quiet ) && /Haz clic sobre el juego/.test( hint ) && await game( frame, () => document.hasFocus() ), hint || `sin aviso (${ await game( frame, () => window.__rutaSur.perf.fps.toFixed( 1 ) ) } c/s)` );

	// --- el mapa abierto necesita red: la vista lo bloquea y el juego lo explica
	await page.keyboard.press( 'Escape' );
	await frame.click( '#salir' );
	await frame.click( '#conducir' );
	let text = '';
	for ( let i = 0; i < 120; i ++ ) { text = await game( frame, () => document.getElementById( 'carga' ).dataset.estado === 'error' ? document.getElementById( 'carga-texto' ).textContent : '' ); if ( text ) break; await sleep( page, 250 ); }
	const title = await game( frame, () => document.getElementById( 'carga-titulo' ).textContent );
	R.check( 'Al pedir el mapa abierto, el juego explica que la vista bloquea la conexión y cómo abrirlo', /bloquea la conexión con OpenStreetMap/.test( text ) && /ábrelo con doble clic en Chrome o Edge/.test( text ) && /Ruta cortada/i.test( title ), text );
	await page.screenshot( { path: `${ SHOTS }/vista-previa-03-mapa-bloqueado.png` } );
	// los únicos errores de consola son los rechazos que anota el navegador por la política de la vista
	const own = log.errors.filter( e => ! /Content Security Policy|Refused to connect|Failed to fetch|net::ERR_/i.test( e ) );
	m = await menu( frame );
	R.check( 'El bloqueo no produce errores propios ni abre el informe de falla', own.length === 0 && ! m.falla, own.slice( 0, 3 ).join( ' | ' ) || `${ log.errors.length } rechazos anotados por el navegador` );
	R.check( 'Ningún pedido salió hacia OpenStreetMap', outside( log ).length === 0, outside( log ).slice( 0, 3 ).join( ' ' ) || '0 pedidos' );
	await frame.click( '#carga-volver' );
	R.check( 'Volver regresa a la pantalla inicial', ( await menu( frame ) ).estado === 'menu' );
	await browser.close();

}

// ---------------------------------------------------------------------------
// 1b. Vista previa en un panel angosto
// ---------------------------------------------------------------------------
// Una vista previa suele ocupar un panel lateral, más alto que ancho. Con la guía de
// despacho, el minimapa, la señal de maniobra, un aviso y el tablero a la vista, nada
// debe quedar encima de otra cosa.
for ( const [ width, height ] of [ [ 460, 760 ], [ 380, 700 ] ] ) {

	if ( ! run( 'angosta' ) ) continue;
	console.log( `\n# Vista previa en un panel de ${ width } × ${ height }` );
	const { browser, page, frame, log } = await open( { csp: STRICT, width, height } );
	const wide = await game( frame, () => document.documentElement.scrollWidth > window.innerWidth + 1 );
	R.check( 'La pantalla inicial cabe a lo ancho, sin desplazamiento horizontal', ! wide );
	await frame.click( '#pista' );
	await waitState( page, frame, 'driving', 120000, 'conducción en la ciudad de pruebas' );
	await page.keyboard.press( 'Enter' );
	// la señal de maniobra aparece con la primera actualización de la guía; después se provoca un aviso
	for ( let i = 0; i < 80; i ++ ) { if ( await game( frame, () => ! document.getElementById( 'maniobra' ).hidden ) ) break; await sleep( page, 250 ); }
	await page.keyboard.press( 'KeyM' );
	for ( let i = 0; i < 40; i ++ ) { if ( await game( frame, () => /Sonido/.test( document.getElementById( 'aviso' ).textContent ) && ! document.getElementById( 'aviso' ).hidden ) ) break; await sleep( page, 100 ); }
	const boxes = await game( frame, () => {

		const out = {};
		for ( const id of [ 'guia', 'mapa', 'maniobra', 'aviso', 'tablero' ] ) {

			const el = document.getElementById( id ), r = el.getBoundingClientRect();
			if ( ! el.hidden && r.width > 0 ) out[ id ] = { l: r.left, t: r.top, r: r.right, b: r.bottom };

		}

		return { out, w: window.innerWidth, h: window.innerHeight };

	} );
	const ids = Object.keys( boxes.out ), clash = [];
	for ( let i = 0; i < ids.length; i ++ ) for ( let j = i + 1; j < ids.length; j ++ ) {

		const a = boxes.out[ ids[ i ] ], b = boxes.out[ ids[ j ] ];
		if ( a.l < b.r - 1 && b.l < a.r - 1 && a.t < b.b - 1 && b.t < a.b - 1 ) clash.push( `${ ids[ i ] } con ${ ids[ j ] }` );

	}

	const inside = ids.every( id => boxes.out[ id ].l >= 0 && boxes.out[ id ].r <= boxes.w + 0.5 && boxes.out[ id ].t >= 0 && boxes.out[ id ].b <= boxes.h + 0.5 );
	R.check( 'Guía, minimapa, maniobra, aviso y tablero están todos a la vista', ids.length === 5, ids.join( ', ' ) );
	R.check( 'Ninguno queda encima de otro ni fuera de la vista', clash.length === 0 && inside, clash.join( '; ' ) || 'sin cruces' );
	await sleep( page, 1500 );
	await page.screenshot( { path: `${ SHOTS }/vista-previa-05-angosta-${ width }.png` } );
	R.check( 'Sin errores', log.errors.length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
	await browser.close();

}

// ---------------------------------------------------------------------------
// 1c. Política que además exige tipos de confianza y datos guardados dañados
// ---------------------------------------------------------------------------
if ( run( 'confianza' ) ) {

	console.log( '\n# Política estricta que además exige tipos de confianza para insertar HTML' );
	const { browser, page, frame, log } = await open( { csp: STRICT + "; require-trusted-types-for 'script'" } );
	const m = await menu( frame );
	R.check( 'Arranca y la pantalla inicial queda completa', m.arranco && m.ciudades === 4 && m.camiones === 2 && m.calidades === 3 && ! m.falla, `${ m.ciudades } ciudades` );
	await frame.click( '#pista' );
	await waitState( page, frame, 'driving', 120000, 'conducción en la ciudad de pruebas' );
	R.check( 'La ciudad de pruebas carga', await game( frame, () => window.__rutaSur.truck.grounded ) );
	R.check( 'Sin errores ni pedidos a la red', log.errors.length === 0 && outside( log ).length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
	await browser.close();

}

if ( run( 'guardado' ) ) {

	console.log( '\n# Preferencias guardadas con valores inesperados' );
	const { browser, page, log } = await launch( { width: 1100, height: 700 } );
	await page.goto( GAME );
	await page.evaluate( () => localStorage.setItem( 'rutasur.config', JSON.stringify( { city: 'x"] y', truck: '<b>', quality: null, coords: 7, credential: [ 'a' ] } ) ) );
	await page.reload();
	await sleep( page, 1200 );
	const m = await page.evaluate( () => ( { listo: window.__rsGuardia.listo, falla: ! document.getElementById( 'falla' ).hidden, marcadas: [ ...document.querySelectorAll( '#menu input:checked' ) ].map( i => i.id ).join( ', ' ) } ) );
	R.check( 'El juego arranca con las opciones por defecto', m.listo && ! m.falla && m.marcadas === 'ciudad-temuco, camion-articulado, calidad-baja', m.marcadas );
	R.check( 'Sin errores', log.errors.length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
	await page.evaluate( () => localStorage.clear() );
	await browser.close();

}

// ---------------------------------------------------------------------------
// 2. Otras formas de entregar el HTML a un marco
// ---------------------------------------------------------------------------
// Con blob: y srcdoc la página no tiene una dirección que sirva de base: una
// biblioteca que arme direcciones relativas al cargar detendría el programa.
for ( const how of [ 'blob', 'srcdoc' ] ) {

	if ( ! run( how ) ) continue;
	console.log( `\n# Marco aislado con el HTML entregado como ${ how }` );
	const { browser, page, frame, log } = await open( { how } );
	const m = await menu( frame );
	R.check( `Arranca y queda completa (${ how })`, m.arranco && m.ciudades === 4 && m.camiones === 2 && ! m.falla && m.avisoFijo === 'none', await frame.url().slice( 0, 30 ) );
	await frame.click( '#pista' );
	await waitState( page, frame, 'driving', 120000, 'conducción en la ciudad de pruebas' );
	R.check( `La ciudad de pruebas carga (${ how })`, await game( frame, () => window.__rutaSur.truck.grounded ) );
	R.check( `Sin errores ni pedidos a la red (${ how })`, log.errors.length === 0 && outside( log ).length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
	await browser.close();

}

// ---------------------------------------------------------------------------
// 3. Marco con salida a la red: la respuesta de OpenStreetMap se explica
// ---------------------------------------------------------------------------
if ( run( 'abierta' ) ) {

	console.log( '\n# Marco aislado con salida a la red' );
	const { browser, page, frame, log } = await open( {} );
	// OpenStreetMap responde con un error del servicio
	let asked = 0;
	await page.route( /https:\/\/overpass[^/]*\/api\/interpreter.*/, r => { asked ++; r.fulfill( { status: 504, body: 'timeout', headers: { 'access-control-allow-origin': '*' } } ); } );
	await frame.click( '#conducir' );
	let text = '';
	for ( let i = 0; i < 120; i ++ ) { text = await game( frame, () => document.getElementById( 'carga' ).dataset.estado === 'error' ? document.getElementById( 'carga-texto' ).textContent : '' ); if ( text ) break; await sleep( page, 250 ); }
	R.check( 'Sin política que lo impida, el pedido llega al servicio y su respuesta se explica', asked >= 1 && /504/.test( text ) && ! /bloquea/.test( text ), `${ asked } pedidos: ${ text }` );
	await browser.close();

}

// ---------------------------------------------------------------------------
// 4. Vista que no ejecuta scripts
// ---------------------------------------------------------------------------
if ( run( 'sin-scripts' ) ) {

	console.log( '\n# Vista que muestra la página sin ejecutar scripts' );
	const { browser, log } = await launch( { width: 1100, height: 700 } );
	const context = await browser.newContext( { viewport: { width: 1100, height: 700 }, javaScriptEnabled: false } );
	const page = await context.newPage();
	const errors = [];
	page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	await page.goto( GAME );
	await sleep( page, 800 );
	const notice = page.locator( '#sin-motor' );
	const text = ( await notice.textContent() ).replace( /\s+/g, ' ' ).trim();
	R.check( 'Queda a la vista el aviso fijo, con la salida', await notice.isVisible() && /ruta-sur\.html/.test( text ) && /doble clic en Chrome o Edge/.test( text ), text );
	R.check( 'La pantalla inicial, que sin programa no responde, queda oculta', ! await page.locator( '#menu' ).isVisible() && ! await page.locator( '#falla' ).isVisible() );
	R.check( 'Sin errores', errors.length === 0 && log.errors.length === 0, errors.slice( 0, 3 ).join( ' | ' ) );
	await page.screenshot( { path: `${ SHOTS }/vista-previa-04-sin-scripts.png` } );
	await browser.close();

}

console.log( R.fail ? `\n${ R.fail } comprobaciones fallaron` : '\nVista previa: todo en orden' );
process.exit( R.fail ? 1 : 0 );
