// Ruta Sur · Fiat 600 D: datos empaquetados
// --------------------------------------------------------------------------
// Decodifica la geometría del auto, que viaja en fiat600-data.js. No depende
// de Three.js, así que el mapa abierto (puro) puede leer el nivel lejano para
// los autos estacionados, y fiat600.js arma con él las mallas del juego.
//
// Formato: 'F600', versión (2), largo de la cabecera JSON, cabecera, datos.
// Por malla: posiciones de 16 bits sobre una rejilla común (deltas en zigzag,
// separadas en byte bajo y alto), normales octaédricas de 2 x 16 bits con el
// mismo esquema, colores RGB de 8 bits en sRGB cuando la malla los lleva, e
// índices en varint relativos al vértice más alto ya visto.

import { FIAT600_DATA, FIAT600_FAR } from './fiat600-data.js';

export function base64ToBytes( b64 ) {

	const bin = atob( b64 ), n = bin.length, out = new Uint8Array( n );
	for ( let i = 0; i < n; i ++ ) out[ i ] = bin.charCodeAt( i );
	return out;

}

export async function gunzip( bytes ) {

	if ( typeof DecompressionStream === 'undefined' ) throw new Error( 'Este navegador no puede descomprimir el modelo del Fiat 600 (falta DecompressionStream).' );
	const stream = new Blob( [ bytes ] ).stream().pipeThrough( new DecompressionStream( 'gzip' ) );
	return new Response( stream ).arrayBuffer();

}

const srgbToLinear = c => ( c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 ) );
const lut = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) lut[ i ] = srgbToLinear( i / 255 );

// Devuelve { meshes: { id: { position, normal, color | null, index } }, meta }. Los colores quedan en RGB lineal.
export function decodeArrays( buffer ) {

	const u8 = new Uint8Array( buffer ), dv = new DataView( buffer );
	if ( String.fromCharCode( u8[ 0 ], u8[ 1 ], u8[ 2 ], u8[ 3 ] ) !== 'F600' || dv.getUint32( 4, true ) !== 2 ) throw new Error( 'Datos del Fiat 600 no reconocidos.' );
	const headLen = dv.getUint32( 8, true );
	const head = JSON.parse( new TextDecoder().decode( u8.subarray( 12, 12 + headLen ) ) );
	const base = 12 + headLen, mins = head.min, sc = head.scale;
	const out = {};
	for ( const m of head.meshes ) {

		const nv = m.nv;
		let o = base + m.o;
		const pos = new Float32Array( nv * 3 );
		for ( let c = 0; c < 3; c ++ ) {

			const lo = o, hi = o + nv, mn = mins[ c ];
			let acc = 0;
			for ( let i = 0; i < nv; i ++ ) {

				const z = u8[ lo + i ] | ( u8[ hi + i ] << 8 );
				acc = ( acc + ( ( z >>> 1 ) ^ - ( z & 1 ) ) ) & 0xffff;
				pos[ i * 3 + c ] = mn + acc * sc;

			}

			o += 2 * nv;

		}

		const oct = [ new Int16Array( nv ), new Int16Array( nv ) ];
		for ( let c = 0; c < 2; c ++ ) {

			const lo = o, hi = o + nv, dst = oct[ c ];
			let acc = 0;
			for ( let i = 0; i < nv; i ++ ) {

				const z = u8[ lo + i ] | ( u8[ hi + i ] << 8 );
				acc = ( acc + ( ( z >>> 1 ) ^ - ( z & 1 ) ) ) & 0xffff;
				dst[ i ] = acc;

			}

			o += 2 * nv;

		}

		const nrm = new Float32Array( nv * 3 );
		for ( let i = 0; i < nv; i ++ ) {

			let x = oct[ 0 ][ i ] / 32767, y = oct[ 1 ][ i ] / 32767;
			const z = 1 - Math.abs( x ) - Math.abs( y );
			if ( z < 0 ) { const ox = x; x = ( 1 - Math.abs( y ) ) * ( ox >= 0 ? 1 : - 1 ); y = ( 1 - Math.abs( ox ) ) * ( y >= 0 ? 1 : - 1 ); }
			const l = Math.hypot( x, y, z ) || 1;
			nrm[ i * 3 ] = x / l; nrm[ i * 3 + 1 ] = y / l; nrm[ i * 3 + 2 ] = z / l;

		}

		let col = null;
		if ( m.c ) {

			col = new Float32Array( nv * 3 );
			for ( let c = 0; c < 3; c ++ ) { for ( let i = 0; i < nv; i ++ ) col[ i * 3 + c ] = lut[ u8[ o + i ] ]; o += nv; }

		}

		const ni = m.nt * 3, idx = nv < 65536 ? new Uint16Array( ni ) : new Uint32Array( ni );
		let next = 0;
		for ( let i = 0; i < ni; i ++ ) {

			let v = 0, sh = 0, b;
			do { b = u8[ o ++ ]; v |= ( b & 0x7f ) << sh; sh += 7; } while ( b & 0x80 );
			idx[ i ] = next - v;
			if ( v === 0 ) next ++;

		}

		out[ m.id ] = { position: pos, normal: nrm, color: col, index: idx };

	}

	return { meshes: out, meta: head.meta };

}

// Los tres niveles del vehículo y de los autos cercanos, comprimidos: se decodifican una vez, en segundo plano
export function decodeLevels() { return gunzip( base64ToBytes( FIAT600_DATA ) ).then( decodeArrays ); }

// El nivel lejano para la ciudad, sin comprimir: se decodifica en el momento, también fuera del navegador
let far = null;
export function farLevel() {

	if ( ! far ) far = decodeArrays( base64ToBytes( FIAT600_FAR ).buffer );
	return far;

}
