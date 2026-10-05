// Qué muestra el juego cuando algo le impide funcionar. Ejecutar: node tests/e2e-fallas.mjs
//
// Una página que falla en silencio deja a la persona sin saber qué pasó ni qué hacer.
// Aquí se provocan las fallas y se comprueba que cada una queda explicada en pantalla,
// con un informe que se puede copiar y que no lleva rutas del computador.
import { launch, state, waitFor, sleep, Report, GAME, SHOTS, ROOT } from './harness.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const R = new Report();
const html = readFileSync( fileURLToPath( GAME ), 'utf8' );
const only = process.env.SECCIONES ? process.env.SECCIONES.split( ',' ) : null;
const run = name => ! only || only.includes( name );

// Copias del archivo con una falla puesta a propósito. La carpeta lleva un nombre de
// persona, como la ruta de descargas de un computador real: no debe aparecer en el informe.
const dir = resolve( ROOT, 'tests/tmp-fallas/Usuario Reservado' );
mkdirSync( dir, { recursive: true } );
const OPEN = '<script type="module">\n';
if ( html.split( OPEN ).length !== 2 ) throw new Error( 'No encuentro el inicio del programa en el HTML' );
const broken = ( name, change ) => { const file = resolve( dir, name ); writeFileSync( file, change( html ) ); return 'file://' + encodeURI( file ); };

const panel = page => page.evaluate( () => {

	const box = document.getElementById( 'falla' );
	return {
		visible: ! box.hidden && getComputedStyle( box ).display !== 'none',
		titulo: document.getElementById( 'falla-titulo' ).textContent,
		texto: document.getElementById( 'falla-texto' ).textContent,
		informe: document.getElementById( 'falla-informe' ).textContent,
		cerrar: ! document.getElementById( 'falla-seguir' ).hidden,
		total: window.__rsGuardia.total, listo: window.__rsGuardia.listo,
	};

} );

// ---------------------------------------------------------------------------
if ( run( 'sin-webgl' ) ) {

	console.log( '\n# Navegador sin gráficos 3D' );
	const { browser, page, context, log } = await launch( { width: 1100, height: 700 } );
	await context.addInitScript( () => {

		const original = HTMLCanvasElement.prototype.getContext;
		HTMLCanvasElement.prototype.getContext = function ( type, ...rest ) { return /webgl/i.test( type ) ? null : original.call( this, type, ...rest ); };

	} );
	await page.goto( GAME );
	await sleep( page, 1200 );
	const p = await panel( page );
	R.check( 'Sin WebGL, la página lo explica y dice qué hacer', p.visible && /Sin gráficos 3D/i.test( p.titulo ) && /WebGL 2/.test( p.texto ) && /aceleración de gráficos/.test( p.texto ) && ! p.cerrar, p.titulo );
	R.check( 'El informe identifica el navegador', /Navegador: Mozilla/.test( p.informe ) && /al arrancar/.test( p.informe ), p.informe.split( '\n' ).slice( 0, 2 ).join( ' / ' ) );
	R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
	await page.screenshot( { path: `${ SHOTS }/falla-01-sin-webgl.png` } );
	await browser.close();

}

