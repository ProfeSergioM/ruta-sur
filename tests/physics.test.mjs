// Validación numérica del modelo de camión. Ejecutar: node tests/physics.test.mjs
import {
	VEHICLES, PARAMS, G, createTruck, placeTruck, stepTruck, totalMass,
	trailerAxleXZ, articulation, engineTorque,
} from '../src/physics.js';

const DT = 1 / 60;
let failures = 0;
const rows = [];

function check( name, value, expected, tol, unit = '' ) {

	const ok = Math.abs( value - expected ) <= tol;
	if ( ! ok ) failures ++;
	rows.push( [ ok ? 'ok  ' : 'FALLA', name, fmt( value ) + unit, `esperado ${ fmt( expected ) }${ unit } ± ${ fmt( tol ) }` ] );

}

function within( name, value, lo, hi, unit = '' ) {

	const ok = value >= lo && value <= hi;
	if ( ! ok ) failures ++;
	rows.push( [ ok ? 'ok  ' : 'FALLA', name, fmt( value ) + unit, `rango [${ fmt( lo ) }, ${ fmt( hi ) }]${ unit }` ] );

}

function info( name, value, unit = '' ) { rows.push( [ 'info', name, fmt( value ) + unit, '' ] ); }
function fmt( v ) { return typeof v === 'number' ? ( Math.abs( v ) >= 100 ? v.toFixed( 1 ) : v.toFixed( 3 ) ) : String( v ); }

// --- terrenos analíticos ---------------------------------------------------
const flat = { sampleGround: () => 0, castObstacle: () => Infinity };
const slope = grade => ( {
	// sube hacia -Z (hacia donde mira el camión con yaw = 0)
	sampleGround: ( x, z ) => - z * grade,
	castObstacle: () => Infinity,
} );

// ruido espacial suave, determinista
function hash( i, j ) { const s = Math.sin( i * 127.1 + j * 311.7 ) * 43758.5453; return s - Math.floor( s ); }
function valueNoise( x, z, cell ) {

	const u = x / cell, v = z / cell, i = Math.floor( u ), j = Math.floor( v ), fu = u - i, fv = v - j;
	const a = hash( i, j ), b = hash( i + 1, j ), c = hash( i, j + 1 ), d = hash( i + 1, j + 1 );
	const su = fu * fu * ( 3 - 2 * fu ), sv = fv * fv * ( 3 - 2 * fv );
	return ( a + ( b - a ) * su ) * ( 1 - sv ) + ( c + ( d - c ) * su ) * sv;

}

const noisy = amp => ( {
	sampleGround: ( x, z ) => ( valueNoise( x, z, 1.3 ) - 0.5 ) * 2 * amp + ( valueNoise( x + 40, z - 7, 0.45 ) - 0.5 ) * amp,
	castObstacle: () => Infinity,
} );

const run = ( t, input, terrain, seconds, each, opts ) => {

	const n = Math.round( seconds / DT );
	for ( let i = 0; i < n; i ++ ) {

		const ev = stepTruck( t, input, terrain, DT, opts );
		if ( each && each( i * DT, ev ) === false ) return i * DT;

	}

	return seconds;

};

const A = VEHICLES.articulado, R = VEHICLES.rigido;

// === 1. Radio de giro y arrastre del remolque en régimen permanente =========
// Se fija la velocidad y se pide un ángulo de rueda constante; los radios se
// miden sobre la trayectoria (semiamplitud de la última vuelta).
function steadyTurn( delta, seconds, lapSeconds ) {

	const t = createTruck( A, { cargoMass: 0 } );
	placeTruck( t, 0, 0, 0, flat );
	const v0 = 2.0, inp = { accel: 0, decel: 0, steer: delta / A.tractor.maxSteer };
	const box = () => ( { x0: Infinity, x1: - Infinity, z0: Infinity, z1: - Infinity } );
	const grow = ( b, x, z ) => { b.x0 = Math.min( b.x0, x ); b.x1 = Math.max( b.x1, x ); b.z0 = Math.min( b.z0, z ); b.z1 = Math.max( b.z1, z ); };
	const rear = box(), axle = box(), corner = box();
	const n = Math.round( seconds / DT ), nLap = Math.round( lapSeconds / DT );
	const tr = A.tractor;
	for ( let i = 0; i < n; i ++ ) {

		t.v = v0;
		stepTruck( t, inp, flat, DT );
		if ( i >= n - nLap ) {

			grow( rear, t.x, t.z );
			const ax = trailerAxleXZ( t ); grow( axle, ax.x, ax.z );
			// esquina delantera exterior (lado derecho en un giro a la izquierda)
			const d = tr.wheelbase + tr.frontOverhang, w = tr.width / 2;
			grow( corner, t.x - Math.sin( t.yaw ) * d + Math.cos( t.yaw ) * w, t.z - Math.cos( t.yaw ) * d - Math.sin( t.yaw ) * w );

		}

	}

	const rad = b => 0.25 * ( ( b.x1 - b.x0 ) + ( b.z1 - b.z0 ) );
	return { t, rRear: rad( rear ), rAxle: rad( axle ), rCorner: rad( corner ), steer: t.steer };

}

{

	const delta = 0.35;
	const L = A.tractor.wheelbase, e = A.tractor.hitch, Lt = A.trailer.wheelbase;
	const Rteo = L / Math.tan( delta );
	const lap = 2 * Math.PI * Rteo / 2.0;
	const r = steadyTurn( delta, 60 + lap * 1.1, lap * 1.05 );
	check( 'Ángulo de rueda aplicado', r.steer, delta, 1e-6, ' rad' );
	check( 'Radio del eje trasero (δ = 20°)', r.rRear, Rteo, 0.03, ' m' );
	const gammaTeo = Math.asin( Lt / Math.hypot( Rteo, e ) ) - Math.atan( e / Rteo );
	check( 'Ángulo de articulación permanente', articulation( r.t ) * 180 / Math.PI, gammaTeo * 180 / Math.PI, 0.2, '°' );
	check( 'Radio del eje del remolque', r.rAxle, Math.sqrt( Rteo * Rteo + e * e - Lt * Lt ), 0.03, ' m' );

}

