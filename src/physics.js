// Ruta Sur · física del camión
// --------------------------------------------------------------------------
// Planta: modelo cinemático de bicicleta con semirremolque articulado (sin
// deslizamiento lateral, válido a velocidad urbana).
// Longitudinal: motor diésel con curva de par, caja automatizada, frenos,
// resistencia a la rodadura, arrastre aerodinámico y pendiente.
// Vertical: cada unidad sigue un plano de rodadura estimado con muchas
// muestras del suelo, y un filtro masa-resorte suaviza el resultado.
//
// El módulo no depende de Three.js. El mundo se consulta con dos funciones:
//   terrain.sampleGround(x, z, yRef)              -> altura del suelo o NaN
//       (opcional) deja en terrain.ny la componente vertical de la normal
//   terrain.castObstacle(ox,oy,oz, dx,dy,dz, max) -> distancia libre o Infinity
//       (opcional) deja en terrain.normal [nx, ny, nz] la normal de la superficie tocada
//
// Convención de ejes (la misma de Three.js): +Y arriba, rumbo `yaw` positivo
// en sentido antihorario visto desde arriba, y con yaw = 0 el camión mira a -Z.

export const G = 9.81;

const TWO_PI = Math.PI * 2;
const RPM_TO_RAD = TWO_PI / 60;

export const VEHICLES = {
	articulado: {
		id: 'articulado',
		label: 'Tracto con semirremolque',
		tractor: {
			wheelbase: 3.7,       // distancia entre ejes [m]
			frontOverhang: 1.4,   // del eje delantero al parachoques [m]
			rearOverhang: 0.95,   // del eje trasero al fin del chasis [m]
			width: 2.5,
			track: 2.05,          // trocha [m]
			hitch: 0.5,           // quinta rueda, delante del eje trasero [m]
			mass: 7500,           // [kg]
			maxSteer: 0.73,       // ángulo máximo de rueda [rad] (42°)
		},
		trailer: {
			length: 13.6,
			kingpinFromFront: 1.5, // del frente del remolque al perno rey [m]
			wheelbase: 7.7,        // del perno rey al centro del tridem [m]
			width: 2.55,
			track: 2.05,
			mass: 6500,
		},
		engine: {
			power: 338e3,          // 460 hp [W]
			torque: 2300,          // par máximo [N·m]
			idle: 600, powerEnd: 1900, redline: 2100,
			drag: 380,             // par de retención a 2000 rpm [N·m]
			gears: [ 14.94, 11.73, 9.04, 7.09, 5.54, 4.35, 3.44, 2.70, 2.08, 1.63, 1.27, 1.00 ],
			reverse: 15.5,
			final: 2.85,
			wheelRadius: 0.52,
			efficiency: 0.9,
			upLo: 1250, upHi: 1700, down: 900,
			driveAxleMax: 11500,   // carga máxima sobre el eje motriz [kg]
		},
		maxCargo: 25000,
	},
	rigido: {
		id: 'rigido',
		label: 'Camión rígido',
		tractor: {
			wheelbase: 5.2,
			frontOverhang: 1.4,
			rearOverhang: 2.7,
			width: 2.5,
			track: 2.05,
			hitch: 0,
			mass: 8500,
			maxSteer: 0.75,
		},
		trailer: null,
		engine: {
			power: 210e3,          // 285 hp [W]
			torque: 1150,
			idle: 650, powerEnd: 2200, redline: 2500,
			drag: 220,
			gears: [ 6.75, 3.91, 2.38, 1.52, 1.00, 0.78 ],
			reverse: 6.3,
			final: 4.3,
			wheelRadius: 0.49,
			efficiency: 0.9,
			upLo: 1500, upHi: 2100, down: 1050,
			driveAxleMax: 10000,
		},
		maxCargo: 8500,
	},
};

// Parámetros comunes
export const PARAMS = {
	aLatMax: 2.5,        // aceleración lateral admitida al girar [m/s²]
	steerRate: 0.6,      // velocidad de giro del volante en la rueda [rad/s]
	steerReturn: 0.95,   // velocidad de retorno al centro [rad/s]
	brakeDecel: 5.5,     // frenada máxima [m/s²]
	crr: 0.007,          // rodadura
	cdA: 6.0,            // arrastre aerodinámico Cd·A [m²]
	rho: 1.2,
	mu: 0.7,             // adherencia en el eje motriz
	speedLimit: 90 / 3.6,
	gammaMax: 1.48,      // ángulo máximo de articulación [rad] (85°)
	susOmega: 9.0,       // frecuencia natural del filtro vertical [rad/s]
	susZeta: 0.7,        // amortiguamiento
	// seguimiento del suelo
	rowStep: 1.4,        // separación entre filas de muestras [m]
	rowCount: 11,        // filas de la ventana (14 m hacia el sentido de marcha)
	rowGate: 0.25,       // tolerancia de una fila respecto de la recta de calzada [m]
	gate: 0.35,          // cuánto puede sobresalir una muestra de la calzada [m]
	gateNear: 0.15,      // lo mismo, cuando hay un bulto dentro de la huella [m]
	dropGate: 1.5,       // escalón hacia abajo que el camión sigue sin dudar [m]
	overhead: 2.5,       // sobre esta altura, una muestra es una estructura que pasa por encima [m]
	maxGrade: 0.45,      // pendiente máxima de una calzada
	minNy: 0.766,        // componente vertical mínima de la normal de una calzada (40°)
	// choques
	probeHeight: 1.0,    // altura de las sondas de choque [m]
	probeMargin: 0.35,   // distancia a la que el parachoques se detiene [m]
	sideMargin: 0.25,    // distancia a la que un costado se detiene [m]
	sideSpacing: 4.5,    // separación máxima entre los puntos vigilados de un costado [m]
	sideInset: 0.25,     // los puntos extremos de un costado quedan a esta distancia de la esquina [m]
	shiftTime: 0.45,     // corte de par en un cambio [s]
	shiftReserve: 0.04,  // aceleración mínima que debe quedar disponible en la marcha siguiente [m/s²]
	retarder: 2.5,       // frenada máxima del retardador sobre la velocidad limitada [m/s²]
	overRev: 8.0,        // retención del motor por cada 100 % de exceso sobre el régimen de corte [m/s²]
};

const clamp = ( v, a, b ) => v < a ? a : ( v > b ? b : v );
const wrapPi = a => {

	a = ( a + Math.PI ) % TWO_PI;
	if ( a < 0 ) a += TWO_PI;
	return a - Math.PI;

};

export function totalMass( t ) {

	const s = t.spec;
	return s.tractor.mass + ( s.trailer ? s.trailer.mass : 0 ) + t.cargoMass;

}

const TORQUE_KNEE = 1000; // régimen desde el que el motor entrega su par máximo [rpm]