// ---------------------------------------------------------------------------
if ( run( 'arranque' ) ) {

	console.log( '\n# El programa falla al arrancar' );
	const { browser, page } = await launch( { width: 1100, height: 700 } );
	await page.goto( broken( 'ruta-sur.html', h => h.replace( OPEN, () => OPEN + "throw new Error( 'falla de prueba' );\n" ) ) );
	await sleep( page, 1200 );
	let p = await panel( page );
	R.check( 'Una excepción al arrancar abre el informe de falla', p.visible && /no pudo arrancar/i.test( p.titulo ) && /falla de prueba/.test( p.informe ) && ! p.cerrar, p.informe.split( '\n' ).slice( - 2 ).join( ' / ' ) );
	R.check( 'El informe dice qué hacer', /doble clic en una versión reciente de Chrome o Edge/.test( p.texto ) );
	R.check( 'El informe cita el archivo sin la ruta del computador', /ruta-sur\.html:\d+/.test( p.informe ) && ! /Usuario|Reservado|file:\/|tmp-fallas|claude/.test( p.informe ), p.informe.split( '\n' ).slice( - 1 )[ 0 ].trim() );
	await page.screenshot( { path: `${ SHOTS }/falla-02-arranque.png` } );
	if ( process.env.VER_INFORME ) console.log( p.informe );

	// un error ajeno al programa, antes de que arranque: el juego arranca igual y el informe se puede cerrar
	await page.goto( broken( 'ajeno.html', h => h.replace( OPEN, () => "<script>throw new Error( 'error ajeno antes del arranque' );</script>\n" + OPEN ) ) );
	await sleep( page, 1500 );
	p = await panel( page );
	const cities = await page.evaluate( () => document.querySelectorAll( '#ciudades input' ).length );
	R.check( 'Si el juego arranca pese a un error previo, el informe no bloquea la página', p.visible && p.listo && p.cerrar && /encontró un error/.test( p.titulo ) && /error ajeno/.test( p.informe ) && cities === 4, `${ p.titulo } · ${ cities } ciudades` );
	await page.click( '#falla-seguir' );
	await page.click( '#pista' );
	await waitFor( page, st => st.state === 'driving', 240000, 'inicio de la conducción' );
	R.check( 'Tras cerrar el informe, el juego se usa con normalidad', ! ( await panel( page ) ).visible );

	// navegador que no entiende la sintaxis del programa
	await page.goto( broken( 'sintaxis.html', h => h.replace( OPEN, () => OPEN + '}{\n' ) ) );
	await sleep( page, 1200 );
	p = await panel( page );
	R.check( 'Un programa que el navegador no entiende se explica como navegador antiguo', p.visible && /no entiende el programa/.test( p.texto ) && /SyntaxError/.test( p.informe ), p.informe.split( '\n' ).slice( - 2 )[ 0 ] );

	// el programa nunca llega a ejecutarse y tampoco hay error que anotar
	await page.goto( broken( 'mudo.html', h => h.replace( OPEN, () => '<script type="text/plain">\n' ) ) );
	await sleep( page, 3000 );
	const early = await panel( page );
	await sleep( page, 6500 );
	p = await panel( page );
	R.check( 'Si el programa no da señales, a los 8 segundos se avisa igual', ! early.visible && p.visible && /no llegó a ejecutarse/.test( p.texto ) && /Sin errores anotados/.test( p.informe ), p.titulo );
	await browser.close();

}

// ---------------------------------------------------------------------------
if ( run( 'en-juego' ) ) {

	console.log( '\n# Un error durante la partida' );
	const { browser, page, context, log } = await launch( { width: 1100, height: 700 } );
	await context.grantPermissions( [ 'clipboard-read', 'clipboard-write' ] ).catch( () => {} );
	await page.goto( `${ GAME }?auto=test&q=baja&seed=11` );
	await waitFor( page, s => s.state === 'driving', 240000, 'inicio de la conducción' );
	let p = await panel( page );
	R.check( 'En una partida normal el informe no aparece', ! p.visible && p.listo && p.total === 0 );

	// un pedido cancelado no es una falla
	await page.evaluate( () => { Promise.reject( new DOMException( 'cancelado', 'AbortError' ) ); } );
	await sleep( page, 300 );
	p = await panel( page );
	R.check( 'Un pedido cancelado no cuenta como error', ! p.visible && p.total === 0 );

	await page.evaluate( () => { setTimeout( () => { throw new Error( 'error de prueba en juego' ); }, 0 ); } );
	await sleep( page, 500 );
	p = await panel( page );
	let s = await state( page );
	R.check( 'Un error sin atender abre el informe y detiene la partida', p.visible && /encontró un error/.test( p.titulo ) && /error de prueba en juego/.test( p.informe ) && p.cerrar && s.state === 'paused', `${ p.titulo } · estado ${ s.state }` );
	R.check( 'El informe dice en qué momento ocurrió y con qué gráficos', /durante el juego \(paused, ciudad de pruebas\)/.test( p.informe ) && /Gráficos: \S+/.test( p.informe ), p.informe.split( '\n' ).filter( l => /Momento|Gráficos/.test( l ) ).join( ' / ' ) );
	await page.screenshot( { path: `${ SHOTS }/falla-03-en-juego.png` } );

	await page.click( '#falla-copiar' );
	await sleep( page, 400 );
	const label = await page.textContent( '#falla-copiar' );
	const clip = await page.evaluate( () => navigator.clipboard.readText().catch( () => null ) );
	const selected = await page.evaluate( () => String( window.getSelection() ) );
	R.check( 'El informe se puede copiar: al portapapeles o, si el navegador no lo permite, queda seleccionado', ( /copiado/.test( label ) && clip && /error de prueba en juego/.test( clip ) ) || ( /Selecciónalo/.test( label ) && /error de prueba en juego/.test( selected ) ), label );

	await page.click( '#falla-seguir' );
	p = await panel( page );
	R.check( 'El informe se puede cerrar', ! p.visible );
	// un error que cita la dirección de un pedido con parámetros, una clave y un token
	const KEY = 'AIza' + 'k'.repeat( 35 ), TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJqdGkiOiJzZWNyZXRvIn0.ZmlybWE';
	await page.evaluate( ( [ key, token ] ) => { setTimeout( () => { throw new Error( `segundo error al pedir https://overpass-api.de/api/root.json?key=${ key }&session=S1 con ${ token } y ${ key }` ); }, 0 ); }, [ KEY, TOKEN ] );
	await sleep( page, 500 );
	p = await panel( page );
	R.check( 'Los errores siguientes se suman al informe sin volver a interrumpir', ! p.visible && p.total === 2 );
	const report = await page.evaluate( () => window.__rsGuardia.informe() );
	R.check( 'El informe no lleva claves ni parámetros de las direcciones', /segundo error al pedir root\.json con eyJ… y AIza…/.test( report ) && ! report.includes( KEY ) && ! report.includes( TOKEN ) && ! /session=|key=|kkkk|secreto|c2VjcmV0/.test( report ), report.split( '\n' ).find( l => /segundo error/.test( l ) ) );
	await page.click( '#seguir' );
	s = await state( page );
	R.check( 'La partida sigue', s.state === 'driving' );
	// los dos errores de prueba son los únicos de la consola
	const own = log.errors.filter( e => ! /error de prueba en juego|segundo error|cancelado/.test( e ) );
	R.check( 'Sin otros errores en la consola', own.length === 0, own.slice( 0, 3 ).join( ' | ' ) );
	await browser.close();

}

