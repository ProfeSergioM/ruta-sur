// Ruta Sur · geodesia
// --------------------------------------------------------------------------
// Conversión entre coordenadas geográficas (WGS84) y el sistema local del
// juego. El origen se fija en un punto (lat0, lon0, h0) y los ejes siguen la
// misma convención que usa 3d-tiles-renderer al reorientar la malla:
//   +X = oeste, +Y = arriba, +Z = norte.
// La conversión es exacta (pasa por coordenadas ECEF), de modo que un punto de
// OpenStreetMap cae en el mismo lugar que la malla de Google.

export const WGS84_A = 6378137;
export const WGS84_F = 1 / 298.257223563;
export const WGS84_B = WGS84_A * ( 1 - WGS84_F );
const E2 = WGS84_F * ( 2 - WGS84_F );
const DEG = Math.PI / 180;

export function geodeticToEcef( latDeg, lonDeg, h = 0, out = [ 0, 0, 0 ] ) {

	const lat = latDeg * DEG, lon = lonDeg * DEG;
	const s = Math.sin( lat ), c = Math.cos( lat );
	const N = WGS84_A / Math.sqrt( 1 - E2 * s * s );
	out[ 0 ] = ( N + h ) * c * Math.cos( lon );
	out[ 1 ] = ( N + h ) * c * Math.sin( lon );
	out[ 2 ] = ( N * ( 1 - E2 ) + h ) * s;
	return out;

}

// Método de Bowring con dos iteraciones (error submilimétrico cerca de la superficie)
export function ecefToGeodetic( x, y, z, out = { lat: 0, lon: 0, h: 0 } ) {

	const p = Math.hypot( x, y );
	const lon = Math.atan2( y, x );
	const ep2 = ( WGS84_A * WGS84_A - WGS84_B * WGS84_B ) / ( WGS84_B * WGS84_B );
	let beta = Math.atan2( z * WGS84_A, p * WGS84_B );
	let lat = 0;
	for ( let i = 0; i < 3; i ++ ) {

		const sb = Math.sin( beta ), cb = Math.cos( beta );
		lat = Math.atan2( z + ep2 * WGS84_B * sb * sb * sb, p - E2 * WGS84_A * cb * cb * cb );
		beta = Math.atan2( ( 1 - WGS84_F ) * Math.sin( lat ), Math.cos( lat ) );

	}

	const s = Math.sin( lat );
	const N = WGS84_A / Math.sqrt( 1 - E2 * s * s );
	out.lat = lat / DEG;
	out.lon = lon / DEG;
	out.h = Math.abs( Math.cos( lat ) ) > 1e-6 ? p / Math.cos( lat ) - N : Math.abs( z ) - WGS84_B;
	return out;

}

export class Geo {

	constructor( lat0, lon0, h0 = 0 ) {

		this.set( lat0, lon0, h0 );

	}

	set( lat0, lon0, h0 = 0 ) {

		this.lat0 = lat0; this.lon0 = lon0; this.h0 = h0;
		this.origin = geodeticToEcef( lat0, lon0, h0 );
		const lat = lat0 * DEG, lon = lon0 * DEG;
		const sl = Math.sin( lat ), cl = Math.cos( lat ), so = Math.sin( lon ), co = Math.cos( lon );
		// vectores unitarios este, norte y arriba en ECEF
		this.e = [ - so, co, 0 ];
		this.n = [ - sl * co, - sl * so, cl ];
		this.u = [ cl * co, cl * so, sl ];
		return this;

	}

	// geográficas -> mundo. `out` recibe { x, y, z }
	toWorld( lat, lon, h = this.h0, out = { x: 0, y: 0, z: 0 } ) {

		const p = geodeticToEcef( lat, lon, h, _tmp );
		const dx = p[ 0 ] - this.origin[ 0 ], dy = p[ 1 ] - this.origin[ 1 ], dz = p[ 2 ] - this.origin[ 2 ];
		const e = dx * this.e[ 0 ] + dy * this.e[ 1 ] + dz * this.e[ 2 ];
		const n = dx * this.n[ 0 ] + dy * this.n[ 1 ] + dz * this.n[ 2 ];
		const u = dx * this.u[ 0 ] + dy * this.u[ 1 ] + dz * this.u[ 2 ];
		out.x = - e; out.y = u; out.z = n;
		return out;

	}

	// mundo -> geográficas. `out` recibe { lat, lon, h }
	toGeo( x, y, z, out = { lat: 0, lon: 0, h: 0 } ) {

		const e = - x, n = z, u = y;
		const X = this.origin[ 0 ] + e * this.e[ 0 ] + n * this.n[ 0 ] + u * this.u[ 0 ];
		const Y = this.origin[ 1 ] + e * this.e[ 1 ] + n * this.n[ 1 ] + u * this.u[ 1 ];
		const Z = this.origin[ 2 ] + e * this.e[ 2 ] + n * this.n[ 2 ] + u * this.u[ 2 ];
		return ecefToGeodetic( X, Y, Z, out );

	}

}

const _tmp = [ 0, 0, 0 ];

// Rumbo de brújula (0° = norte, sentido horario) a partir del rumbo `yaw` del camión
export function compassFromYaw( yaw ) {

	let d = ( Math.PI - yaw ) / DEG % 360;
	if ( d < 0 ) d += 360;
	return d;

}

// Rumbo `yaw` del camión para una brújula dada
export function yawFromCompass( deg ) { return Math.PI - deg * DEG; }

const ROSE = [ 'N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO' ];
export function compassName( deg ) { return ROSE[ Math.round( deg / 45 ) % 8 ]; }

// Distancia sobre la esfera, suficiente para etiquetas [m]
export function haversine( lat1, lon1, lat2, lon2 ) {

	const R = 6371008.8;
	const dLat = ( lat2 - lat1 ) * DEG, dLon = ( lon2 - lon1 ) * DEG;
	const a = Math.sin( dLat / 2 ) ** 2 + Math.cos( lat1 * DEG ) * Math.cos( lat2 * DEG ) * Math.sin( dLon / 2 ) ** 2;
	return 2 * R * Math.asin( Math.sqrt( a ) );

}
