// Pruebas del ciclo de día y noche. Ejecutar: node tests/daylight.test.mjs
import { daylight, sunHeight, clockText, wrapHour, SUNRISE, SUNSET, DAY_SECONDS_PER_HOUR } from '../src/daylight.js';

let fail = 0;
const report = ( name, ok, val = '' ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ val !== '' ? ': ' + val : '' }` ); };

report( 'El sol toca el horizonte al alba y al ocaso, y está más alto al mediodía solar', Math.abs( sunHeight( SUNRISE ) ) < 1e-9 && Math.abs( sunHeight( SUNSET ) ) < 1e-9 && Math.abs( sunHeight( 13 ) - 1 ) < 1e-9 && sunHeight( 1 ) < - 0.9, `${ sunHeight( 1 ).toFixed( 2 ) } a la 1` );
const noon = daylight( 13 ), midnight = daylight( 1 ), dusk = daylight( 19.4 ), dawn = daylight( 6.6 );
report( 'Al mediodía hay pleno día: sin tinte, sol a fondo, luces apagadas', noon.level === 1 && noon.sun === 1 && noon.tint.every( v => v === 1 ) && ! noon.lampsOn );
report( 'A medianoche es noche cerrada: tinte oscuro, sin sol, luces encendidas', midnight.level === 0 && midnight.sun === 0 && midnight.tint.every( v => v < 0.35 ) && midnight.lampsOn, midnight.tint.map( v => v.toFixed( 2 ) ).join( ',' ) );
report( 'El cielo de noche es más oscuro que el de día', midnight.skyTop[ 0 ] < noon.skyTop[ 0 ] * 0.2 && midnight.skyHorizon[ 1 ] < noon.skyHorizon[ 1 ] * 0.3 );
report( 'Al ocaso el horizonte se tiñe de naranja y las luces ya están encendidas', dusk.skyHorizon[ 0 ] > dusk.skyHorizon[ 2 ] * 1.6 && dusk.dusk > 0.6 && dusk.lampsOn, dusk.skyHorizon.map( v => v.toFixed( 2 ) ).join( ',' ) );
report( 'Al alba pasa lo mismo, en espejo', dawn.dusk > 0.6 && dawn.lampsOn && Math.abs( dawn.level - dusk.level ) < 0.05 );
// la luz crece sin saltos desde la noche hasta el mediodía
let prev = daylight( 1 ).level, monotone = true, jumps = 0;
for ( let h = 1.05; h <= 13; h += 0.05 ) { const l = daylight( h ).level; if ( l < prev - 1e-9 ) monotone = false; if ( l - prev > 0.08 ) jumps ++; prev = l; }
report( 'De madrugada a mediodía la luz solo crece y sin saltos', monotone && jumps === 0, `${ jumps } saltos` );
// luces: encendidas de noche, apagadas de día, y cada cambio ocurre una sola vez por ciclo
let changes = 0, was = daylight( 0 ).lampsOn;
for ( let h = 0; h < 24; h += 0.01 ) { const on = daylight( h ).lampsOn; if ( on !== was ) changes ++; was = on; }
report( 'Las luces se encienden una vez y se apagan una vez por ciclo', changes === 2 && daylight( 12 ).lampsOn === false && daylight( 22 ).lampsOn === true && daylight( 19.6 ).lampsOn === true && daylight( 7.2 ).lampsOn === false, `${ changes } cambios` );
// las luces se encienden poco a poco: a media tarde apagadas, en el crepúsculo a medias, de noche a fondo
report( 'Las luces se encienden de a poco y de noche brillan a fondo', daylight( 16 ).lamps === 0 && dusk.lamps > 0 && dusk.lamps < 1 && daylight( 20 ).lamps > dusk.lamps && midnight.lamps === 1, `${ dusk.lamps.toFixed( 2 ) } al ocaso, ${ daylight( 20 ).lamps.toFixed( 2 ) } a las 20` );
report( 'Reloj: horas y minutos con cero a la izquierda', clockText( 17 ) === '17:00' && clockText( 9.5 ) === '9:30' && clockText( 23.999 ) === '23:59' && clockText( 24.25 ) === '0:15' );
report( 'La hora da la vuelta a las 24', wrapHour( 25.5 ) === 1.5 && wrapHour( - 1 ) === 23 );
report( 'Una hora del juego dura un minuto de reloj', DAY_SECONDS_PER_HOUR === 60 );
console.log( fail ? `\n${ fail } pruebas fallaron.` : '\nLuz del día: todo dentro de lo esperado' );
process.exit( fail ? 1 : 0 );
