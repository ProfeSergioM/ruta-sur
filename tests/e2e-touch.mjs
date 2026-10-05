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
R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 3 ).join( ' | ' ) );
await browser.close();
process.exit( R.fail ? 1 : 0 );