// Par del motor a plena carga [N·m]
export function engineTorque( e, rpm ) {

	const rpmP = ( e.power / e.torque ) / RPM_TO_RAD; // donde empieza la potencia constante
	if ( rpm <= e.idle ) return e.torque * 0.55;
	if ( rpm < TORQUE_KNEE ) return e.torque * ( 0.55 + 0.45 * ( rpm - e.idle ) / ( TORQUE_KNEE - e.idle ) );
	if ( rpm <= rpmP ) return e.torque;
	if ( rpm <= e.powerEnd ) return e.power / ( rpm * RPM_TO_RAD );
	if ( rpm < e.redline ) {

		const tEnd = e.power / ( e.powerEnd * RPM_TO_RAD );
		return tEnd * ( 1 - 0.7 * ( rpm - e.powerEnd ) / ( e.redline - e.powerEnd ) );

	}

	return 0;

}

function newPlane() {

	return {
		set: false,
		// plano local de la unidad: h = a + b·u + c·w (u a la derecha, w hacia adelante)
		a: 0, b: 0, c: 0,
		// el mismo plano anclado al mundo: h = a + gx·(x - x0) + gz·(z - z0)
		gx: 0, gz: 0, x0: 0, z0: 0,
		// recta de calzada anclada al mundo, para predecir la altura de cada muestra
		la: 0, lgx: 0, lgz: 0,
		rejected: 0, fresh: false, samples: 0, rows: 0,
	};

}

export function createTruck( spec, opts = {} ) {

	const { x = 0, y = 0, z = 0, yaw = 0, cargoMass = 0 } = opts;
	return {
		spec,
		// planta
		x, z, yaw, v: 0, steer: 0,
		trailerYaw: yaw,
		// vertical (alturas filtradas del suelo bajo cada eje y sus velocidades)
		hF: y, hR: y, hT: y, vF: 0, vR: 0, vT: 0,
		roll: 0, rollV: 0, trailerRoll: 0, trailerRollV: 0,
		y, pitch: 0, trailerY: y, trailerPitch: 0,
		gradeAcc: 0,        // aceleración por pendiente, filtrada [m/s²]
		grounded: false, airTime: 0,
		gTr: newPlane(), gTl: newPlane(),
		// tren motriz
		dir: 1, gear: 1, rpm: spec.engine.idle, throttle: 0, brake: 0,
		shiftT: 0, sinceShift: 10, nextGear: 0, dirHold: 0,
		// estado de juego
		cargoMass, damage: 0, odo: 0,
		aLong: 0, aLat: 0, yawRate: 0,
		jackknife: false, blocked: 0, blockedDir: 0, hold: true,
	};

}

// Vectores de la planta para un rumbo dado
function fwdX( yaw ) { return - Math.sin( yaw ); }
function fwdZ( yaw ) { return - Math.cos( yaw ); }
function rightX( yaw ) { return Math.cos( yaw ); }
function rightZ( yaw ) { return - Math.sin( yaw ); }

// Posición en planta de la quinta rueda y del eje del remolque
export function hitchXZ( t, out = {} ) {

	const e = t.spec.tractor.hitch;
	out.x = t.x + fwdX( t.yaw ) * e;
	out.z = t.z + fwdZ( t.yaw ) * e;
	return out;

}

export function trailerAxleXZ( t, out = {} ) {

	const tl = t.spec.trailer;
	hitchXZ( t, out );
	out.x -= fwdX( t.trailerYaw ) * tl.wheelbase;
	out.z -= fwdZ( t.trailerYaw ) * tl.wheelbase;
	return out;

}

// ---------------------------------------------------------------------------
// Seguimiento del suelo
// ---------------------------------------------------------------------------
//
// Una malla fotogramétrica a nivel de calle trae la calzada con ruido y, sobre
// ella, bultos: autos "derretidos", vegetación, el tablero de un puente. La
// calzada se distingue de un bulto por contexto, así que cada unidad mira una
// ventana de 14 m en el sentido de marcha, con tres muestras por fila.
//
// 1. Recta de calzada. Cada fila aporta su muestra más baja (la calzada queda
//    debajo de los bultos). Entre todas las rectas que pasan por dos filas se
//    elige la que explica más filas. Una recta cuyas filas quedan "en isla",
//    con suelo más bajo por delante y por detrás, describe la tapa de un bulto
//    y se descarta.
// 2. Plano local. Con las muestras bajo la unidad que no sobresalen de la
//    recta se ajusta un plano por mínimos cuadrados, del que salen la altura
//    de cada eje, el cabeceo y el alabeo. Si un bulto tapa toda la huella, la
//    unidad sigue la recta de calzada y lo atraviesa.
//
// El método no guarda memoria del suelo, así que un cambio de nivel de detalle
// de la malla se sigue en el mismo paso, sin lógica de recuperación.

const MAXR = 12, MAXS = 36;
const _su = new Float64Array( MAXS ), _sw = new Float64Array( MAXS ), _sh = new Float64Array( MAXS );
const _keep = new Uint8Array( MAXS );
const _low = new Float64Array( MAXR ), _wRow = new Float64Array( MAXR );
const _sorted = [];
const COLS = [ - 0.95, 0, 0.95 ];
const _fit = { a: 0, b: 0, c: 0, ok: false };
const _h = {}, _a = {};

function median( arr, n ) {

	_sorted.length = 0;
	for ( let i = 0; i < n; i ++ ) if ( arr[ i ] === arr[ i ] ) _sorted.push( arr[ i ] );
	if ( _sorted.length === 0 ) return NaN;
	_sorted.sort( ( a, b ) => a - b );
	const m = _sorted.length >> 1;
	return _sorted.length % 2 ? _sorted[ m ] : 0.5 * ( _sorted[ m - 1 ] + _sorted[ m ] );

}

// Mínimos cuadrados de h = a + b·u + c·w sobre las muestras marcadas. Si la
// geometría no permite resolver una pendiente, se usa la que se entrega.
function fitPlane( n, bPrev, cPrev, out ) {

	let k = 0, Su = 0, Sw = 0, Suu = 0, Sww = 0, Suw = 0, Sh = 0, Suh = 0, Swh = 0;
	for ( let i = 0; i < n; i ++ ) {

		if ( ! _keep[ i ] ) continue;
		const u = _su[ i ], w = _sw[ i ], h = _sh[ i ];
		k ++; Su += u; Sw += w; Suu += u * u; Sww += w * w; Suw += u * w; Sh += h; Suh += u * h; Swh += w * h;

	}

	out.ok = k >= 3;
	if ( ! out.ok ) return out;

	const varU = Suu - Su * Su / k, varW = Sww - Sw * Sw / k;
	const cov = Suw - Su * Sw / k;
	const cuh = Suh - Su * Sh / k, cwh = Swh - Sw * Sh / k;
	const det = varU * varW - cov * cov;
	let b, c;
	if ( varU > 0.3 && varW > 0.5 && det > 0.1 ) {

		b = ( cuh * varW - cwh * cov ) / det;
		c = ( cwh * varU - cuh * cov ) / det;

	} else if ( varW > 0.5 ) {

		b = bPrev;
		c = ( cwh - b * cov ) / varW;

	} else if ( varU > 0.3 ) {

		c = cPrev;
		b = ( cuh - c * cov ) / varU;

	} else { b = bPrev; c = cPrev; }

	out.a = ( Sh - b * Su - c * Sw ) / k;
	out.b = b; out.c = c;
	return out;

}

