// Capturas de la pantalla inicial y del tablero en distintos tamaños. Ejecutar: node tests/shots.mjs
import { launch, waitFor, sleep, ROOT, SHOTS, GAME } from './harness.mjs';

for ( const [ name, opt ] of [ [ 'escritorio', { width: 1280, height: 800 } ], [ 'telefono', { width: 400, height: 800, mobile: true } ] ] ) {

	const { browser, page, log } = await launch( opt );
	await page.goto( `${ GAME }?seed=5` );
	await sleep( page, 600 );
	await page.screenshot( { path: `${ SHOTS }/menu-${ name }.png`, fullPage: true } );
	const overflow = await page.evaluate( () => document.documentElement.scrollWidth - window.innerWidth );
	console.log( `${ name }: desborde horizontal de la pantalla inicial = ${ overflow } px` );
	await page.click( '#pista' );
	await waitFor( page, s => s.state === 'driving', 240000, 'conducción' );
	await sleep( page, 2500 );
	await page.screenshot( { path: `${ SHOTS }/juego-${ name }.png` } );
	await page.keyboard.press( 'Escape' );
	await sleep( page, 800 );
	await page.screenshot( { path: `${ SHOTS }/pausa-${ name }.png` } );
	console.log( `${ name }: errores de consola = ${ log.errors.length } ${ log.errors.slice( 0, 3 ).join( ' | ' ) }` );
	await browser.close();

}

// teléfono apaisado, que es como se juega
{

	const { browser, page, log } = await launch( { width: 800, height: 380, mobile: true } );
	await page.goto( `${ GAME }?auto=test&seed=5` );
	await waitFor( page, s => s.state === 'driving', 240000, 'conducción' );
	await page.keyboard.press( 'Enter' );
	await sleep( page, 2500 );
	await page.screenshot( { path: `${ SHOTS }/juego-telefono-apaisado.png` } );
	await browser.close();

}
