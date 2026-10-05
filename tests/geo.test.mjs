// Comprueba que la geodesia del juego coincide con la de 3d-tiles-renderer.
import { Matrix4, Vector3, MathUtils } from 'three';
import { WGS84_ELLIPSOID, OBJECT_FRAME } from '3d-tiles-renderer';
import { Geo, compassFromYaw, yawFromCompass } from '../src/geo.js';

let fail = 0;
const origins = [ [ - 38.7397, - 72.5984, 120 ], [ - 33.4372, - 70.6506, 560 ], [ 48.8584, 2.2945, 35 ], [ 0.001, 179.999, 0 ] ];
let maxErr = 0, maxRound = 0;
for ( const [ lat0, lon0, h0 ] of origins ) {

	const geo = new Geo( lat0, lon0, h0 );
	const M = new Matrix4();
	WGS84_ELLIPSOID.getObjectFrame( lat0 * MathUtils.DEG2RAD, lon0 * MathUtils.DEG2RAD, h0, 0, 0, 0, M, OBJECT_FRAME );
	const inv = M.clone().invert();
	for ( let i = 0; i < 400; i ++ ) {

		const lat = lat0 + ( Math.sin( i * 1.7 ) ) * 0.05, lon = lon0 + ( Math.cos( i * 2.3 ) ) * 0.05, h = h0 + Math.sin( i ) * 80;
		const p = new Vector3();
		WGS84_ELLIPSOID.getCartographicToPosition( lat * MathUtils.DEG2RAD, lon * MathUtils.DEG2RAD, h, p );
		p.applyMatrix4( inv );
		const w = geo.toWorld( lat, lon, h );
		maxErr = Math.max( maxErr, Math.hypot( w.x - p.x, w.y - p.y, w.z - p.z ) );
		const g = geo.toGeo( w.x, w.y, w.z );
		const back = geo.toWorld( g.lat, g.lon, g.h );
		maxRound = Math.max( maxRound, Math.hypot( back.x - w.x, back.y - w.y, back.z - w.z ) );

	}

}

// ejes: un punto al norte debe tener +Z y uno al este debe tener -X
const geo = new Geo( - 38.7397, - 72.5984, 0 );
const north = geo.toWorld( - 38.7397 + 0.001, - 72.5984, 0 ), east = geo.toWorld( - 38.7397, - 72.5984 + 0.001, 0 );
const report = ( name, ok, val ) => { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }: ${ val }` ); };
report( 'Diferencia máxima con la biblioteca (radio de 5 km)', maxErr < 2e-3, ( maxErr * 1000 ).toFixed( 3 ) + ' mm' );
report( 'Ida y vuelta geográficas -> mundo -> geográficas', maxRound < 1e-3, ( maxRound * 1000 ).toFixed( 4 ) + ' mm' );
report( 'Un punto al norte tiene +Z', north.z > 100 && Math.abs( north.x ) < 0.01, `x=${ north.x.toFixed( 3 ) } z=${ north.z.toFixed( 3 ) }` );
report( 'Un punto al este tiene -X', east.x < - 80 && Math.abs( east.z ) < 0.01, `x=${ east.x.toFixed( 3 ) } z=${ east.z.toFixed( 3 ) }` );
report( 'yaw = 0 mira al sur', Math.abs( compassFromYaw( 0 ) - 180 ) < 1e-9, compassFromYaw( 0 ) + '°' );
report( 'yaw de la brújula 90° (este) ida y vuelta', Math.abs( compassFromYaw( yawFromCompass( 90 ) ) - 90 ) < 1e-9, compassFromYaw( yawFromCompass( 90 ) ) + '°' );
// con brújula 90° el avance (-sin yaw, -cos yaw) debe apuntar a -X (este)
const y = yawFromCompass( 90 );
report( 'Avance con brújula 90° apunta al este (-X)', Math.abs( - Math.sin( y ) + 1 ) < 1e-9 && Math.abs( Math.cos( y ) ) < 1e-9, `(${ ( - Math.sin( y ) ).toFixed( 3 ) }, ${ ( - Math.cos( y ) ).toFixed( 3 ) })` );
process.exit( fail ? 1 : 0 );