// Estima el plano de rodadura de una unidad. (cx, cz) es su punto de
// referencia, [f0, f1] el tramo que ocupa su huella y `sign` el sentido de
// marcha. Devuelve false cuando no hay malla suficiente bajo la ventana.
function trackUnit( terrain, P, cx, cz, yaw, f0, f1, yRef, sign ) {

	const fx = fwdX( yaw ), fz = fwdZ( yaw ), rx = rightX( yaw ), rz = rightZ( yaw );
	const rows = PARAMS.rowCount, step = PARAMS.rowStep;
	const wStart = sign >= 0 ? f0 - 1.3 : f1 + 1.3, wStep = sign >= 0 ? step : - step;
	const has = P.set;

	// --- muestreo
	let n = 0, validRows = 0;
	for ( let r = 0; r < rows; r ++ ) {

		const w = wStart + wStep * r;
		_wRow[ r ] = w;
		let low = Infinity;
		for ( let cI = 0; cI < 3; cI ++ ) {

			const u = COLS[ cI ];
			const x = cx + fx * w + rx * u, z = cz + fz * w + rz * u;
			const ref = has ? P.la + P.lgx * ( x - P.x0 ) + P.lgz * ( z - P.z0 ) : yRef;
			const h = terrain.sampleGround( x, z, ref );
			if ( h !== h ) continue;
			if ( has && h - ref > PARAMS.overhead ) continue;
			// una cara más empinada que 40° no es calzada: es el costado de un bulto o un muro
			if ( terrain.ny !== undefined && terrain.ny < PARAMS.minNy ) continue;
			_su[ n ] = u; _sw[ n ] = w; _sh[ n ] = h;
			n ++;
			if ( h < low ) low = h;

		}

		if ( low < Infinity ) { _low[ r ] = low; validRows ++; } else _low[ r ] = NaN;

	}

	P.samples = n; P.rows = validRows;
	if ( validRows < 3 ) return false;

	// --- recta de calzada
	const g = PARAMS.rowGate;
	const wMid = 0.5 * ( f0 + f1 );
	const prevMid = has ? P.la + ( P.lgx * fx + P.lgz * fz ) * wMid + P.lgx * ( cx - P.x0 ) + P.lgz * ( cz - P.z0 ) : NaN;
	let bestScore = - Infinity, la = 0, lc = 0, found = false;
	for ( let i = 0; i < rows; i ++ ) {

		if ( _low[ i ] !== _low[ i ] ) continue;
		for ( let j = i + 2; j < rows; j ++ ) {

			if ( _low[ j ] !== _low[ j ] ) continue;
			const c = ( _low[ j ] - _low[ i ] ) / ( _wRow[ j ] - _wRow[ i ] );
			if ( Math.abs( c ) > PARAMS.maxGrade ) continue;
			const a = _low[ i ] - c * _wRow[ i ];
			let inl = 0, misfit = 0, firstIn = - 1, lastIn = - 1, firstBelow = - 1, lastBelow = - 1;
			for ( let r = 0; r < rows; r ++ ) {

				if ( _low[ r ] !== _low[ r ] ) continue;
				const d = _low[ r ] - ( a + c * _wRow[ r ] );
				if ( d >= - g && d <= g ) { inl ++; misfit += Math.abs( d ); if ( firstIn < 0 ) firstIn = r; lastIn = r; }
				else if ( d < - g ) { if ( firstBelow < 0 ) firstBelow = r; lastBelow = r; }

			}

			// La calzada es la envolvente inferior. Una recta con suelo más bajo
			// antes y después de sus filas describe la tapa de un bulto (isla), y
			// una con suelo más bajo entre sus filas hace de puente entre la
			// calzada y un bulto.
			const island = firstBelow >= 0 && firstBelow < firstIn && lastBelow > lastIn;
			let bridged = 0;
			if ( firstBelow >= 0 ) for ( let r = firstIn + 1; r < lastIn; r ++ ) {

				if ( _low[ r ] === _low[ r ] && _low[ r ] - ( a + c * _wRow[ r ] ) < - g ) bridged ++;

			}

			// filas explicadas, menos el desajuste y las señales de bulto
			let score = inl - misfit - 2 * bridged - ( island ? 100 : 0 );
			const mid = a + c * wMid;
			if ( has && Math.abs( mid - prevMid ) < 0.15 ) score += 0.6; // continuidad
			score -= 0.001 * mid;                                        // a igualdad, la más baja
			if ( score > bestScore ) { bestScore = score; la = a; lc = c; found = true; }

		}

	}

	if ( ! found ) { la = median( _low, rows ); lc = 0; }

	// refinamiento por mínimos cuadrados con las filas que la recta explica
	{

		let k = 0, Sw = 0, Sh = 0, Sww = 0, Swh = 0;
		for ( let r = 0; r < rows; r ++ ) {

			if ( _low[ r ] !== _low[ r ] ) continue;
			const d = _low[ r ] - ( la + lc * _wRow[ r ] );
			if ( d < - g || d > g ) continue;
			const w = _wRow[ r ], h = _low[ r ];
			k ++; Sw += w; Sh += h; Sww += w * w; Swh += w * h;

		}

		const varW = Sww - Sw * Sw / k;
		if ( k >= 3 && varW > 2 ) {

			lc = clamp( ( Swh - Sw * Sh / k ) / varW, - PARAMS.maxGrade, PARAMS.maxGrade );
			la = ( Sh - lc * Sw ) / k;

		}

	}

	// --- plano local
	const bPrev = has ? P.gx * rx + P.gz * rz : 0;
	let k = 0, above = 0, gate = PARAMS.gate;
	for ( let pass = 0; pass < 2; pass ++ ) {

		k = 0; above = 0;
		for ( let i = 0; i < n; i ++ ) {

			const w = _sw[ i ];
			_keep[ i ] = 0;
			if ( w < f0 - 1e-6 || w > f1 + 1e-6 ) continue;
			const d = _sh[ i ] - ( la + lc * w );
			if ( d > gate ) above ++;
			else if ( d >= - PARAMS.dropGate ) { _keep[ i ] = 1; k ++; }

		}

		// con un bulto dentro de la huella, sus faldas también se descartan
		if ( pass === 0 && above > 0 ) gate = PARAMS.gateNear; else break;

	}

	if ( k >= 5 ) fitPlane( n, bPrev, lc, _fit );
	else _fit.ok = false;
	if ( _fit.ok ) {

		// el plano local no se aparta mucho de la pendiente de la calzada, y
		// menos cuando parte de la huella está tapada por un bulto
		const dev = above > 0 ? 0.06 : 0.3;
		const c = clamp( _fit.c, lc - dev, lc + dev );
		if ( c !== _fit.c ) {

			let acc = 0;
			for ( let i = 0; i < n; i ++ ) if ( _keep[ i ] ) acc += _sh[ i ] - _fit.b * _su[ i ] - c * _sw[ i ];
			_fit.a = acc / k; _fit.c = c;

		}

	} else { _fit.a = la; _fit.b = bPrev * 0.9; _fit.c = lc; }

	P.fresh = above > 0 && P.rejected === 0;
	P.rejected = above;
	P.set = true;
	P.a = _fit.a; P.b = _fit.b; P.c = _fit.c;
	P.gx = _fit.b * rx + _fit.c * fx; P.gz = _fit.b * rz + _fit.c * fz;
	P.x0 = cx; P.z0 = cz;
	P.la = la; P.lgx = lc * fx; P.lgz = lc * fz;
	return true;

}