// === 2. Corona de giro reglamentaria (Directiva 96/53/CE: 12,5 m y 5,3 m) ===
{

	const tr = A.tractor, tl = A.trailer;
	// radio del eje trasero para que la esquina delantera exterior describa 12,5 m
	const lat = Math.sqrt( 12.5 * 12.5 - ( tr.wheelbase + tr.frontOverhang ) ** 2 );
	const Rrear = lat - tr.width / 2;
	const delta = Math.atan( tr.wheelbase / Rrear );
	const lap = 2 * Math.PI * Rrear / 2.0;
	const r = steadyTurn( delta, 80 + lap * 1.1, lap * 1.05 );
	info( 'Giro reglamentario: ángulo de rueda necesario', delta * 180 / Math.PI, '°' );
	check( 'Giro reglamentario: radio exterior barrido', r.rCorner, 12.5, 0.03, ' m' );
	within( 'Giro reglamentario: radio interior barrido (mínimo legal 5,3 m)', r.rAxle - tl.width / 2, 5.3, 5.6, ' m' );

}

// === 3. Aceleración ========================================================
function accelTimes( spec, cargo ) {

	const t = createTruck( spec, { cargoMass: cargo } );
	placeTruck( t, 0, 0, 0, flat );
	const out = { t30: NaN, t50: NaN, t80: NaN, shifts: 0, vmax: 0, aMax: 0 };
	run( t, { accel: 1, decel: 0, steer: 0 }, flat, 240, ( time, ev ) => {

		const k = t.v * 3.6;
		if ( ev.shift ) out.shifts ++;
		if ( k >= 30 && isNaN( out.t30 ) ) out.t30 = time;
		if ( k >= 50 && isNaN( out.t50 ) ) out.t50 = time;
		if ( k >= 80 && isNaN( out.t80 ) ) out.t80 = time;
		out.vmax = Math.max( out.vmax, k );
		out.aMax = Math.max( out.aMax, t.aLong );

	} );
	out.mass = totalMass( t );
	out.gear = t.gear; out.rpm = t.rpm;
	return out;

}

{

	const full = accelTimes( A, 25000 );
	info( 'Articulado cargado: masa total', full.mass / 1000, ' t' );
	within( 'Articulado 39 t: 0 a 50 km/h', full.t50, 14, 30, ' s' );
	within( 'Articulado 39 t: 0 a 80 km/h', full.t80, 35, 75, ' s' );
	within( 'Articulado 39 t: aceleración máxima', full.aMax, 0.8, 2.2, ' m/s²' );
	check( 'Articulado: velocidad con limitador', full.vmax, 90, 1.5, ' km/h' );
	within( 'Articulado: régimen a 90 km/h en 12.ª', full.rpm, 1150, 1450, ' rpm' );
	info( 'Articulado 39 t: cambios hasta el limitador', full.shifts );

	const empty = accelTimes( A, 0 );
	within( 'Articulado vacío (14 t): 0 a 50 km/h', empty.t50, 5, 14, ' s' );
	const rig = accelTimes( R, 8000 );
	within( 'Rígido 16,5 t: 0 a 50 km/h', rig.t50, 8, 22, ' s' );
	check( 'Rígido: velocidad con limitador', rig.vmax, 90, 1.5, ' km/h' );

}

// === 4. Frenado ============================================================
function brakeDistance( spec, cargo, kmh ) {

	const t = createTruck( spec, { cargoMass: cargo } );
	placeTruck( t, 0, 0, 0, flat );
	t.v = kmh / 3.6; t.gear = spec.engine.gears.length;
	const z0 = t.z;
	let time = 0;
	run( t, { accel: 0, decel: 1, steer: 0 }, flat, 30, tt => { time = tt; return t.v > 0; } );
	return { d: Math.abs( t.z - z0 ), time, dir: t.dir };

}

{

	const b50 = brakeDistance( A, 25000, 50 );
	// distancia ideal v²/(2a) más el tiempo de subida del pedal (0,2 s)
	const ideal = ( 50 / 3.6 ) ** 2 / ( 2 * PARAMS.brakeDecel );
	within( 'Frenado desde 50 km/h', b50.d, ideal, ideal + 4, ' m' );
	const b80 = brakeDistance( A, 25000, 80 );
	within( 'Frenado desde 80 km/h', b80.d, 40, 55, ' m' );
	check( 'Tras frenar hasta detenerse sigue en directa', b50.dir, 1, 0 );

}

// === 5. Pendiente ==========================================================
{

	const grade = 0.06;
	const t = createTruck( A, { cargoMass: 25000 } );
	const terr = slope( grade );
	placeTruck( t, 0, 0, 0, terr );
	t.v = 12; t.gear = 8;
	run( t, { accel: 1, decel: 0, steer: 0 }, terr, 180 );
	// balance de potencia: P·η = (m g sinθ + rodadura + aire)·v
	const m = totalMass( t ), th = Math.atan( grade );
	let v = 10;
	for ( let i = 0; i < 200; i ++ ) {

		const F = m * G * Math.sin( th ) + PARAMS.crr * m * G + 0.5 * PARAMS.rho * PARAMS.cdA * v * v;
		v = A.engine.power * A.engine.efficiency / F;

	}

	info( 'Subida de 6 %: velocidad de equilibrio teórica (potencia máxima)', v * 3.6, ' km/h' );
	within( 'Subida de 6 % a 39 t: velocidad estabilizada', t.v * 3.6, v * 3.6 * 0.8, v * 3.6 * 1.02, ' km/h' );
	check( 'Subida de 6 %: cabeceo medido', t.pitch * 180 / Math.PI, th * 180 / Math.PI, 0.1, '°' );

	// partida en subida sin retroceso
	const t2 = createTruck( A, { cargoMass: 25000 } );
	const steep = slope( 0.10 );
	placeTruck( t2, 0, 0, 0, steep );
	let minV = 0;
	run( t2, { accel: 0, decel: 0, steer: 0 }, steep, 3, () => { minV = Math.min( minV, t2.v ); } );
	check( 'Detenido en 10 %: no rueda sin freno', minV, 0, 1e-6, ' m/s' );
	run( t2, { accel: 1, decel: 0, steer: 0 }, steep, 12, () => { minV = Math.min( minV, t2.v ); } );
	check( 'Partida en 10 %: retroceso', minV, 0, 1e-6, ' m/s' );
	within( 'Partida en 10 %: velocidad a los 12 s', t2.v * 3.6, 8, 40, ' km/h' );

}