// ---------------------------------------------------------------------------
if ( run( 'contexto' ) ) {

	console.log( '\n# El navegador retira el contexto gráfico' );
	const { browser, page, log } = await launch( { width: 960, height: 540 } );
	await page.goto( `${ GAME }?auto=test&q=baja&seed=11` );
	await waitFor( page, s => s.state === 'driving', 240000, 'inicio de la conducción' );
	await sleep( page, 1500 );
	// colores distintos en la imagen, leída justo después de dibujar un cuadro
	const colors = () => page.evaluate( () => new Promise( done => requestAnimationFrame( () => {

		const c = document.createElement( 'canvas' ); c.width = 96; c.height = 54;
		const x = c.getContext( '2d' ); x.drawImage( document.getElementById( 'view' ), 0, 0, 96, 54 );
		const d = x.getImageData( 0, 0, 96, 54 ).data, set = new Set();
		for ( let i = 0; i < d.length; i += 4 ) set.add( ( d[ i ] >> 3 ) << 10 | ( d[ i + 1 ] >> 3 ) << 5 | d[ i + 2 ] >> 3 );
		done( set.size );

	} ) ) );
	const before = await colors();
	await page.evaluate( () => { window.__perder = document.getElementById( 'view' ).getContext( 'webgl2' ).getExtension( 'WEBGL_lose_context' ); window.__perder.loseContext(); } );
	await sleep( page, 800 );
	let s = await state( page );
	const notice = await page.evaluate( () => ( { visible: ! document.getElementById( 'pausa-aviso' ).hidden && ! document.getElementById( 'pausa' ).hidden, text: document.getElementById( 'pausa-aviso' ).textContent } ) );
	R.check( 'Al perder el contexto gráfico, la partida se detiene y la pausa explica el motivo', s.state === 'paused' && notice.visible && /memoria de gráficos/.test( notice.text ), notice.text.slice( 0, 70 ) + '…' );
	await page.screenshot( { path: `${ SHOTS }/falla-04-contexto.png` } );
	await page.evaluate( () => window.__perder.restoreContext() );
	await sleep( page, 1500 );
	const hidden = await page.evaluate( () => document.getElementById( 'pausa-aviso' ).hidden );
	await page.click( '#seguir' );
	await sleep( page, 2500 );
	s = await state( page );
	const after = await colors();
	R.check( 'Al volver el contexto, el aviso se retira y la partida sigue', hidden && s.state === 'driving' );
	R.check( 'La imagen vuelve a dibujarse completa', before > 20 && after >= before * 0.7, `${ before } colores antes, ${ after } después` );
	await page.screenshot( { path: `${ SHOTS }/falla-05-contexto-recuperado.png` } );
	R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
	await browser.close();

}

rmSync( resolve( ROOT, 'tests/tmp-fallas' ), { recursive: true, force: true } );
console.log( R.fail ? `\n${ R.fail } comprobaciones fallaron` : '\nFallas: todo en orden' );
process.exit( R.fail ? 1 : 0 );