// Lee el suelo bajo las dos unidades. Actualiza los planos t.gTr y t.gTl.
function trackGround( t, terrain ) {

	const tr = t.spec.tractor, tl = t.spec.trailer;
	const a = trackUnit( terrain, t.gTr, t.x, t.z, t.yaw, - 0.7, tr.wheelbase + 0.6, t.hR, t.dir );
	let b = true;
	if ( tl ) {

		trailerAxleXZ( t, _a );
		b = trackUnit( terrain, t.gTl, _a.x, _a.z, t.trailerYaw, - 2.0, 2.0, t.hT, t.dir );

	}

	_h.tractor = a; _h.trailer = b;
	return _h;

}

// Coloca el camión sobre el suelo sin transitorio (aparición, reinicio, teletransporte)
export function placeTruck( t, x, z, yaw, terrain, yHint = t.y ) {

	const tr = t.spec.tractor;
	t.x = x; t.z = z; t.yaw = yaw; t.trailerYaw = yaw;
	t.v = 0; t.steer = 0; t.yawRate = 0; t.aLong = 0; t.aLat = 0;
	t.hF = t.hR = t.hT = yHint;
	t.vF = t.vR = t.vT = 0; t.roll = 0; t.trailerRoll = 0; t.rollV = 0; t.trailerRollV = 0;
	t.dir = 1; t.gear = startGear( t ); t.rpm = t.spec.engine.idle; t.shiftT = 0; t.sinceShift = 10;
	t.throttle = 0; t.brake = 0; t.hold = true; t.jackknife = false; t.blocked = 0; t.gradeAcc = 0;
	t.airTime = 0;
	t.gTr = newPlane(); t.gTl = newPlane();
	const r = trackGround( t, terrain );
	const ok = r.tractor;
	if ( ok ) {

		t.hR = t.gTr.a; t.hF = t.gTr.a + t.gTr.c * tr.wheelbase; t.roll = Math.atan( t.gTr.b );
		if ( t.spec.trailer ) {

			if ( r.trailer ) { t.hT = t.gTl.a; t.trailerRoll = Math.atan( t.gTl.b ); } else t.hT = t.hR;

		}

	}

	t.grounded = ok;
	updatePose( t );
	return ok;

}

/**
 * Vuelve a apoyar el camión a la altura indicada, sin tocar su movimiento en planta.
 * Las muestras de suelo buscan desde 2 m sobre la altura recordada hasta 7 m por
 * debajo; si el suelo reaparece fuera de ese alcance (tras un tramo sin malla, o
 * cuando un nivel de detalle nuevo cambia mucho la altura), el camión no lo encuentra
 * por sí solo. Devuelve true si quedó apoyado.
 */
export function reseatTruck( t, terrain, yHint ) {

	const tr = t.spec.tractor;
	t.hF = t.hR = t.hT = yHint;
	t.vF = t.vR = t.vT = 0; t.roll = 0; t.trailerRoll = 0; t.rollV = 0; t.trailerRollV = 0;
	t.gTr = newPlane(); t.gTl = newPlane();
	const r = trackGround( t, terrain );
	if ( r.tractor ) {

		t.hR = t.gTr.a; t.hF = t.gTr.a + t.gTr.c * tr.wheelbase; t.roll = Math.atan( t.gTr.b );
		if ( t.spec.trailer ) {

			if ( r.trailer ) { t.hT = t.gTl.a; t.trailerRoll = Math.atan( t.gTl.b ); } else t.hT = t.hR;

		}

		t.grounded = true; t.airTime = 0;

	}

	updatePose( t );
	return r.tractor;

}

function updatePose( t ) {

	const tr = t.spec.tractor, tl = t.spec.trailer;
	t.y = t.hR;
	t.pitch = Math.atan2( t.hF - t.hR, tr.wheelbase );
	if ( tl ) {

		const hitchY = t.hR + tr.hitch * Math.tan( t.pitch );
		t.trailerY = t.hT;
		t.trailerPitch = Math.atan2( hitchY - t.hT, tl.wheelbase );

	}

}

// Marcha de partida: más corta con carga y cuesta arriba (más de 4 %)
function startGear( t ) {

	const n = t.spec.engine.gears.length;
	if ( n <= 6 ) return 1;
	const heavy = totalMass( t ) > 26000, uphill = t.gradeAcc < - 0.4;
	if ( uphill ) return heavy ? 1 : 2;
	return heavy ? 2 : 4;

}

// ¿Sostiene la marcha `gear` la carga actual a la velocidad v, con el pedal como está?
// Compara la fuerza de tracción disponible con la pendiente, la rodadura y el aire.
// `reserve` es la aceleración que debe quedar disponible y `minRpm` el régimen mínimo aceptable.
function sustains( t, e, gear, v, m, reserve = PARAMS.shiftReserve, minRpm = 0 ) {

	const ratio = e.gears[ gear - 1 ] * e.final;
	const rpmW = v / e.wheelRadius * ratio / RPM_TO_RAD;
	if ( rpmW < minRpm ) return false;
	const rpm = Math.max( e.idle, rpmW );
	const driveLoad = Math.min( e.driveAxleMax, 0.3 * m + 2000 );
	const force = Math.min( t.throttle * engineTorque( e, rpm ) * ratio * e.efficiency / e.wheelRadius, PARAMS.mu * driveLoad * G );
	const acc = force / m + t.gradeAcc - PARAMS.crr * G - 0.5 * PARAMS.rho * PARAMS.cdA * v * v / m;
	return acc >= reserve;

}