// === 6. Reversa: sentido de marcha y efecto tijera ==========================
{

	const t = createTruck( A, { cargoMass: 10000 } );
	placeTruck( t, 0, 0, 0, flat );
	run( t, { accel: 0, decel: 1, steer: 0 }, flat, 0.2 );
	check( 'Reversa: no engancha antes de 0,25 s', t.dir, 1, 0 );
	run( t, { accel: 0, decel: 1, steer: 0 }, flat, 6 );
	check( 'Reversa: engancha con "atrás" mantenido', t.dir, - 1, 0 );
	within( 'Reversa: velocidad estabilizada', - t.v * 3.6, 5, 10, ' km/h' );
	within( 'Reversa recta sin perturbación: articulación', Math.abs( articulation( t ) ) * 180 / Math.PI, 0, 0.01, '°' );

	// con una perturbación inicial de 2° el ángulo crece hasta la tijera
	const t2 = createTruck( A, { cargoMass: 10000 } );
	placeTruck( t2, 0, 0, 0, flat );
	t2.trailerYaw = 2 * Math.PI / 180;
	let jack = NaN, g5 = NaN;
	run( t2, { accel: 0, decel: 1, steer: 0 }, flat, 60, ( time, ev ) => {

		if ( isNaN( g5 ) && Math.abs( articulation( t2 ) ) > 10 * Math.PI / 180 ) g5 = time;
		if ( ev.jackknife ) { jack = time; return false; }

	} );
	within( 'Reversa con 2° iniciales: tiempo hasta 10°', g5, 2, 20, ' s' );
	within( 'Reversa con 2° iniciales: tiempo hasta la tijera', jack, 5, 40, ' s' );
	check( 'Tijera: el camión queda detenido', t2.v, 0, 1e-9, ' m/s' );
	run( t2, { accel: 0, decel: 1, steer: 0 }, flat, 3 );
	check( 'Tijera: la reversa queda bloqueada', t2.v, 0, 1e-9, ' m/s' );
	run( t2, { accel: 1, decel: 0, steer: 0 }, flat, 8 );
	within( 'Tijera: avanzar endereza la articulación', Math.abs( articulation( t2 ) ) * 180 / Math.PI, 0, 25, '°' );
	check( 'Tijera: se libera al avanzar', t2.jackknife ? 1 : 0, 0, 0 );

	// control de reversa: un conductor que corrige mantiene el remolque recto
	const t3 = createTruck( A, { cargoMass: 10000 } );
	placeTruck( t3, 0, 0, 0, flat );
	t3.trailerYaw = 4 * Math.PI / 180;
	let maxG = 0;
	run( t3, { accel: 0, decel: 1, steer: 0 }, flat, 0.5 );
	const inp = { accel: 0, decel: 0.5, steer: 0 };
	run( t3, inp, flat, 40, time => {

		// al retroceder, girar hacia el lado del ángulo lo reduce
		const g = articulation( t3 );
		inp.steer = Math.max( - 1, Math.min( 1, g * 6 ) );
		if ( time > 20 ) maxG = Math.max( maxG, Math.abs( g ) );

	} );
	within( 'Reversa con corrección de volante: articulación residual', maxG * 180 / Math.PI, 0, 3, '°' );

}

// === 7. Malla ruidosa: comodidad de marcha =================================
function rideQuality( amp, kmh ) {

	const t = createTruck( A, { cargoMass: 15000 } );
	const terr = noisy( amp );
	placeTruck( t, 0, 0, 0, terr );
	t.v = kmh / 3.6; t.gear = 9;
	let sP = 0, sR = 0, sA = 0, n = 0, prevVy = 0, prevY = t.y, maxJump = 0, meanP = 0, meanR = 0;
	const samplesP = [], samplesR = [];
	run( t, { accel: 0.35, decel: 0, steer: 0 }, terr, 30, () => {

		t.v = kmh / 3.6;
		const vy = ( t.y - prevY ) / DT;
		const ay = ( vy - prevVy ) / DT;
		maxJump = Math.max( maxJump, Math.abs( t.y - prevY ) );
		prevY = t.y; prevVy = vy;
		samplesP.push( t.pitch ); samplesR.push( t.roll );
		sA += ay * ay; n ++;

	} );
	meanP = samplesP.reduce( ( a, b ) => a + b, 0 ) / n; meanR = samplesR.reduce( ( a, b ) => a + b, 0 ) / n;
	for ( let i = 0; i < n; i ++ ) { sP += ( samplesP[ i ] - meanP ) ** 2; sR += ( samplesR[ i ] - meanR ) ** 2; }
	return {
		pitchRms: Math.sqrt( sP / n ) * 180 / Math.PI,
		rollRms: Math.sqrt( sR / n ) * 180 / Math.PI,
		accRms: Math.sqrt( sA / n ),
		maxJump,
	};

}

{

	const q = rideQuality( 0.08, 40 );
	within( 'Malla con ±8 cm de ruido a 40 km/h: cabeceo RMS', q.pitchRms, 0, 0.8, '°' );
	within( 'Malla con ±8 cm de ruido a 40 km/h: alabeo RMS', q.rollRms, 0, 1.2, '°' );
	within( 'Malla con ±8 cm: aceleración vertical RMS', q.accRms, 0, 3.0, ' m/s²' );
	info( 'Malla con ±8 cm: mayor salto vertical por cuadro', q.maxJump * 100, ' cm' );
	const q2 = rideQuality( 0.2, 40 );
	info( 'Malla con ±20 cm de ruido a 40 km/h: cabeceo RMS', q2.pitchRms, '°' );
	info( 'Malla con ±20 cm: aceleración vertical RMS', q2.accRms, ' m/s²' );

}

// === 8. Salto de nivel de detalle: el suelo sube 0,8 m de golpe ============
{

	let h = 0;
	const terr = { sampleGround: () => h, castObstacle: () => Infinity };
	const t = createTruck( A );
	placeTruck( t, 0, 0, 0, terr );
	h = 0.8;
	let t95 = NaN, peak = 0, vmax = 0, prev = t.y;
	run( t, { accel: 0, decel: 0, steer: 0 }, terr, 3, time => {

		vmax = Math.max( vmax, Math.abs( t.y - prev ) / DT ); prev = t.y;
		peak = Math.max( peak, t.y );
		if ( isNaN( t95 ) && t.y >= 0.95 * 0.8 ) t95 = time;

	} );
	within( 'Salto de 0,8 m: tiempo al 95 %', t95, 0.15, 0.5, ' s' );
	within( 'Salto de 0,8 m: sobrepaso', ( peak - 0.8 ) / 0.8 * 100, 0, 8, ' %' );
	info( 'Salto de 0,8 m: velocidad vertical máxima', vmax, ' m/s' );
	check( 'Salto de 0,8 m: altura final', t.y, 0.8, 0.005, ' m' );

}

