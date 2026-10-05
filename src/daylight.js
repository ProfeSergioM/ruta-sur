// Ruta Sur · luz del día
// --------------------------------------------------------------------------
// El ciclo de día y noche: a partir de la hora del juego (0 a 24) entrega el
// nivel de luz, los colores del cielo y de la bruma, el tinte que oscurece la
// ciudad, la fuerza del sol y si las luces de la calle están encendidas. Es
// una función pura, sin Three.js, para poder probarla sola.
//
// El sol sube a las 6:30 y se pone a las 19:30 (una jornada larga, sin
// estaciones). Las luces se encienden poco a poco con el crepúsculo y se apagan con el alba.

export const SUNRISE = 6.5, SUNSET = 19.5;
export const DAY_SECONDS_PER_HOUR = 60; // una hora del juego dura un minuto de reloj

const DAY = { top: [ 0.247, 0.498, 0.769 ], horizon: [ 0.788, 0.859, 0.902 ], tint: [ 1, 1, 1 ] };
const DUSK = { top: [ 0.2, 0.3, 0.52 ], horizon: [ 0.9, 0.56, 0.32 ], tint: [ 0.95, 0.78, 0.62 ] };
const NIGHT = { top: [ 0.02, 0.04, 0.1 ], horizon: [ 0.09, 0.12, 0.2 ], tint: [ 0.16, 0.19, 0.3 ] };

const clamp01 = v => v < 0 ? 0 : ( v > 1 ? 1 : v );
const smooth = v => { v = clamp01( v ); return v * v * ( 3 - 2 * v ); };
const mix = ( a, b, t ) => [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ];

export const wrapHour = h => ( ( h % 24 ) + 24 ) % 24;

// Altura del sol de -1 a 1: 0 en el alba y el ocaso, 1 al mediodía solar
export function sunHeight( hour ) {

	const h = wrapHour( hour ), noon = ( SUNRISE + SUNSET ) / 2, half = ( SUNSET - SUNRISE ) / 2;
	const d = Math.min( Math.abs( h - noon ), 24 - Math.abs( h - noon ) ); // distancia circular al mediodía
	return Math.cos( Math.PI / 2 * d / half );

}

/**
 * Estado de la luz a una hora dada.
 *   level: luz ambiente de 0 (noche cerrada) a 1 (pleno día)
 *   dusk: cuánto pesa el color del crepúsculo (0 a 1)
 *   tint: multiplicador de color para la ciudad; skyTop, skyHorizon: colores del cielo y la bruma
 *   sun: fuerza del sol (0 a 1)
 *   lamps: cuánto brillan las luces de la calle y las ventanas (0 a 1), que se encienden
 *   poco a poco con el crepúsculo; lampsOn: si brillan algo
 */
export function daylight( hour ) {

	const s = sunHeight( hour );
	const level = smooth( ( s + 0.12 ) / 0.42 );        // de noche cerrada (s < -0.12) a día (s > 0.3)
	const dusk = smooth( 1 - Math.abs( s - 0.05 ) / 0.3 ); // alrededor del horizonte
	const lamps = smooth( ( 0.16 - s ) / 0.2 );            // se encienden con el sol bajo (s < 0.16) y a fondo ya oculto (s < -0.04)
	const base = mix( NIGHT.tint, DAY.tint, level );
	return {
		level, dusk,
		tint: mix( base, DUSK.tint, dusk * 0.55 ),
		skyTop: mix( mix( NIGHT.top, DAY.top, level ), DUSK.top, dusk * 0.6 ),
		skyHorizon: mix( mix( NIGHT.horizon, DAY.horizon, level ), DUSK.horizon, dusk * 0.8 ),
		sun: smooth( s / 0.35 ),
		lamps, lampsOn: lamps > 0,
	};

}

// "19:05"
export function clockText( hour ) {

	const h = wrapHour( hour ), hh = Math.floor( h ), mm = Math.floor( ( h - hh ) * 60 );
	return `${ hh }:${ mm < 10 ? '0' : '' }${ mm }`;

}