// Filtro masa-resorte. `targetVel` es la velocidad con que se mueve el objetivo:
// con ella el filtro sigue una pendiente constante sin quedarse atrás.
function spring( value, vel, target, dt, targetVel = 0 ) {

	const omega = PARAMS.susOmega, zeta = PARAMS.susZeta;
	// con pasos largos el integrador explícito diverge: se divide en subpasos de 40 ms como máximo
	const n = dt > 0.04 ? Math.ceil( dt / 0.04 ) : 1, h = dt / n;
	for ( let i = 0; i < n; i ++ ) {

		const acc = omega * omega * ( target - value ) - 2 * zeta * omega * ( vel - targetVel );
		vel += acc * h;
		value += vel * h;

	}

	_h.value = value; _h.vel = vel;
	return _h;

}

// ---------------------------------------------------------------------------
// Choques
// ---------------------------------------------------------------------------
//
// Dos familias de sondas. Las del parachoques (y de la cola) miran en el
// sentido de marcha y recortan el avance a la distancia libre. Las de los
// costados cuidan los flancos de cada unidad: en una curva el semirremolque
// corta la esquina y su costado alcanza lo que el tracto esquivó.
//
// Los costados se vigilan sobre la postura que el paso quiere alcanzar:
// 1. Puntos barridos. Cada punto del flanco lanza un rayo desde donde está
//    hacia donde iría. Si algo se cruza, el avance se recorta como en el
//    parachoques. Un movimiento que se aleja del obstáculo nunca se bloquea.
// 2. Aristas. Un rayo recorre cada flanco de punta a punta: si toca algo, una
//    esquina ajena entró entre dos puntos y el paso se rechaza entero, salvo
//    que ya estuviera así antes del paso (para poder salir).
//
// La velocidad de acercamiento es la componente del movimiento del punto según
// la normal de la superficie: un roce tangencial no daña, un costalazo sí.

// Distancia libre hacia adelante (o hacia atrás) medida desde el parachoques
function probeTravel( t, terrain, sign, reach ) {

	const tr = t.spec.tractor, tl = t.spec.trailer;
	let yaw, bx, bz, by, pitch, halfW, dirSign;

	if ( sign > 0 ) {

		// parachoques delantero del tracto
		yaw = t.yaw; pitch = t.pitch;
		const d = tr.wheelbase + tr.frontOverhang;
		bx = t.x + fwdX( yaw ) * d; bz = t.z + fwdZ( yaw ) * d;
		by = t.hR + Math.tan( pitch ) * d;
		halfW = tr.width / 2 - 0.15;
		dirSign = 1;

	} else if ( tl ) {

		// cola del semirremolque
		yaw = t.trailerYaw; pitch = t.trailerPitch;
		trailerAxleXZ( t, _a );
		const d = tl.length - tl.kingpinFromFront - tl.wheelbase;
		bx = _a.x - fwdX( yaw ) * d; bz = _a.z - fwdZ( yaw ) * d;
		by = t.hT - Math.tan( pitch ) * d;
		halfW = tl.width / 2 - 0.15;
		dirSign = - 1;

	} else {

		// cola del camión rígido
		yaw = t.yaw; pitch = t.pitch;
		const d = tr.rearOverhang;
		bx = t.x - fwdX( yaw ) * d; bz = t.z - fwdZ( yaw ) * d;
		by = t.hR - Math.tan( pitch ) * d;
		halfW = tr.width / 2 - 0.15;
		dirSign = - 1;

	}

	const cp = Math.cos( pitch ), sp = Math.sin( pitch );
	const dx = fwdX( yaw ) * cp * dirSign, dz = fwdZ( yaw ) * cp * dirSign, dy = sp * dirSign;
	const rx = rightX( yaw ), rz = rightZ( yaw );
	const oy = by + PARAMS.probeHeight;

	let best = Infinity;
	for ( let i = - 1; i <= 1; i ++ ) {

		const d = terrain.castObstacle( bx + rx * halfW * i, oy, bz + rz * halfW * i, dx, dy, dz, reach );
		if ( d < best ) best = d;

	}

	return best;

}

// Postura siguiente en planta a partir del avance `travel`, sin tocar el camión
const _plan = { x: 0, z: 0, yaw: 0, trailerYaw: 0, yawRate: 0, jack: false };
function planMotion( t, travel, dt, out ) {

	const tr = t.spec.tractor, tl = t.spec.trailer;
	const yawRate = dt > 0 ? ( travel / dt ) / tr.wheelbase * Math.tan( t.steer ) : 0;
	const yawMid = t.yaw + yawRate * dt * 0.5;
	out.x = t.x + fwdX( yawMid ) * travel;
	out.z = t.z + fwdZ( yawMid ) * travel;
	out.yaw = wrapPi( t.yaw + yawRate * dt );
	out.yawRate = yawRate;
	out.trailerYaw = t.trailerYaw;
	out.jack = false;
	if ( tl ) {

		const vEff = dt > 0 ? travel / dt : 0;
		const gamma = wrapPi( t.yaw - t.trailerYaw );
		const thetaDot = ( vEff * Math.sin( gamma ) + tr.hitch * yawRate * Math.cos( gamma ) ) / tl.wheelbase;
		out.trailerYaw = wrapPi( t.trailerYaw + thetaDot * dt );
		// límite de articulación; en reversa el ángulo crece solo y el camión queda en tijera
		const g2 = wrapPi( out.yaw - out.trailerYaw );
		if ( Math.abs( g2 ) > PARAMS.gammaMax ) {

			out.trailerYaw = wrapPi( out.yaw - Math.sign( g2 ) * PARAMS.gammaMax );
			if ( vEff < 0 ) out.jack = true;

		}

	}

	return out;

}

// Planta de una unidad para una postura dada: centro del eje de referencia, rumbo, altura y cabeceo
const _u0 = {}, _u1 = {};
function unitPose( t, trailer, x, z, yaw, trailerYaw, out ) {

	if ( trailer ) {

		const tr = t.spec.tractor, tl = t.spec.trailer;
		out.x = x + fwdX( yaw ) * tr.hitch - fwdX( trailerYaw ) * tl.wheelbase;
		out.z = z + fwdZ( yaw ) * tr.hitch - fwdZ( trailerYaw ) * tl.wheelbase;
		out.yaw = trailerYaw; out.h = t.hT; out.pitch = t.trailerPitch;

	} else {

		out.x = x; out.z = z; out.yaw = yaw; out.h = t.hR; out.pitch = t.pitch;

	}

	return out;

}

// Velocidad con que el punto que se movió (dx, dy, dz) en dt se acerca a la
// superficie recién tocada. Sin normal, se toma el movimiento completo.
function closingSpeed( terrain, dx, dy, dz, dt ) {

	if ( dt <= 0 ) return 0;
	const n = terrain.normal;
	if ( ! n ) return Math.sqrt( dx * dx + dy * dy + dz * dz ) / dt;
	return Math.abs( dx * n[ 0 ] + dy * n[ 1 ] + dz * n[ 2 ] ) / dt;

}