// === 9. Bultos de la malla y el seguidor del plano de rodadura ==============
// agrega la normal de la superficie por diferencias finitas, como la entrega un rayo sobre la malla
function withNormals( fn ) {

	const terr = {
		ny: 1,
		sampleGround( x, z, yRef ) {

			const h = fn( x, z, yRef ), e = 0.02;
			const dx = ( fn( x + e, z, yRef ) - fn( x - e, z, yRef ) ) / ( 2 * e ), dz = ( fn( x, z + e, yRef ) - fn( x, z - e, yRef ) ) / ( 2 * e );
			this.ny = ( dx === dx && dz === dz ) ? 1 / Math.sqrt( 1 + dx * dx + dz * dz ) : 1;
			return h;

		},
		castObstacle: () => Infinity,
	};
	return terr;

}

function crossing( sampleGround, { v = 5, seconds = 12, collisions = true, each, normals = false } = {} ) {

	const terr = normals ? withNormals( sampleGround ) : { sampleGround, castObstacle: () => Infinity };
	const t = createTruck( A, { cargoMass: 15000 } );
	placeTruck( t, 0, 0, 0, terr );
	const out = { maxRoll: 0, maxPitch: 0, maxY: - Infinity, minY: Infinity, maxTY: - Infinity, flagged: 0, t };
	const n = Math.round( seconds / DT );
	for ( let i = 0; i < n; i ++ ) {

		t.v = v; t.gear = 4;
		if ( each ) each( t, i * DT );
		stepTruck( t, { accel: 0.2, decel: 0, steer: 0 }, terr, DT, { collisions } );
		out.maxRoll = Math.max( out.maxRoll, Math.abs( t.roll ) * 180 / Math.PI );
		out.maxPitch = Math.max( out.maxPitch, Math.abs( t.pitch ) * 180 / Math.PI );
		out.maxY = Math.max( out.maxY, t.y, t.hF ); out.minY = Math.min( out.minY, t.y );
		out.maxTY = Math.max( out.maxTY, t.trailerY );
		if ( t.gTr.rejected || t.gTl.rejected ) out.flagged ++;

	}

	return out;

}

{

	// a) auto "derretido" de 1,4 m bajo las ruedas izquierdas, más corto que la distancia entre ejes
	let q = crossing( ( x, z ) => ( x < - 0.3 && z < - 20 && z > - 22 ) ? 1.4 : 0 );
	within( 'Bulto de 1,4 m bajo una rueda: alabeo máximo', q.maxRoll, 0, 1.5, '°' );
	within( 'Bulto de 1,4 m bajo una rueda: elevación máxima', q.maxY, 0, 0.06, ' m' );

	// b) hilera de autos de 1,4 m bajo todo el lado izquierdo (6 m)
	q = crossing( ( x, z ) => ( x < - 0.3 && z < - 20 && z > - 26 ) ? 1.4 : 0 );
	within( 'Hilera de 1,4 m bajo un lado: alabeo máximo', q.maxRoll, 0, 1.5, '°' );
	within( 'Hilera de 1,4 m bajo un lado: elevación máxima', q.maxY, 0, 0.06, ' m' );

	// c) bulto de 0,8 m a todo el ancho y 4,5 m de largo (no lo ven las sondas de 1 m)
	q = crossing( ( x, z ) => ( z < - 20 && z > - 24.5 ) ? 0.8 : 0 );
	within( 'Bulto de 0,8 m a todo el ancho: cabeceo máximo', q.maxPitch, 0, 1.5, '°' );
	within( 'Bulto de 0,8 m a todo el ancho: elevación máxima', q.maxY, 0, 0.08, ' m' );
	check( 'Bulto de 0,8 m: altura al salir', q.t.y, 0, 0.01, ' m' );

	// d) paso bajo una estructura con los choques desactivados: la malla solo ofrece el tablero, 5,2 m más arriba
	q = crossing( ( x, z ) => ( z < - 20 && z > - 50 ) ? 5.2 : 0, { collisions: false, seconds: 16 } );
	within( 'Paso bajo estructura de 30 m: elevación máxima del tracto', q.maxY, 0, 0.05, ' m' );
	within( 'Paso bajo estructura de 30 m: elevación máxima del remolque', q.maxTY, 0, 0.05, ' m' );

	// e) tramo sin malla cargada (muestras NaN) de 15 m
	q = crossing( ( x, z ) => ( z < - 20 && z > - 35 ) ? NaN : 0 );
	check( 'Tramo de 15 m sin malla: la postura se conserva', q.maxY - q.minY, 0, 0.01, ' m' );

	// f) rampa legítima: sube 0,5 m en 2 m (25 %). Se mide el error de seguimiento del eje delantero.
	const ramp = ( x, z ) => z > - 20 ? 0 : ( z > - 22 ? ( - 20 - z ) * 0.25 : 0.5 );
	for ( const v of [ 3, 10 ] ) {

		let err = 0;
		q = crossing( ramp, { v, each: t => { err = Math.max( err, Math.abs( t.hF - ramp( 0, t.z - A.tractor.wheelbase ) ) ); } } );
		check( `Rampa de 25 % a ${ ( v * 3.6 ).toFixed( 0 ) } km/h: altura final`, q.t.y, 0.5, 0.01, ' m' );
		// caso extremo: el eje se hunde un momento en la rampa por el retardo del filtro
		within( `Rampa de 25 % a ${ ( v * 3.6 ).toFixed( 0 ) } km/h: error máximo del eje delantero`, err, 0, v < 5 ? 0.25 : 0.4, ' m' );

	}

	// quiebre suave, el caso habitual en una calle: de plano a 8 % a 50 km/h
	{

		const hinge = ( x, z ) => z > - 30 ? 0 : ( - 30 - z ) * 0.08;
		let err = 0;
		q = crossing( hinge, { v: 13.9, seconds: 6, each: t => { err = Math.max( err, Math.abs( t.hF - hinge( 0, t.z - A.tractor.wheelbase ) ) ); } } );
		within( 'Quiebre de 0 a 8 % a 50 km/h: error máximo del eje delantero', err, 0, 0.12, ' m' );
		check( 'Quiebre de 0 a 8 % a 50 km/h: muestras rechazadas', q.flagged, 0, 0 );

	}

	// g) cuesta de 15 % que empieza de golpe, a 90 km/h
	q = crossing( ( x, z ) => z > - 30 ? 0 : ( - 30 - z ) * 0.15, { v: 25, seconds: 6 } );
	check( 'Cuesta de 15 % a 90 km/h: muestras rechazadas', q.flagged, 0, 0 );
	check( 'Cuesta de 15 % a 90 km/h: cabeceo final', q.t.pitch * 180 / Math.PI, Math.atan( 0.15 ) * 180 / Math.PI, 0.3, '°' );

	// h) escalón hacia abajo de 0,6 m: el camión baja con él
	q = crossing( ( x, z ) => z > - 20 ? 0.6 : 0, { v: 5, seconds: 8 } );
	check( 'Escalón de 0,6 m hacia abajo: altura final', q.t.y, 0, 0.01, ' m' );

	// i) cambio de nivel de detalle con el camión en marcha: el suelo sube 0,8 m en todas partes
	let h = 0, tPop = NaN, tAcq = NaN;
	q = crossing( () => h, { v: 8, seconds: 8, each: ( t, time ) => {

		if ( time >= 2 && h === 0 ) { h = 0.8; tPop = time; }
		if ( isNaN( tAcq ) && h > 0 && t.y > 0.76 ) tAcq = time - tPop;

	} } );
	within( 'Cambio de nivel de detalle en marcha (+0,8 m): tiempo de ajuste', tAcq, 0.05, 0.5, ' s' );

}

