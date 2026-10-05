// Prueba del juego con pantalla táctil (teléfono apaisado), sin teclado.
// Ejecutar: node tests/e2e-touch.mjs
import { launch, state, waitFor, sleep, Report, ROOT, SHOTS, GAME } from './harness.mjs';

const R = new Report();
const { browser, page, log } = await launch( { width: 800, height: 380, mobile: true } );
await page.goto( `${ GAME }?auto=test&seed=5` );
let s = await waitFor( page, s => s.state === 'driving', 240000, 'conducción' );
R.check( 'Hay un encargo ofrecido', s.jobs.state === 'offer' );
const hint = await page.textContent( '#g-pista' );
R.check( 'La guía explica el gesto táctil', /Toca aquí/.test( hint ), hint );

await page.tap( '#guia' );
await sleep( page, 400 );
s = await state( page );
R.check( 'Tocar la guía de despacho acepta el encargo', s.jobs.state === 'active' && s.truck.cargo > 0, `${ s.truck.cargo / 1000 } t` );

await page.dispatchEvent( '#t-gas', 'pointerdown' );
await waitFor( page, s => s.truck.v > 1.5, 60000, 'acelerar con el botón táctil' );
await page.dispatchEvent( '#t-gas', 'pointerup' );
s = await state( page );
R.check( 'El botón de acelerar mueve el camión', s.truck.v > 1.5, `${ ( s.truck.v * 3.6 ).toFixed( 0 ) } km/h` );
await page.dispatchEvent( '#t-freno', 'pointerdown' );
await waitFor( page, s => s.truck.v < 0.2, 60000, 'frenar con el botón táctil' );
await page.dispatchEvent( '#t-freno', 'pointerup' );
R.check( 'El botón de freno lo detiene', ( await state( page ) ).truck.v < 0.2 );

await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/tactil-00-cabina.png` } );
const layout = await page.evaluate( () => {

	const r = id => document.getElementById( id ).getBoundingClientRect();
	const a = r( 'espejo-izq' ), b = r( 'espejo-der' ), p = r( 't-pausa' ), g = r( 'guia' ), m = r( 'mapa' );
	const apart = ( u, v ) => u.right <= v.left || v.right <= u.left || u.bottom <= v.top || v.bottom <= u.top;
	return { ok: apart( a, p ) && apart( b, p ) && apart( a, g ) && apart( b, m ), a: a.toJSON(), b: b.toJSON(), p: p.toJSON() };

} );
R.check( 'Los espejos no tapan el botón de pausa, la guía ni el mapa', layout.ok, JSON.stringify( { izq: layout.a, der: layout.b, pausa: layout.p } ) );
await page.tap( '#t-cam' );
await sleep( page, 300 );
R.check( 'El botón de cámara cambia la vista', ( await state( page ) ).cam === 1 );
await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/tactil-01-exterior.png` } );

await page.tap( '#t-pausa' );
await sleep( page, 400 );
R.check( 'El botón de pausa abre la pausa', ( await state( page ) ).state === 'paused' );
await page.screenshot( { path: `${ SHOTS }/tactil-02-pausa.png` } );
const fits = await page.evaluate( () => { const r = document.querySelector( '#pausa .senal' ).getBoundingClientRect(); const c = document.getElementById( 'pausa' ); return { top: r.top, bottom: r.bottom, h: innerHeight, scroll: c.scrollHeight > c.clientHeight, overflow: getComputedStyle( c ).overflowY }; } );
R.check( 'La pausa cabe en la pantalla o se puede desplazar', ( fits.top >= 0 && fits.bottom <= fits.h ) || /auto|scroll/.test( fits.overflow ), JSON.stringify( fits ) );
await page.tap( '#p-choques' );
await sleep( page, 400 );
s = await state( page );
R.check( 'Desde la pausa se desactivan los choques y el juego sigue', s.state === 'driving' && s.ghost === true );

await page.tap( '#t-pausa' );
await sleep( page, 400 );
const label = await page.textContent( '#p-choques' );
R.check( 'El botón muestra el estado de los choques', /desactivados/.test( label ), label );
await page.tap( '#p-otro' );
await sleep( page, 400 );
s = await state( page );
R.check( 'Desde la pausa se pide otro encargo', s.state === 'driving' && s.jobs.state === 'offer' && s.truck.cargo === 0 );

await page.tap( '#t-pausa' );
await sleep( page, 300 );
await page.tap( '#p-calle' );
await sleep( page, 600 );
s = await state( page );
R.check( 'Desde la pausa se vuelve a la calle', s.state === 'driving' && s.truck.grounded );

// --- teléfono vertical: los espejos tampoco tapan los controles
await page.tap( '#t-cam' ); await sleep( page, 200 ); await page.tap( '#t-cam' ); await sleep( page, 200 ); // de exterior a cabina
R.check( 'De vuelta en la cabina', ( await state( page ) ).cam === 0 );
await page.setViewportSize( { width: 400, height: 800 } );
await sleep( page, 2500 );
const vertical = await page.evaluate( () => {

	const r = id => document.getElementById( id ).getBoundingClientRect();
	const apart = ( u, v ) => u.width === 0 || v.width === 0 || u.right <= v.left || v.right <= u.left || u.bottom <= v.top || v.bottom <= u.top;
	const out = { ok: true, rects: {} };
	for ( const e of [ 'espejo-izq', 'espejo-der' ] ) for ( const o of [ 't-pausa', 't-cam', 'guia', 'mapa', 'maniobra', 'tablero', 't-izq', 't-der', 't-gas', 't-freno' ] ) {

		if ( ! apart( r( e ), r( o ) ) ) { out.ok = false; out.rects[ e + ' vs ' + o ] = [ r( e ).toJSON(), r( o ).toJSON() ]; }

	}

	return out;

} );
R.check( 'En vertical los espejos no tapan ningún control', vertical.ok, JSON.stringify( vertical.rects ) );
await page.screenshot( { path: `${ SHOTS }/tactil-03-vertical.png` } );
R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
await browser.close();
process.exit( R.fail ? 1 : 0 );