// Un punto del flanco `side` (-1 izquierda, 1 derecha) a `s` metros por delante del eje
function sideX( u, s, side, halfW ) { return u.x + fwdX( u.yaw ) * s + rightX( u.yaw ) * halfW * side; }
function sideZ( u, s, side, halfW ) { return u.z + fwdZ( u.yaw ) * s + rightZ( u.yaw ) * halfW * side; }

// Rayo a lo largo de una arista del flanco, de la cola a la punta. Devuelve la
// distancia al primer obstáculo desde la cola, o Infinity si la arista está libre.
function edgeHit( terrain, u, sR, sF, side, halfW ) {

	const x0 = sideX( u, sR, side, halfW ), z0 = sideZ( u, sR, side, halfW );
	const x1 = sideX( u, sF, side, halfW ), z1 = sideZ( u, sF, side, halfW );
	const tp = Math.tan( u.pitch );
	const y0 = u.h + tp * sR + PARAMS.probeHeight, y1 = u.h + tp * sF + PARAMS.probeHeight;
	const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.sqrt( dx * dx + dy * dy + dz * dz );
	if ( len < 1e-6 ) return Infinity;
	// la arista se acorta un poco en cada punta: las esquinas ya las cuidan los puntos barridos y el parachoques
	const trim = PARAMS.sideInset;
	const d = terrain.castObstacle( x0 + dx / len * trim, y0 + dy / len * trim, z0 + dz / len * trim, dx / len, dy / len, dz / len, len - 2 * trim );
	return d < len - 2 * trim ? d + trim : Infinity;

}

/**
 * Vigila los costados de cada unidad entre la postura actual y la planeada.
 * Devuelve la fracción del avance que cabe (1 si los flancos van libres) y
 * anota en `ev.side` la velocidad de acercamiento mayor que encontró.
 */
function sideSweep( t, plan, terrain, dt, ev ) {

	const tr = t.spec.tractor, tl = t.spec.trailer;
	let k = 1;
	for ( let unit = 0; unit < ( tl ? 2 : 1 ); unit ++ ) {

		const trailer = unit === 1;
		const sF = trailer ? tl.wheelbase + tl.kingpinFromFront : tr.wheelbase + tr.frontOverhang;
		const sR = trailer ? - ( tl.length - tl.kingpinFromFront - tl.wheelbase ) : - tr.rearOverhang;
		const halfW = ( trailer ? tl.width : tr.width ) / 2;
		unitPose( t, trailer, t.x, t.z, t.yaw, t.trailerYaw, _u0 );
		unitPose( t, trailer, plan.x, plan.z, plan.yaw, plan.trailerYaw, _u1 );
		const span = sF - sR - 2 * PARAMS.sideInset;
		const n = Math.max( 2, Math.ceil( span / PARAMS.sideSpacing ) + 1 );
		const tp = Math.tan( _u0.pitch );
		for ( let side = - 1; side <= 1; side += 2 ) {

			// 1. puntos barridos
			for ( let i = 0; i < n; i ++ ) {

				const s = sF - PARAMS.sideInset - span * i / ( n - 1 );
				const x0 = sideX( _u0, s, side, halfW ), z0 = sideZ( _u0, s, side, halfW );
				const dx = sideX( _u1, s, side, halfW ) - x0, dz = sideZ( _u1, s, side, halfW ) - z0;
				const d = Math.sqrt( dx * dx + dz * dz );
				if ( d < 1e-6 ) continue;
				const reach = d + PARAMS.sideMargin;
				const free = terrain.castObstacle( x0, _u0.h + tp * s + PARAMS.probeHeight, z0, dx / d, 0, dz / d, reach );
				if ( free < reach ) {

					k = Math.min( k, Math.max( 0, free - PARAMS.sideMargin ) / d );
					ev.side = Math.max( ev.side, closingSpeed( terrain, dx, 0, dz, dt ) );

				}

			}

			// 2. arista: algo entró entre dos puntos, y antes del paso no estaba
			const hit = edgeHit( terrain, _u1, sR, sF, side, halfW );
			if ( hit !== Infinity ) {

				const s = sR + hit;
				const dx = sideX( _u1, s, side, halfW ) - sideX( _u0, s, side, halfW ), dz = sideZ( _u1, s, side, halfW ) - sideZ( _u0, s, side, halfW );
				const closing = closingSpeed( terrain, dx, 0, dz, dt );
				if ( edgeHit( terrain, _u0, sR, sF, side, halfW ) === Infinity ) {

					k = 0;
					ev.side = Math.max( ev.side, closing );

				}

			}

		}

	}

	return k;

}

// ---------------------------------------------------------------------------
// Paso de simulación
// ---------------------------------------------------------------------------

const EVENTS = { shift: 0, impact: 0, side: 0, jackknife: false, bump: 0 };

/**
 * Avanza la simulación un paso.
 * input: { accel: 0..1, decel: 0..1, steer: -1..1 (positivo a la izquierda), analog: bool, handbrake: bool }
 * opts:  { collisions: bool }
 * Devuelve un objeto reutilizado con los eventos del paso:
 *   shift: marcha entrante, impact: velocidad de impacto [m/s] (0 si no hubo),
 *   side: velocidad de acercamiento de un costado que tocó algo [m/s] (0 si no hubo),
 *   jackknife: el camión acaba de quedar en tijera, bump: una rueda pisó un bulto.
 */