// === 9b. Montículos con costados inclinados (la forma real de un auto en la malla)
{

	const mound = side => ( x, z ) => {

		const s = - 20 - z; // distancia recorrida dentro del montículo
		const len = 3.6 + 2 * 0.9 / side;
		if ( s < 0 || s > len ) return 0;
		return Math.min( 0.9, s * side, ( len - s ) * side );

	};
	// costados a 45°: la normal los descarta
	let q = crossing( mound( 1 ), { v: 1, seconds: 40, normals: true } );
	within( 'Montículo de 0,9 m, costados a 45°, a 3,6 km/h: elevación máxima', q.maxY, 0, 0.12, ' m' );
	within( 'Montículo de 0,9 m, costados a 45°, a 3,6 km/h: cabeceo máximo', q.maxPitch, 0, 2, '°' );
	check( 'Montículo a 45°: altura al salir', q.t.y, 0, 0.01, ' m' );
	q = crossing( mound( 1 ), { v: 5, seconds: 12, normals: true } );
	within( 'Montículo de 0,9 m, costados a 45°, a 18 km/h: elevación máxima', q.maxY, 0, 0.12, ' m' );
	// costados a 30°: los frena el límite de giro del plano
	q = crossing( mound( 0.577 ), { v: 1, seconds: 40, normals: true } );
	within( 'Montículo de 0,9 m, costados a 30°, a 3,6 km/h: elevación máxima', q.maxY, 0, 0.45, ' m' );
	info( 'Montículo de 0,9 m, costados a 30°, a 3,6 km/h: cabeceo máximo', q.maxPitch, '°' );
	check( 'Montículo a 30°: altura al salir', q.t.y, 0, 0.01, ' m' );
	q = crossing( mound( 0.577 ), { v: 5, seconds: 12, normals: true } );
	within( 'Montículo de 0,9 m, costados a 30°, a 18 km/h: elevación máxima', q.maxY, 0, 0.45, ' m' );

	// lomo de toro reglamentario (0,1 m de alto, 3,7 m de largo): se sigue entero
	const hump = ( x, z ) => { const s = - 20 - z; return ( s < 0 || s > 3.7 ) ? 0 : 0.1 * Math.sin( Math.PI * s / 3.7 ); };
	let top = 0;
	q = crossing( hump, { v: 5, seconds: 8, normals: true, each: t => { top = Math.max( top, t.hF ); } } );
	within( 'Lomo de toro de 10 cm a 18 km/h: elevación del eje delantero', top, 0.05, 0.12, ' m' );
	check( 'Lomo de toro: muestras rechazadas', q.flagged, 0, 0 );

}

// === 9c. Camión rígido ======================================================
{

	const t = createTruck( R, { cargoMass: 6000 } );
	placeTruck( t, 0, 0, 0, flat );
	const delta = 0.4, v0 = 2;
	let x0 = Infinity, x1 = - Infinity;
	const lap = 2 * Math.PI * ( R.tractor.wheelbase / Math.tan( delta ) ) / v0;
	const n = Math.round( ( 20 + lap * 1.1 ) / DT );
	for ( let i = 0; i < n; i ++ ) {

		t.v = v0;
		stepTruck( t, { accel: 0, decel: 0, steer: delta / R.tractor.maxSteer }, flat, DT );
		if ( i > 20 / DT ) { x0 = Math.min( x0, t.x ); x1 = Math.max( x1, t.x ); }

	}

	check( 'Rígido: radio del eje trasero (δ = 23°)', ( x1 - x0 ) / 2, R.tractor.wheelbase / Math.tan( delta ), 0.03, ' m' );
	const terr = { sampleGround: ( x, z ) => ( x < - 0.3 && z < - 20 && z > - 26 ) ? 1.4 : 0, castObstacle: () => Infinity };
	const t2 = createTruck( R, { cargoMass: 6000 } );
	placeTruck( t2, 0, 0, 0, terr );
	let maxRoll = 0;
	for ( let i = 0; i < 12 / DT; i ++ ) { t2.v = 5; stepTruck( t2, { accel: 0.2, decel: 0, steer: 0 }, terr, DT ); maxRoll = Math.max( maxRoll, Math.abs( t2.roll ) ); }
	within( 'Rígido: hilera de 1,4 m bajo un lado, alabeo máximo', maxRoll * 180 / Math.PI, 0, 1.5, '°' );

}

// === 10. Choque contra un muro =============================================
function wallTest( kmh, reverse = false, collisions = true ) {

	const wallZ = reverse ? 30 : - 14;
	const terr = {
		sampleGround: () => 0,
		castObstacle: ( ox, oy, oz, dx, dy, dz, max ) => {

			if ( Math.abs( dz ) < 1e-9 ) return Infinity;
			const d = ( wallZ - oz ) / dz;
			return d >= 0 && d <= max ? d : Infinity;

		},
	};
	const t = createTruck( A, { cargoMass: 15000 } );
	placeTruck( t, 0, 0, 0, terr );
	let impact = 0;
	if ( ! reverse ) {

		t.v = kmh / 3.6; t.gear = 6;
		run( t, { accel: 0, decel: 0, steer: 0 }, terr, 6, ( time, ev ) => { if ( ev.impact ) impact = Math.max( impact, ev.impact ); }, { collisions } );
		const bumper = t.z - ( A.tractor.wheelbase + A.tractor.frontOverhang );
		return { gap: bumper - wallZ, impact, damage: t.damage, v: t.v };

	} else {

		run( t, { accel: 0, decel: 1, steer: 0 }, terr, 30, ( time, ev ) => { if ( ev.impact ) impact = Math.max( impact, ev.impact ); } );
		const ax = trailerAxleXZ( t );
		const tail = ax.z + ( A.trailer.length - A.trailer.kingpinFromFront - A.trailer.wheelbase );
		return { gap: wallZ - tail, impact, damage: t.damage, v: t.v };

	}

}