export function stepTruck( t, input, terrain, dt, opts = {} ) {

	const s = t.spec, tr = s.tractor, tl = s.trailer, e = s.engine;
	const collide = opts.collisions !== false;
	const ev = EVENTS;
	ev.shift = 0; ev.impact = 0; ev.side = 0; ev.jackknife = false; ev.bump = 0;

	const m = totalMass( t );
	const accel = clamp( input.accel || 0, 0, 1 );
	const decel = clamp( input.decel || 0, 0, 1 );

	// --- 1. Sentido de marcha (automático simple): con el camión detenido,
	// mantener "atrás" engancha la reversa y "adelante" vuelve a la directa.
	const stopped = Math.abs( t.v ) < 0.3;
	if ( stopped ) {

		const want = accel > 0.1 && decel < 0.1 ? 1 : ( decel > 0.1 && accel < 0.1 ? - 1 : 0 );
		if ( want !== 0 && want !== t.dir ) {

			t.dirHold += dt;
			if ( t.dirHold > 0.25 ) { t.dir = want; t.dirHold = 0; t.jackknife = false; }

		} else t.dirHold = 0;

	} else t.dirHold = 0;

	let thrIn = t.dir > 0 ? accel : decel;
	let brkIn = t.dir > 0 ? decel : accel;
	// mientras se espera el cambio de sentido, el pedal contrario frena
	if ( stopped && t.dirHold > 0 ) { thrIn = 0; brkIn = Math.max( brkIn, 0.3 ); }
	if ( input.handbrake ) { brkIn = 1; thrIn = 0; }
	if ( t.v * t.dir > PARAMS.speedLimit ) thrIn = 0;
	if ( t.jackknife && t.dir < 0 ) thrIn = 0;

	t.throttle += clamp( thrIn - t.throttle, - dt / 0.12, dt / 0.25 );
	t.brake += clamp( brkIn - t.brake, - dt / 0.12, dt / 0.2 );

	// --- 2. Caja y motor
	const nG = e.gears.length;
	if ( stopped && t.shiftT <= 0 ) t.gear = startGear( t );
	const ratio = ( t.dir > 0 ? e.gears[ t.gear - 1 ] : e.reverse ) * e.final;
	const speedAlong = t.v * t.dir; // velocidad en el sentido de la marcha engranada
	const rpmWheel = Math.abs( t.v ) / e.wheelRadius * ratio / RPM_TO_RAD;

	t.sinceShift += dt;
	let tractive = 0, engineBrake = 0, rpmTarget;

	if ( t.shiftT > 0 ) {

		// cambio en curso: sin par, el motor busca el régimen de la marcha entrante
		t.shiftT -= dt;
		const nr = e.gears[ t.nextGear - 1 ] * e.final;
		rpmTarget = Math.max( e.idle, Math.abs( t.v ) / e.wheelRadius * nr / RPM_TO_RAD );
		if ( t.shiftT <= 0 ) { t.gear = t.nextGear; t.sinceShift = 0; }

	} else {

		const slip = rpmWheel < e.idle * 1.15;
		if ( slip ) {

			// embrague patinando en la partida
			rpmTarget = Math.max( e.idle, rpmWheel ) + t.throttle * 350;
			tractive = t.throttle * engineTorque( e, rpmTarget ) * ratio * e.efficiency / e.wheelRadius;

		} else {

			rpmTarget = rpmWheel;
			tractive = t.throttle * engineTorque( e, rpmWheel ) * ratio * e.efficiency / e.wheelRadius;
			if ( t.throttle < 0.05 ) engineBrake = e.drag * ( rpmWheel / 2000 ) * ratio / e.wheelRadius;

		}

		// adherencia del eje motriz
		const driveLoad = Math.min( e.driveAxleMax, 0.3 * m + 2000 );
		tractive = Math.min( tractive, PARAMS.mu * driveLoad * G );

		// lógica de cambios (solo hacia adelante)
		if ( t.dir > 0 && ! stopped && t.sinceShift > 0.9 && speedAlong > 0 ) {

			const up = e.upLo + ( e.upHi - e.upLo ) * t.throttle;
			let target = t.gear;
			// Con el pedal suelto la caja retiene la marcha (freno motor); solo sube
			// para proteger el motor cerca del corte.
			const coasting = t.throttle < 0.05;
			if ( rpmWheel > up && t.gear < nG && ( ! coasting || rpmWheel > e.redline * 0.97 ) ) {

				// Una marcha más alta solo sirve si, con este mismo pedal, el motor
				// sostiene la carga después del cambio. Sin esta condición, en una
				// subida la caja sube, pierde velocidad, baja y vuelve a subir.
				const coast = t.gradeAcc - PARAMS.crr * G - 0.5 * PARAMS.rho * PARAMS.cdA * speedAlong * speedAlong / m;
				const vAfter = Math.max( 0, speedAlong + Math.min( 0, coast ) * PARAMS.shiftTime ); // velocidad al terminar el corte de par
				const minAfter = e.down + 150 + 250 * t.throttle;
				for ( let g2 = t.gear + 1; g2 <= nG && g2 - t.gear <= 3; g2 ++ ) {

					if ( g2 > t.gear + 1 && rpmWheel * e.gears[ g2 - 1 ] / e.gears[ t.gear - 1 ] < minAfter ) break;
					// Tras el cambio el motor debe quedar sobre el régimen de reducción y en la
					// zona plana de su curva de par: más abajo el par cae con las vueltas y el
					// equilibrio es inestable (pierde velocidad, pierde par y termina reduciendo).
					if ( ! coasting && ! sustains( t, e, g2, vAfter, m, PARAMS.shiftReserve, Math.max( e.down + 60, TORQUE_KNEE + 40 ) ) ) break;
					target = g2;

				}

			} else {

				// la caja no baja de la marcha de partida, salvo que el motor se
				// esté quedando sin fuerza en una subida
				const minGear = ( t.throttle > 0.8 && t.aLong < - 0.05 ) ? 1 : startGear( t );
				// Reducción por régimen bajo, o a fondo cuando la marcha actual ya no sostiene la carga.
				// Si la sostiene, reducir solo cortaría el par para volver a subir un momento después.
				const lugging = rpmWheel < e.down;
				const kickdown = t.throttle > 0.85 && t.brake < 0.05 && rpmWheel < e.down + 200 && ! sustains( t, e, t.gear, speedAlong, m, - 0.02 );
				if ( t.gear > minGear && ( lugging || kickdown ) ) {

					target = t.gear - 1;
					const maxAfter = e.upLo + 100;
					while ( target > minGear && rpmWheel * e.gears[ target - 2 ] / e.gears[ t.gear - 1 ] <= maxAfter ) target --;

				}

			}

			if ( target !== t.gear ) {

				t.nextGear = target;
				t.shiftT = PARAMS.shiftTime;
				ev.shift = target;
				tractive = 0; engineBrake = 0;

			}

		}

	}

	t.rpm += ( rpmTarget - t.rpm ) * Math.min( 1, dt / 0.12 );

	// --- 3. Fuerzas longitudinales
	const vAbs = Math.abs( t.v );
	const drive = ( t.dir * tractive ) / m + t.gradeAcc;        // aceleración con signo, eje de avance
	let resist = PARAMS.crr * G + 0.5 * PARAMS.rho * PARAMS.cdA * vAbs * vAbs / m
		+ t.brake * PARAMS.brakeDecel + engineBrake / m;         // magnitud, se opone al movimiento
	// Limitador de velocidad con retardador: en una bajada, cortar el acelerador no basta para sostener 90 km/h.
	if ( speedAlong > PARAMS.speedLimit ) resist += Math.min( PARAMS.retarder, ( speedAlong - PARAMS.speedLimit ) * 1.5 );
	// Sobrerrégimen: si las ruedas arrastran al motor más allá del corte, la compresión lo retiene.
	// Es también lo que limita la velocidad en reversa, que tiene una sola marcha.
	if ( t.shiftT <= 0 && rpmWheel > e.redline ) resist += PARAMS.overRev * ( rpmWheel / e.redline - 1 );

	// retención en parado y ayuda de arranque en pendiente (sin retroceso)
	t.hold = vAbs < 0.15 && ( t.throttle < 0.02 || drive * t.dir <= 0 );
	if ( t.hold ) resist += 6;

	const vPrev = t.v;
	if ( vAbs < 1e-3 ) {

		t.v = Math.abs( drive ) > resist ? ( drive - Math.sign( drive ) * resist ) * dt : 0;

	} else {

		const sg = Math.sign( t.v );
		const vn = t.v + ( drive - sg * resist ) * dt;
		t.v = ( Math.sign( vn ) !== sg && Math.abs( drive ) <= resist ) ? 0 : vn;

	}

	// --- 4. Dirección
	const v2 = Math.max( t.v * t.v, 0.01 );
	const dMax = Math.min( tr.maxSteer, Math.atan( tr.wheelbase * PARAMS.aLatMax / v2 ) );
	const target = clamp( input.steer || 0, - 1, 1 ) * dMax;
	let rate = Math.abs( target ) < Math.abs( t.steer ) ? PARAMS.steerReturn : PARAMS.steerRate;
	if ( input.analog ) rate = 2.5;
	rate = Math.min( rate, Math.max( dMax * 3, 0.12 ) );
	t.steer += clamp( target - t.steer, - rate * dt, rate * dt );
	t.steer = clamp( t.steer, - dMax, dMax );

	// --- 5. Choques del parachoques: la marcha se recorta a la distancia libre
	let travel = t.v * dt;
	if ( collide && travel !== 0 ) {

		const sg = Math.sign( travel );
		const reach = Math.abs( travel ) + PARAMS.probeMargin;
		const free = probeTravel( t, terrain, sg, reach );
		if ( free < reach ) {

			const allowed = Math.max( 0, free - PARAMS.probeMargin );
			ev.impact = Math.abs( t.v );
			travel = sg * Math.min( Math.abs( travel ), allowed );
			t.v = 0;
			t.blocked = 0.6;
			t.blockedDir = sg;

		}

	}

	// --- 6. Cinemática en planta, con los costados vigilados
	planMotion( t, travel, dt, _plan );
	if ( collide && travel !== 0 ) {

		const k = sideSweep( t, _plan, terrain, dt, ev );
		if ( k < 1 ) {

			const sg = Math.sign( travel );
			travel *= k;
			t.v = 0;
			t.blocked = 0.6;
			t.blockedDir = sg;
			ev.impact = Math.max( ev.impact, ev.side );
			planMotion( t, travel, dt, _plan );

		}

	}

	if ( t.blocked > 0 ) t.blocked -= dt;

	const yawRate = _plan.yawRate;
	t.x = _plan.x; t.z = _plan.z; t.yaw = _plan.yaw;
	t.yawRate = yawRate;
	t.odo += Math.abs( travel );

	if ( tl ) {

		t.trailerYaw = _plan.trailerYaw;
		if ( _plan.jack ) {

			t.v = 0;
			if ( ! t.jackknife ) ev.jackknife = true;
			t.jackknife = true;

		} else if ( t.jackknife && Math.abs( wrapPi( t.yaw - t.trailerYaw ) ) < PARAMS.gammaMax - 0.15 ) t.jackknife = false;

	}

	// --- 7. Seguimiento del terreno
	const g = trackGround( t, terrain );
	const moving = Math.abs( t.v ) > 1;

	if ( g.tractor ) {

		t.grounded = true; t.airTime = 0;
		const p = t.gTr;
		// una rueda que acaba de pisar un bulto da un golpe breve, sin mover el plano
		if ( p.fresh && moving ) { t.vF += 0.4; t.rollV += ( ( t.odo * 7 ) % 2 < 1 ? 0.15 : - 0.15 ); ev.bump = 1; }
		// velocidad vertical del suelo bajo el camión: pendiente de la calzada por velocidad
		const climb = ( p.lgx * fwdX( t.yaw ) + p.lgz * fwdZ( t.yaw ) ) * t.v;
		let r = spring( t.hF, t.vF, p.a + p.c * tr.wheelbase, dt, climb ); t.hF = r.value; t.vF = r.vel;
		r = spring( t.hR, t.vR, p.a, dt, climb ); t.hR = r.value; t.vR = r.vel;
		r = spring( t.roll, t.rollV, Math.atan( p.b ), dt ); t.roll = r.value; t.rollV = r.vel;

	} else {

		// sin malla cargada bajo el tracto: se conserva la última postura
		t.airTime += dt;
		if ( t.airTime > 0.5 ) t.grounded = false;

	}

	if ( tl && g.trailer ) {

		const p = t.gTl;
		if ( p.fresh && moving ) { t.vT += 0.4; ev.bump = 1; }
		const climb = ( p.lgx * fwdX( t.trailerYaw ) + p.lgz * fwdZ( t.trailerYaw ) ) * t.v;
		let r = spring( t.hT, t.vT, p.a, dt, climb ); t.hT = r.value; t.vT = r.vel;
		r = spring( t.trailerRoll, t.trailerRollV, Math.atan( p.b ), dt ); t.trailerRoll = r.value; t.trailerRollV = r.vel;

	}

	updatePose( t );

	// pendiente efectiva (ponderada por masa) con un filtro lento para que el
	// ruido de la malla no se traduzca en tirones
	const mTr = tl ? tl.mass + t.cargoMass : 0;
	const mCab = m - mTr;
	const gradeNow = - G * ( mCab * Math.sin( t.pitch ) + mTr * Math.sin( t.trailerPitch ) ) / m;
	t.gradeAcc += ( gradeNow - t.gradeAcc ) * Math.min( 1, dt / 0.5 );

	// aceleraciones para el HUD, el audio y el balanceo visual de la cabina
	const aLongNow = dt > 0 ? ( t.v - vPrev ) / dt : 0;
	t.aLong += ( aLongNow - t.aLong ) * Math.min( 1, dt / 0.15 );
	t.aLat += ( t.v * yawRate - t.aLat ) * Math.min( 1, dt / 0.15 );

	// daño por impacto: nada bajo 3 km/h, total cerca de 60 km/h
	if ( ev.impact > 0.85 ) t.damage = Math.min( 1, t.damage + Math.pow( ev.impact / 16.7, 2 ) );

	return ev;

}

// Datos derivados para el tablero
export function speedKmh( t ) { return Math.abs( t.v ) * 3.6; }
export function gearLabel( t ) {

	if ( t.dir < 0 ) return 'R';
	if ( Math.abs( t.v ) < 0.3 && t.throttle < 0.02 ) return 'N';
	return String( t.shiftT > 0 ? t.nextGear : t.gear );

}

export function articulation( t ) { return t.spec.trailer ? wrapPi( t.yaw - t.trailerYaw ) : 0; }