{

	const w = wallTest( 20 );
	within( 'Muro a 20 km/h: separación final del parachoques', w.gap, 0.0, PARAMS.probeMargin + 0.01, ' m' );
	within( 'Muro a 20 km/h: velocidad de impacto registrada', w.impact * 3.6, 18, 20, ' km/h' );
	within( 'Muro a 20 km/h: daño', w.damage * 100, 8, 12, ' %' );
	const w2 = wallTest( 60 );
	within( 'Muro a 60 km/h: separación final', w2.gap, 0.0, PARAMS.probeMargin + 0.01, ' m' );
	within( 'Muro a 60 km/h: daño', w2.damage * 100, 90, 100, ' %' );
	const w3 = wallTest( 0, true );
	within( 'Muro en reversa: separación final de la cola', w3.gap, 0.0, PARAMS.probeMargin + 0.01, ' m' );
	within( 'Muro en reversa: daño (toque a menos de 10 km/h)', w3.damage * 100, 0, 4, ' %' );
	const w4 = wallTest( 20, false, false );
	within( 'Choques desactivados: el camión atraviesa el muro', - w4.gap, 5, 60, ' m' );
	check( 'Choques desactivados: daño', w4.damage, 0, 0 );

}

// === 10b. Choques laterales ================================================
// Edificios como cajas verticales en planta. El rayo se corta con cada caja en
// X y Z (las cajas son más altas que las sondas) y se entrega la normal de la
// cara tocada, como hace el mundo real.
function boxTerrain( boxes ) {

	const normal = new Float64Array( 3 );
	return {
		normal,
		rays: 0,
		sampleGround: () => 0,
		castObstacle( ox, oy, oz, dx, dy, dz, max ) {

			this.rays ++;
			let best = Infinity;
			for ( const b of boxes ) {

				let tin = 0, tout = max, axis = - 1, sign = 0;
				for ( const [ o, d, lo, hi, ax ] of [ [ ox, dx, b.x0, b.x1, 0 ], [ oz, dz, b.z0, b.z1, 2 ] ] ) {

					if ( Math.abs( d ) < 1e-12 ) { if ( o < lo || o > hi ) { tin = Infinity; break; } continue; }
					let t1 = ( lo - o ) / d, t2 = ( hi - o ) / d, s = - 1;
					if ( t1 > t2 ) { [ t1, t2 ] = [ t2, t1 ]; s = 1; }
					if ( t1 > tin ) { tin = t1; axis = ax; sign = s; }
					tout = Math.min( tout, t2 );
					if ( tin > tout ) { tin = Infinity; break; }

				}

				// un origen dentro de la caja no ve sus caras, como un rayo contra caras de un solo lado
				if ( tin > 0 && tin <= max && tin < best ) { best = tin; normal.fill( 0 ); normal[ axis ] = sign; }

			}

			return best;

		},
	};

}

// Posición de un punto en el marco del remolque: `lat` positivo a la derecha, `lon` hacia adelante, desde el eje
function inTrailerFrame( t, px, pz ) {

	const ax = trailerAxleXZ( t ), yaw = t.trailerYaw;
	const dx = px - ax.x, dz = pz - ax.z;
	return { lat: dx * Math.cos( yaw ) - dz * Math.sin( yaw ), lon: - dx * Math.sin( yaw ) - dz * Math.cos( yaw ) };

}

{

	const halfT = A.trailer.width / 2;
	// a) muro paralelo a 0,6 m del costado izquierdo (x negativo): la marcha recta no toca nada
	const wallX = - halfT - 0.6;
	const along = boxTerrain( [ { x0: - 12, x1: wallX, z0: - 60, z1: 20 } ] );
	const t = createTruck( A, { cargoMass: 15000 } );
	placeTruck( t, 0, 0, 0, along );
	t.v = 8; t.gear = 6;
	let side = 0, impacts = 0;
	run( t, { accel: 0.4, decel: 0, steer: 0 }, along, 5, ( time, ev ) => { if ( ev.side ) side ++; if ( ev.impact ) impacts ++; } );
	check( 'Muro paralelo a 0,6 m: pasos con contacto lateral', side, 0, 0 );
	check( 'Muro paralelo a 0,6 m: impactos', impacts, 0, 0 );
	within( 'Muro paralelo a 0,6 m: el camión sigue andando', t.v * 3.6, 20, 60, ' km/h' );
	const raysPerStep = along.rays / Math.round( 5 / DT );
	within( 'Muro paralelo: rayos de choque por paso (tres del parachoques y los costados)', raysPerStep, 10, 30 );

	// b) esquina: el edificio termina en z = -5. El tracto la pasa de largo y dobla a la
	// izquierda; el semirremolque corta la esquina y su costado va a dar contra ella.
	const cornerCase = collisions => {

		const terr = boxTerrain( [ { x0: - 12, x1: wallX, z0: - 5, z1: 20 } ] );
		const t = createTruck( A, { cargoMass: 15000 } );
		placeTruck( t, 0, 0, 0, terr );
		const out = { side: 0, closing: 0, stoppedAt: - 1, minLat: Infinity, blockedSteps: 0, impact: 0 };
		const each = ( time, ev ) => {

			if ( ev.side ) { out.side ++; out.closing = Math.max( out.closing, ev.side ); if ( out.stoppedAt < 0 ) out.stoppedAt = time; }
			if ( ev.impact ) out.impact = Math.max( out.impact, ev.impact );
			if ( t.blocked > 0 ) out.blockedSteps ++;
			// la esquina del edificio vista desde el remolque: distancia al costado izquierdo, negativa si entró
			const c = inTrailerFrame( t, wallX, - 5 );
			if ( c.lon > - 4.4 && c.lon < 9.2 ) out.minLat = Math.min( out.minLat, - c.lat - halfT );

		};

		// recta despacio hasta que el eje trasero del tracto pasa 1 m más allá de la esquina
		t.v = 2.5; t.gear = 2;
		run( t, { accel: 0.15, decel: 0, steer: 0 }, terr, 30, () => t.z > - 6, { collisions } );
		// giro a fondo a la izquierda, a paso de esquina (unos 12 km/h), hasta el primer
		// contacto lateral o hasta que la esquina queda atrás del remolque
		out.time = run( t, { accel: 0.08, decel: 0, steer: 1 }, terr, 20, ( time, ev ) => { each( time, ev ); if ( ev.side || inTrailerFrame( t, wallX, - 5 ).lon < - 4.4 ) return false; }, { collisions } );
		out.v = t.v; out.damage = t.damage;
		return { t, terr, out };

	};

	const ghost = cornerCase( false );
	within( 'Esquina sin choques: la esquina entra en el remolque (el caso es real)', ghost.out.minLat, - 10, - 0.3, ' m' );
	const c = cornerCase( true );
	check( 'Esquina: el costado del remolque se detiene (hubo contacto lateral)', c.out.side > 0 ? 1 : 0, 1, 0 );
	within( 'Esquina: momento del contacto', c.out.time, 0.5, 5, ' s' );
	within( 'Esquina: la esquina nunca entra al remolque', c.out.minLat, - 0.03, 0.5, ' m' );
	within( 'Esquina: el camión queda detenido', Math.abs( c.out.v ), 0, 0.01, ' m/s' );
	within( 'Esquina: velocidad de acercamiento (es un roce, no un choque)', c.out.closing * 3.6, 0.5, 4.5, ' km/h' );
	within( 'Esquina: un roce lento casi no daña', c.out.damage * 100, 0, 1, ' %' );
	// con el camión detenido contra la esquina, la reversa lo libera: el primer tramo
	// hacia atrás no toca nada (más adelante, con la articulación, la cola del remolque
	// puede barrer hacia el muro, como en la realidad)
	const odo0 = c.t.odo;
	let blockedBack = 0;
	run( c.t, { accel: 0, decel: 1, steer: 0 }, c.terr, 1.5, ( time, ev ) => { if ( ev.side ) blockedBack ++; } );
	within( 'Esquina: en reversa el camión se aleja', c.t.odo - odo0, 0.2, 5, ' m' );
	check( 'Esquina: alejarse no bloquea', blockedBack, 0, 0 );

	// c) camión rígido que se arrima a un muro en ángulo pequeño: se detiene sin daño
	const grazeCase = ( v0, steer ) => {

		const terr = boxTerrain( [ { x0: - 12, x1: wallX, z0: - 200, z1: 20 } ] );
		const t = createTruck( R, { cargoMass: 4000 } );
		placeTruck( t, 0, 0, 0, terr );
		t.v = v0; t.gear = 3;
		const w = R.tractor.width / 2;
		let minGap = Infinity, closing = 0;
		run( t, { accel: 0.3, decel: 0, steer }, terr, 25, ( time, ev ) => {

			if ( ev.side ) closing = Math.max( closing, ev.side );
			// esquina delantera izquierda del tracto
			const d = R.tractor.wheelbase + R.tractor.frontOverhang;
			const cx = t.x - Math.sin( t.yaw ) * d - Math.cos( t.yaw ) * w;
			minGap = Math.min( minGap, cx - wallX );

		} );
		return { t, minGap, closing };

	};

	const g = grazeCase( 3, 0.12 );
	within( 'Rígido arrimándose despacio: el frente no entra al muro', g.minGap, - 0.03, 0.6, ' m' );
	within( 'Rígido arrimándose despacio: se detiene', Math.abs( g.t.v ), 0, 0.01, ' m/s' );
	check( 'Rígido arrimándose despacio: sin daño', g.t.damage, 0, 0 );
	const g2 = grazeCase( 10, 1 );
	within( 'Rígido a fondo contra el muro: el frente no entra al muro', g2.minGap, - 0.03, 0.6, ' m' );
	within( 'Rígido a fondo contra el muro: el costado golpea y hay daño', g2.t.damage * 100, 1, 60, ' %' );
	within( 'Rígido a fondo contra el muro: velocidad de cierre', g2.closing * 3.6, 5, 40, ' km/h' );

}

// === 11. Robustez frente al paso de tiempo =================================
function scripted( dt ) {

	const t = createTruck( A, { cargoMass: 20000 } );
	placeTruck( t, 0, 0, 0, flat );
	const inp = { accel: 0, decel: 0, steer: 0 };
	const n = Math.round( 50 / dt );
	for ( let i = 0; i < n; i ++ ) {

		const time = i * dt;
		inp.accel = time < 20 ? 0.8 : ( time < 35 ? 0.3 : 0 );
		inp.decel = time > 42 ? 0.6 : 0;
		inp.steer = ( time > 10 && time < 16 ) ? 0.5 : ( ( time > 24 && time < 30 ) ? - 0.7 : 0 );
		stepTruck( t, inp, flat, dt );

	}

	return t;

}

{

	const a = scripted( 1 / 60 ), b = scripted( 1 / 120 ), c = scripted( 1 / 30 );
	const dist = Math.hypot( a.odo ), dAB = Math.hypot( a.x - b.x, a.z - b.z ), dAC = Math.hypot( a.x - c.x, a.z - c.z );
	info( 'Recorrido de la maniobra de prueba', dist, ' m' );
	within( 'Paso 1/60 frente a 1/120: diferencia de posición final', dAB / dist * 100, 0, 1.5, ' %' );
	within( 'Paso 1/60 frente a 1/30: diferencia de posición final', dAC / dist * 100, 0, 3.0, ' %' );

}

// === 12. Curva de par ======================================================
{

	const e = A.engine;
	check( 'Par a 1200 rpm', engineTorque( e, 1200 ), 2300, 1, ' N·m' );
	check( 'Potencia a 1700 rpm', engineTorque( e, 1700 ) * 1700 * Math.PI / 30 / 1000, 338, 1, ' kW' );
	check( 'Par en el corte', engineTorque( e, 2100 ), 0, 1e-9, ' N·m' );

}

// === 13. Giro en esquina: ancho barrido por el conjunto =====================
{

	// giro de 90° a la derecha a 10 km/h con el volante a fondo durante el giro
	const t = createTruck( A, { cargoMass: 20000 } );
	placeTruck( t, 0, 0, 0, flat );
	t.v = 10 / 3.6; t.gear = 3;
	const inp = { accel: 0.25, decel: 0, steer: 0 };
	let maxCut = 0, done = false;
	run( t, inp, flat, 40, () => {

		t.v = 10 / 3.6;
		const yawDeg = t.yaw * 180 / Math.PI;
		if ( ! done ) inp.steer = t.z < - 15 ? - 1 : 0;
		if ( yawDeg <= - 90 ) { done = true; inp.steer = 0; }
		// recorte interior: cuánto se mete el eje del remolque respecto de la huella del tracto
		const ax = trailerAxleXZ( t );
		if ( t.z < - 15 ) maxCut = Math.max( maxCut, ax.z - t.z );

	} );
	info( 'Esquina de 90° a fondo: radio del tracto', A.tractor.wheelbase / Math.tan( A.tractor.maxSteer ), ' m' );
	within( 'Esquina de 90°: el remolque termina alineado', Math.abs( articulation( t ) ) * 180 / Math.PI, 0, 6, '°' );

}

// === 14. Caja de cambios en pendiente =======================================
// En una subida larga la caja debe quedarse en la marcha que sostiene la carga.
// Antes subía por régimen, perdía velocidad en la marcha larga, reducía y volvía
// a subir: hasta 100 cambios en 150 s y la mitad de la velocidad posible.
{

	const B = VEHICLES.rigido;
	let runs = 0, hunting = 0, worstShifts = 0, worstCase = '';
	for ( const spec of [ A, B ] ) for ( const load of [ 0, 0.5, 1 ] ) for ( const grade of [ 0, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.15, 0.18 ] ) for ( const thr of [ 0.3, 0.5, 0.7, 0.86, 1 ] ) {

		const t = createTruck( spec, { cargoMass: spec.maxCargo * load } );
		const terr = slope( grade );
		placeTruck( t, 0, 0, 0, terr );
		const inp = { accel: thr, decel: 0, steer: 0 };
		let shifts = 0;
		run( t, inp, terr, 150, ( time, ev ) => { if ( time > 75 && ev.shift ) shifts ++; } );
		runs ++;
		if ( shifts >= 3 ) hunting ++;
		if ( shifts > worstShifts ) { worstShifts = shifts; worstCase = `${ spec.id } ${ ( totalMass( t ) / 1000 ).toFixed( 1 ) } t, ${ grade * 100 } %, pedal ${ thr }`; }

	}

	info( 'Barrido de pendientes: combinaciones de camión, carga, pendiente y pedal', runs );
	within( 'Barrido: combinaciones con la caja oscilando en régimen estable', hunting, 0, 0 );
	info( 'Barrido: máximo de cambios en los últimos 75 s', worstShifts, worstCase ? `  (${ worstCase })` : '' );

	// velocidad sostenida: rígido de 17 t en 10 %, a fondo. Con la tercera sostenida se llega cerca de 37 km/h.
	const t = createTruck( B, { cargoMass: B.maxCargo } );
	const terr = slope( 0.10 );
	placeTruck( t, 0, 0, 0, terr );
	let z60 = 0, shifts = 0;
	run( t, { accel: 1, decel: 0, steer: 0 }, terr, 150, ( time, ev ) => { if ( Math.abs( time - 60 ) < DT / 2 ) z60 = t.z; if ( time > 60 && ev.shift ) shifts ++; } );
	within( 'Rígido 17 t en subida de 10 %: velocidad media sostenida', ( z60 - t.z ) / 90 * 3.6, 35, 40, ' km/h' );
	within( 'Rígido 17 t en subida de 10 %: cambios tras el primer minuto', shifts, 0, 0 );

	// partida en pendiente con carga: primera marcha
	const h = createTruck( A, { cargoMass: 25000 } );
	const hill = slope( 0.10 );
	placeTruck( h, 0, 0, 0, hill );
	run( h, {}, hill, 2 );
	let moved = false;
	run( h, { accel: 1, decel: 0, steer: 0 }, hill, 12, () => { if ( h.v > 0.5 ) moved = true; } );
	within( 'Articulado 39 t parte en subida de 10 %: velocidad a los 12 s', h.v * 3.6, 8, 30, ' km/h' );

}

// === 15. Bajadas, limitador y sobrerrégimen ==================================
{

	// bajada de 8 % con 39 t: sin frenar, el retardador sostiene la velocidad limitada
	for ( const [ name, thr ] of [ [ 'a fondo', 1 ], [ 'con el pedal suelto', 0 ] ] ) {

		const t = createTruck( A, { cargoMass: 25000 } );
		const terr = slope( - 0.08 );
		placeTruck( t, 0, 0, 0, terr );
		t.v = 50 / 3.6; t.gear = 9;
		let vmax = 0, rpmMax = 0;
		run( t, { accel: thr, decel: 0, steer: 0 }, terr, 180, () => { vmax = Math.max( vmax, t.v ); rpmMax = Math.max( rpmMax, t.rpm ); } );
		within( `Bajada de 8 %, 39 t, ${ name }: velocidad máxima`, vmax * 3.6, 50, 96, ' km/h' );
		within( `Bajada de 8 %, 39 t, ${ name }: régimen máximo`, rpmMax, 600, A.engine.redline * 1.05, ' rpm' );

	}

	// reversa cuesta abajo: una sola marcha, la retención del motor limita la velocidad
	for ( const spec of [ A, VEHICLES.rigido ] ) {

		const t = createTruck( spec, { cargoMass: spec.maxCargo } );
		const terr = slope( 0.08 ); // sube hacia adelante: en reversa, el camión baja
		placeTruck( t, 0, 0, 0, terr );
		let vmin = 0, rpmMax = 0;
		run( t, { accel: 0, decel: 1, steer: 0 }, terr, 60, () => { vmin = Math.min( vmin, t.v ); rpmMax = Math.max( rpmMax, t.rpm ); } );
		const vRed = spec.engine.redline * Math.PI / 30 / ( spec.engine.reverse * spec.engine.final ) * spec.engine.wheelRadius;
		within( `Reversa cuesta abajo (${ spec.id }): velocidad máxima`, - vmin * 3.6, 3, vRed * 3.6 * 1.25, ' km/h' );
		within( `Reversa cuesta abajo (${ spec.id }): régimen máximo`, rpmMax, 600, spec.engine.redline * 1.25, ' rpm' );

	}

	// pasos largos: el filtro vertical no diverge
	let h = 0;
	const pop = { sampleGround: () => h, castObstacle: () => Infinity };
	const t = createTruck( A );
	placeTruck( t, 0, 0, 0, pop );
	h = 0.8;
	let maxY = 0;
	for ( let i = 0; i < 80; i ++ ) { stepTruck( t, {}, pop, 0.25 ); maxY = Math.max( maxY, Math.abs( t.y ) ); }
	within( 'Paso de 250 ms tras un salto de 0,8 m: altura máxima alcanzada', maxY, 0.75, 1.2, ' m' );
	check( 'Paso de 250 ms: altura final', t.y, 0.8, 0.01, ' m' );

}

// --- informe ----------------------------------------------------------------
const w = Math.max( ...rows.map( r => r[ 1 ].length ) );
for ( const r of rows ) console.log( `${ r[ 0 ] }  ${ r[ 1 ].padEnd( w ) }  ${ r[ 2 ].padStart( 12 ) }   ${ r[ 3 ] }` );
console.log( failures === 0 ? `\nTodo dentro de tolerancia (${ rows.filter( r => r[ 0 ] !== 'info' ).length } comprobaciones).` : `\n${ failures } comprobaciones fuera de tolerancia.` );
process.exit( failures ? 1 : 0 );
