// Ruta Sur · tráfico
// --------------------------------------------------------------------------
// Autos, camionetas y micros que recorren la red vial alrededor del camión.
// Cada vehículo sigue una arista del grafo por su lado derecho, elige la
// siguiente en cada cruce, guarda distancia con el de adelante y frena ante
// el camión. Si el camión los embiste, se anota el choque y el vehículo queda
// detenido un momento antes de seguir.
//
// La parte numérica (sin Three.js) está separada de la visual para poder
// probarla sola: `Traffic` mueve los vehículos; `TrafficView` los dibuja.

import * as THREE from 'three';
import { MeshBuilder } from './testcity.js';
import { hitchXZ, trailerAxleXZ } from './physics.js';
import { forSegmentsIn } from './osm.js';

export const KINDS = {
	auto: { length: 4.3, width: 1.75, height: 1.45, mass: 1300, vMax: 15, accel: 2.2, brake: 5.5, cabin: 0.45 },
	camioneta: { length: 5.2, width: 1.9, height: 1.8, mass: 2200, vMax: 14, accel: 1.8, brake: 5, cabin: 0.5 },
	micro: { length: 11, width: 2.5, height: 3.1, mass: 11000, vMax: 12, accel: 1, brake: 3.5, cabin: 0 },
};
const KIND_WEIGHTS = [ [ 'auto', 0.7 ], [ 'camioneta', 0.22 ], [ 'micro', 0.08 ] ];
export const PALETTE = [ [ 0.85, 0.85, 0.87 ], [ 0.2, 0.22, 0.25 ], [ 0.6, 0.62, 0.65 ], [ 0.55, 0.1, 0.1 ], [ 0.15, 0.25, 0.5 ], [ 0.75, 0.73, 0.68 ], [ 0.2, 0.4, 0.3 ], [ 0.8, 0.55, 0.15 ] ];
const MICRO_COLORS = [ [ 0.95, 0.95, 0.95 ], [ 0.1, 0.45, 0.3 ], [ 0.85, 0.5, 0.1 ] ];

export const TRAFFIC = {
	spawnMin: 90,      // los vehículos aparecen entre estas distancias del camión [m]
	spawnMax: 380,
	dropAt: 520,       // y desaparecen más allá de esta [m]
	gap: 7,            // distancia mínima al de adelante, parachoques a parachoques [m]
	headway: 1.3,      // más un tiempo de reacción por la velocidad [s]
	stunned: 5,        // segundos detenido tras un choque
	minRank: 7,        // vías por las que circulan: hasta calles residenciales
};

const fwdX = yaw => - Math.sin( yaw ), fwdZ = yaw => - Math.cos( yaw );

// Cuánto se corre un vehículo hacia la derecha de la arista, según la vía
export function laneOffset( way ) {

	if ( way.oneway !== 0 ) return 0;
	return way.rank <= 4 ? 1.8 : ( way.width >= 7 ? 1.5 : 1.2 );

}

// Puntos del camión que los vehículos esquivan y contra los que chocan: el tracto y,
// si lo lleva, el remolque, cada uno como un rectángulo en planta { x, z, yaw, half, halfW }
const _h = {}, _a = {};
export function truckBodies( t, out = [] ) {

	const tr = t.spec.tractor, tl = t.spec.trailer;
	const lenT = tr.wheelbase + tr.frontOverhang + tr.rearOverhang;
	// centro del tracto: desde el eje trasero, hacia adelante
	const cT = ( tr.wheelbase + tr.frontOverhang - tr.rearOverhang ) / 2;
	out.length = 0;
	out.push( { x: t.x + fwdX( t.yaw ) * cT, z: t.z + fwdZ( t.yaw ) * cT, yaw: t.yaw, half: lenT / 2, halfW: tr.width / 2, vx: t.v * fwdX( t.yaw ), vz: t.v * fwdZ( t.yaw ) } );
	if ( tl ) {

		hitchXZ( t, _h ); trailerAxleXZ( t, _a );
		// el remolque va del perno rey hacia atrás: su centro queda a media longitud desde el frente
		const fx = fwdX( t.trailerYaw ), fz = fwdZ( t.trailerYaw );
		const frontX = _h.x + fx * tl.kingpinFromFront, frontZ = _h.z + fz * tl.kingpinFromFront;
		out.push( { x: frontX - fx * tl.length / 2, z: frontZ - fz * tl.length / 2, yaw: t.trailerYaw, half: tl.length / 2, halfW: tl.width / 2, vx: t.v * fx, vz: t.v * fz } );

	}

	return out;

}

// Separación entre dos rectángulos en planta (teorema del eje separador). Negativo si se
// traslapan; `out.nx, out.nz` es la normal de menor penetración, desde a hacia b.
export function boxGap( a, b, out = {} ) {

	let best = - Infinity, bnx = 0, bnz = 0;
	const dx = b.x - a.x, dz = b.z - a.z;
	for ( const r of [ a, b ] ) {

		const fx = fwdX( r.yaw ), fz = fwdZ( r.yaw ), rx = Math.cos( r.yaw ), rz = - Math.sin( r.yaw );
		for ( const [ nx, nz ] of [ [ fx, fz ], [ rx, rz ] ] ) {

			// radio de cada caja proyectado sobre el eje
			const ra = a.half * Math.abs( nx * fwdX( a.yaw ) + nz * fwdZ( a.yaw ) ) + a.halfW * Math.abs( nx * Math.cos( a.yaw ) - nz * Math.sin( a.yaw ) );
			const rb = b.half * Math.abs( nx * fwdX( b.yaw ) + nz * fwdZ( b.yaw ) ) + b.halfW * Math.abs( nx * Math.cos( b.yaw ) - nz * Math.sin( b.yaw ) );
			const d = dx * nx + dz * nz;
			const gap = Math.abs( d ) - ra - rb;
			if ( gap > best ) { best = gap; const s = d < 0 ? - 1 : 1; bnx = nx * s; bnz = nz * s; }

		}

	}

	out.nx = bnx; out.nz = bnz;
	return best;

}

export class Traffic {

	/**
	 * graph: grafo vial; rng: aleatorio en [0,1); count: cuántos vehículos mantener;
	 * groundAt( x, z ) → altura del suelo o null
	 */
	constructor( { graph, rng = Math.random, count = 20, groundAt = null, signals = null } ) {

		this.graph = graph; this.rng = rng; this.count = count; this.groundAt = groundAt; this.signals = signals;
		this.time = 0;          // reloj propio, para el ciclo de los semáforos
		this.waiting = 0;       // vehículos detenidos ante una luz roja o un Pare en el último paso
		this.vehicles = [];
		this.enabled = true;
		this.hits = 0;          // choques del camión contra vehículos
		this.spawned = 0;
		this.braking = 0;       // vehículos frenando por el camión en el último paso
		this._bodies = [];
		this._gap = {};
		this._edges = null;     // aristas donde pueden aparecer (vías abiertas al tráfico)
		this._since = 0;
		this._prepare();

	}

	_prepare() {

		const g = this.graph, list = [];
		if ( ! g ) { this._edges = []; return; }
		for ( let e = 0; e < g.from.length; e ++ ) {

			const w = g.ways[ g.wayOf[ e ] ];
			if ( w.rank > TRAFFIC.minRank || g.len[ e ] < 8 || ! g.main[ g.from[ e ] ] ) continue;
			list.push( e );

		}

		this._edges = list;

	}

	// Coloca un vehículo al comienzo de una arista
	_place( v, e, s = 0 ) {

		const g = this.graph;
		v.edge = e; v.s = s;
		v.way = g.ways[ g.wayOf[ e ] ];
		v.off = laneOffset( v.way );
		v.turnSlow = this._turnSpeed( e );
		v.nextEdge = this._next( v ); // la salida del cruce se decide al entrar al tramo, así se puede mirar más allá
		this._pose( v );

	}

	_pose( v ) {

		const g = this.graph, e = v.edge, a = g.from[ e ];
		const ux = g.ux[ e ], uz = g.uz[ e ];
		// con +X al oeste, la derecha del avance (ux, uz) es (-uz, ux)
		v.x = g.x[ a ] + ux * v.s - uz * v.off;
		v.z = g.z[ a ] + uz * v.s + ux * v.off;
		v.yaw = Math.atan2( - ux, - uz );

	}

	// Velocidad con que conviene llegar al final de la arista, según el giro que sigue
	_turnSpeed( e ) {

		const g = this.graph, n = g.to[ e ], outs = g.adj[ n ];
		if ( outs.length === 0 ) return 0;
		let straightest = - 2;
		for ( const e2 of outs ) { if ( e2 === g.rev[ e ] ) continue; straightest = Math.max( straightest, g.ux[ e ] * g.ux[ e2 ] + g.uz[ e ] * g.uz[ e2 ] ); }
		if ( straightest < - 1 ) return 1.5;           // solo se puede dar la vuelta
		return 3 + 12 * Math.max( 0, straightest );     // recto: 15 m/s; en ángulo: 3 m/s

	}

	// Elige la arista siguiente al final de la actual: prefiere seguir derecho, evita volver
	_next( v ) {

		const g = this.graph, e = v.edge, n = g.to[ e ], outs = g.adj[ n ];
		let best = - 1, total = 0;
		const cands = [];
		for ( const e2 of outs ) {

			if ( e2 === g.rev[ e ] ) continue;
			const w = g.ways[ g.wayOf[ e2 ] ];
			if ( w.rank > TRAFFIC.minRank ) continue;
			const dot = g.ux[ e ] * g.ux[ e2 ] + g.uz[ e ] * g.uz[ e2 ];
			const weight = ( 0.3 + dot + 1 ) * ( w.rank <= 4 ? 1.6 : 1 );
			cands.push( [ e2, weight ] ); total += weight;

		}

		if ( cands.length === 0 ) return g.rev[ e ] >= 0 ? g.rev[ e ] : - 1;
		let r = this.rng() * total;
		for ( const [ e2, w ] of cands ) { r -= w; if ( r <= 0 ) { best = e2; break; } }
		return best >= 0 ? best : cands[ cands.length - 1 ][ 0 ];

	}

	_spawnOne( truck ) {

		const g = this.graph, E = this._edges;
		if ( ! E || E.length === 0 ) return false;
		for ( let tries = 0; tries < 20; tries ++ ) {

			const e = E[ Math.floor( this.rng() * E.length ) ];
			const s = this.rng() * Math.max( 0, g.len[ e ] - 6 );
			const a = g.from[ e ], x = g.x[ a ] + g.ux[ e ] * s, z = g.z[ a ] + g.uz[ e ] * s;
			const d = Math.hypot( x - truck.x, z - truck.z );
			if ( d < TRAFFIC.spawnMin || d > TRAFFIC.spawnMax ) continue;
			// no encima de otro
			let near = false;
			for ( const o of this.vehicles ) if ( Math.hypot( o.x - x, o.z - z ) < 14 ) { near = true; break; }
			if ( near ) continue;
			const w = g.ways[ g.wayOf[ e ] ];
			let kind = 'auto', r = this.rng();
			for ( const [ k, p ] of KIND_WEIGHTS ) { r -= p; if ( r <= 0 ) { kind = k; break; } }
			if ( kind === 'micro' && w.rank > 4 ) kind = 'auto';
			const K = KINDS[ kind ];
			const color = kind === 'micro' ? MICRO_COLORS[ Math.floor( this.rng() * MICRO_COLORS.length ) ] : PALETTE[ Math.floor( this.rng() * PALETTE.length ) ];
			const v = { id: this.spawned ++, kind, K, color, x: 0, z: 0, y: 0, yaw: 0, v: Math.min( K.vMax, w.maxspeed / 3.6 ) * 0.7, stun: 0, hit: 0, hitCool: 0, since: 0, stopWait: 0, passedNode: - 1, groundT: this.rng() * 0.3, mesh: null, half: K.length / 2, halfW: K.width / 2, brakingFor: 0 };
			this._place( v, e, s );
			if ( this.groundAt ) { const gy = this.groundAt( v.x, v.z ); v.y = gy === null ? 0 : gy; }
			this.vehicles.push( v );
			return true;

		}

		return false;

	}

	// Para pruebas: deja un vehículo detenido a `dist` metros por delante del camión, sobre su calle
	spawnAhead( truck, dist = 30, kind = 'auto' ) {

		const g = this.graph;
		const fx = fwdX( truck.yaw ), fz = fwdZ( truck.yaw );
		const px = truck.x + fx * dist, pz = truck.z + fz * dist;
		let best = null, bestD = 30;
		forSegmentsIn( g, px - 30, pz - 30, px + 30, pz + 30, ( w, i, ax, az, bx, bz ) => {

			for ( const e of [ w.fwd[ i ], w.bwd[ i ] ] ) {

				if ( e < 0 || g.ux[ e ] * fx + g.uz[ e ] * fz < 0.7 ) continue; // en el sentido del camión
				const t = ( ( px - ax ) * ( bx - ax ) + ( pz - az ) * ( bz - az ) ) / ( ( bx - ax ) ** 2 + ( bz - az ) ** 2 || 1 );
				if ( t < 0 || t > 1 ) continue;
				const qx = ax + ( bx - ax ) * t, qz = az + ( bz - az ) * t, d = Math.hypot( px - qx, pz - qz );
				const s = e === w.fwd[ i ] ? t * g.len[ e ] : ( 1 - t ) * g.len[ e ];
				if ( d < bestD ) { bestD = d; best = { e, s }; }

			}

		} );
		if ( ! best ) return null;
		const K = KINDS[ kind ];
		const v = { id: this.spawned ++, kind, K, color: PALETTE[ 0 ], x: 0, z: 0, y: 0, yaw: 0, v: 0, stun: 1e9, hit: 0, hitCool: 0, since: 0, stopWait: 0, passedNode: - 1, groundT: 0, mesh: null, half: K.length / 2, halfW: K.width / 2, brakingFor: 0 };
		this._place( v, best.e, best.s );
		if ( this.groundAt ) { const gy = this.groundAt( v.x, v.z ); if ( gy !== null ) v.y = gy; }
		this.vehicles.push( v );
		return v;

	}

	// Saca los vehículos a menos de `r` metros del punto (al reubicar el camión)
	clearNear( x, z, r = 40 ) {

		for ( const v of this.vehicles ) if ( Math.hypot( v.x - x, v.z - z ) < r ) v.drop = true;
		this._purge();

	}

	_purge() {

		const keep = [];
		for ( const v of this.vehicles ) { if ( v.drop ) { if ( this.onDrop ) this.onDrop( v ); } else keep.push( v ); }
		this.vehicles = keep;

	}

	/**
	 * Avanza un paso. truck: estado del camión; collisions: si el camión choca con los vehículos.
	 * Devuelve { hit: velocidad de cierre del choque más fuerte [m/s] (0 si no hubo), vehicle }
	 */
	step( truck, dt, collisions = true ) {

		const out = this._out || ( this._out = { hit: 0, vehicle: null } );
		out.hit = 0; out.vehicle = null;
		if ( ! this.enabled || ! this.graph ) return out;
		const g = this.graph, V = this.vehicles;
		const bodies = truckBodies( truck, this._bodies );
		this.braking = 0; this.waiting = 0;
		this.time += dt;

		for ( const v of V ) {

			v.since += dt;
			// lejos del camión desaparece
			const dTruck = Math.hypot( v.x - truck.x, v.z - truck.z );
			if ( dTruck > TRAFFIC.dropAt ) { v.drop = true; continue; }

			// --- velocidad objetivo: límite de la vía, el giro que viene, el de adelante y el camión
			const K = v.K, w = v.way, remaining = g.len[ v.edge ] - v.s;
			let target = Math.min( K.vMax, w.maxspeed / 3.6 * 0.9 );
			// frenar para el giro al final de la arista: v² = v0² + 2 a d
			target = Math.min( target, Math.sqrt( v.turnSlow * v.turnSlow + 2 * K.brake * 0.6 * Math.max( 0, remaining ) ) );
			// semáforo o Pare al final de la arista, o al final de la siguiente si esta es corta:
			// detenerse en la línea (a stopBack del centro del cruce)
			let node = g.to[ v.edge ], cr = this.signals && v.passedNode !== node ? this.signals.atNode( node ) : null, toNode = remaining, ruleWay = w.id;
			if ( this.signals && ! cr && remaining < 35 && v.nextEdge >= 0 ) {

				const n2 = g.to[ v.nextEdge ], c2 = this.signals.atNode( n2 );
				if ( c2 ) { cr = c2; node = n2; toNode = remaining + g.len[ v.nextEdge ]; ruleWay = g.ways[ g.wayOf[ v.nextEdge ] ].id; }

			}

			if ( cr ) {

				const rule = this.signals.ruleFor( cr, ruleWay, this.time );
				const stopAt = Math.max( 0, toNode - cr.stopBack );
				const canStop = v.v * v.v / ( 2 * K.brake ) <= stopAt + 0.5;
				if ( rule === 'stop' ) {

					// Pare: llegar a la línea, esperar un segundo y seguir
					if ( stopAt < 0.6 && v.v < 0.15 ) { v.stopWait += dt; if ( v.stopWait >= 1 ) v.passedNode = node; }
					if ( v.passedNode !== node ) { target = Math.min( target, Math.sqrt( 2 * K.brake * 0.8 * stopAt ) ); if ( stopAt < 0.6 ) target = 0; this.waiting ++; }

				} else if ( rule === 'red' || ( rule === 'amber' && canStop ) ) {

					target = Math.min( target, Math.sqrt( 2 * K.brake * 0.8 * stopAt ) );
					if ( stopAt < 0.6 ) target = 0;
					this.waiting ++;

				} else if ( rule === 'green' ) v.stopWait = 0;

			}
			// el de adelante, en la misma arista o en la siguiente
			const fx = fwdX( v.yaw ), fz = fwdZ( v.yaw );
			let ahead = Infinity, aheadV = 0;
			for ( const o of V ) {

				if ( o === v ) continue;
				const dx = o.x - v.x, dz = o.z - v.z;
				const along = dx * fx + dz * fz;
				if ( along <= 0 || along > 60 ) continue;
				const side = Math.abs( dx * fz - dz * fx );
				if ( side > 2.2 ) continue;
				const gap = along - v.half - o.half;
				if ( gap < ahead ) { ahead = gap; aheadV = o.v * ( fwdX( o.yaw ) * fx + fwdZ( o.yaw ) * fz ); }

			}

			// el camión, por delante y dentro del carril: cada unidad proyectada sobre los ejes del vehículo
			let forTruck = false;
			const rx = Math.cos( v.yaw ), rz = - Math.sin( v.yaw );
			for ( const b of bodies ) {

				const dx = b.x - v.x, dz = b.z - v.z;
				const along = dx * fx + dz * fz;
				if ( along <= 0 || along > 70 ) continue;
				const bfx = fwdX( b.yaw ), bfz = fwdZ( b.yaw ), brx = Math.cos( b.yaw ), brz = - Math.sin( b.yaw );
				const extSide = b.half * Math.abs( bfx * rx + bfz * rz ) + b.halfW * Math.abs( brx * rx + brz * rz );
				const side = Math.abs( dx * rx + dz * rz );
				if ( side > extSide + 1.2 ) continue;
				const extAlong = b.half * Math.abs( bfx * fx + bfz * fz ) + b.halfW * Math.abs( brx * fx + brz * fz );
				const gap = along - v.half - extAlong;
				if ( gap < ahead ) { ahead = gap; aheadV = b.vx * fx + b.vz * fz; forTruck = true; }

			}

			if ( ahead < Infinity ) {

				// velocidad que permite detenerse a `gap` metros del de adelante
				const want = Math.max( 0, ahead - TRAFFIC.gap - v.v * TRAFFIC.headway );
				const vStop = Math.sqrt( 2 * K.brake * want );
				target = Math.min( target, Math.max( aheadV, 0 ) + vStop );
				if ( forTruck && target < v.v - 0.1 ) { this.braking ++; v.brakingFor = 0.5; }

			}

			if ( v.brakingFor > 0 ) v.brakingFor -= dt;
			if ( v.hitCool > 0 ) v.hitCool -= dt;
			if ( v.stun > 0 ) { v.stun -= dt; target = 0; }

			// --- avance
			if ( v.v < target ) v.v = Math.min( target, v.v + K.accel * dt );
			else v.v = Math.max( target, v.v - K.brake * dt );
			v.s += v.v * dt;
			while ( v.s >= g.len[ v.edge ] ) {

				const e2 = v.nextEdge >= 0 ? v.nextEdge : this._next( v );
				v.stopWait = 0; if ( v.passedNode !== g.to[ e2 ] ) v.passedNode = - 1;
				if ( e2 < 0 ) { v.drop = true; break; }
				const over = v.s - g.len[ v.edge ];
				this._place( v, e2, over );

			}

			if ( v.drop ) continue;
			this._pose( v );

			// --- altura del suelo, de vez en cuando
			v.groundT -= dt;
			if ( v.groundT <= 0 && this.groundAt ) { v.groundT = 0.3; const gy = this.groundAt( v.x, v.z ); if ( gy !== null ) v.y = gy; }

			// --- choque con el camión
			if ( ! collisions || dTruck > 40 ) continue;
			for ( const b of bodies ) {

				const gap = boxGap( b, v, this._gap );
				if ( gap >= 0 ) continue;
				const n = this._gap;
				// velocidad de cierre: la del camión sobre la normal, menos la del vehículo
				const closing = ( b.vx * n.nx + b.vz * n.nz ) - v.v * ( fwdX( v.yaw ) * n.nx + fwdZ( v.yaw ) * n.nz );
				if ( closing > out.hit ) { out.hit = closing; out.vehicle = v; }
				// el vehículo queda aturdido y el camión lo saca de encima; un mismo choque se cuenta una vez
				if ( v.hitCool <= 0 ) { v.hit ++; this.hits ++; }
				v.hitCool = 1.5;
				v.stun = Math.max( v.stun, TRAFFIC.stunned ); v.v = 0;
				v.x -= n.nx * gap; v.z -= n.nz * gap; // gap es negativo: lo empuja hacia afuera
				// y guarda ese corrimiento como desvío de carril, para no volver a entrar en el mismo paso
				const ux = g.ux[ v.edge ], uz = g.uz[ v.edge ];
				const dxp = v.x - ( g.x[ g.from[ v.edge ] ] + ux * v.s ), dzp = v.z - ( g.z[ g.from[ v.edge ] ] + uz * v.s );
				v.off = - dxp * uz + dzp * ux;
				v.s += dxp * ux + dzp * uz;

			}

		}

		this._purge();

		// --- reposición
		this._since += dt;
		if ( this._since > 0.25 ) {

			this._since = 0;
			// al empezar se llena rápido; después, de a pocos
			let n = 0;
			const burst = this.vehicles.length < this.count / 2 ? 6 : 2;
			while ( this.vehicles.length < this.count && n < burst ) { if ( ! this._spawnOne( truck ) ) break; n ++; }

		}

		return out;

	}

}

// --------------------------------------------------------------------------
// Vista: una malla por vehículo (carrocería con colores por vértice) y otra con las luces
// --------------------------------------------------------------------------
const _geoms = new Map();

// Carrocería como cajas con sombreado plano, mirando hacia -Z, con el origen en el suelo
function bodyGeometry( kind, color ) {

	const k = `${ kind }:${ color.join( ',' ) }`;
	let geo = _geoms.get( k );
	if ( geo ) return geo;
	const K = KINDS[ kind ], mb = new MeshBuilder();
	const L = K.length, W = K.width, H = K.height, hw = W / 2;
	const dark = [ 0.1, 0.11, 0.13 ], glass = [ 0.16, 0.2, 0.25 ], tire = [ 0.08, 0.08, 0.09 ];
	if ( kind === 'micro' ) {

		mb.box( - hw, hw, - L / 2, L / 2, 0.45, H * 0.55, color, 0.9 );
		mb.box( - hw + 0.03, hw - 0.03, - L / 2 + 0.3, L / 2 - 0.1, H * 0.55, H, glass, 0.85 );
		mb.box( - hw, hw, - L / 2 + 0.05, L / 2, H - 0.2, H + 0.05, color, 0.85 );

	} else {

		const roof = H * 0.52;
		mb.box( - hw, hw, - L / 2, L / 2, 0.35, roof, color, 0.9 );
		const front = - L / 2 + ( kind === 'camioneta' ? 1.5 : 0.9 ), back = kind === 'camioneta' ? - L / 2 + 3.4 : L / 2 - 0.9;
		mb.box( - hw + 0.12, hw - 0.12, front, back, roof, H, glass, 0.3 );
		mb.box( - hw + 0.12, hw - 0.12, front + 0.45, back - 0.4, H - 0.06, H + 0.02, color, 0.9 );
		if ( kind === 'camioneta' ) mb.box( - hw + 0.08, hw - 0.08, - L / 2 + 3.4, L / 2 - 0.1, roof, roof + 0.2, dark, 0.9 );

	}

	// ruedas: dos ejes
	const r = kind === 'micro' ? 0.5 : 0.33, ax = kind === 'micro' ? [ - L / 2 + 2.4, L / 2 - 2.6 ] : [ - L / 2 + 0.85, L / 2 - 0.9 ];
	for ( const z of ax ) for ( const s of [ - 1, 1 ] ) mb.box( s * hw - ( s > 0 ? 0.26 : 0 ), s * hw + ( s < 0 ? 0.26 : 0 ), z - r, z + r, 0, 2 * r, tire, 0.6 );
	geo = new THREE.BufferGeometry();
	const m = mb.finish();
	geo.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
	geo.setAttribute( 'color', new THREE.BufferAttribute( m.colors, 3 ) );
	geo.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
	geo.computeVertexNormals();
	_geoms.set( k, geo );
	return geo;

}

// Luces: focos adelante (blanco cálido) y pilotos atrás (rojo), en una sola malla
function lightsGeometry( kind ) {

	const k = `luces:${ kind }`;
	let geo = _geoms.get( k );
	if ( geo ) return geo;
	const K = KINDS[ kind ], mb = new MeshBuilder();
	const L = K.length, hw = K.width / 2, y = kind === 'micro' ? 0.9 : 0.62;
	for ( const s of [ - 1, 1 ] ) {

		mb.box( s * hw - 0.42 * ( s > 0 ? 1 : 0 ), s * hw + 0.42 * ( s < 0 ? 1 : 0 ), - L / 2 - 0.02, - L / 2 + 0.1, y, y + 0.16, [ 1, 0.95, 0.8 ], 1 );
		mb.box( s * hw - 0.3 * ( s > 0 ? 1 : 0 ), s * hw + 0.3 * ( s < 0 ? 1 : 0 ), L / 2 - 0.1, L / 2 + 0.02, y, y + 0.14, [ 1, 0.1, 0.08 ], 1 );

	}

	geo = new THREE.BufferGeometry();
	const m = mb.finish();
	geo.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
	geo.setAttribute( 'color', new THREE.BufferAttribute( m.colors, 3 ) );
	geo.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
	_geoms.set( k, geo );
	return geo;

}

export class TrafficView {

	constructor( scene, traffic ) {

		this.scene = scene; this.traffic = traffic;
		this.group = new THREE.Group(); this.group.name = 'Tráfico';
		scene.add( this.group );
		this.bodyMat = new THREE.MeshLambertMaterial( { vertexColors: true } );
		this.lightMat = new THREE.MeshBasicMaterial( { vertexColors: true } );
		this.lightMat.color.setScalar( 0.35 );
		this.lights = 0;
		traffic.onDrop = v => this._remove( v );

	}

	// De noche las luces brillan y la carrocería se oscurece con la luz de la escena
	setNight( lamps ) { this.lights = lamps; this.lightMat.color.setScalar( 0.35 + 0.65 * lamps ); }

	_remove( v ) { if ( v.mesh ) { this.group.remove( v.mesh ); v.mesh = null; } }

	update() {

		for ( const v of this.traffic.vehicles ) {

			if ( ! v.mesh ) {

				const m = new THREE.Mesh( bodyGeometry( v.kind, v.color ), this.bodyMat );
				m.add( new THREE.Mesh( lightsGeometry( v.kind ), this.lightMat ) );
				v.mesh = m; this.group.add( m );

			}

			v.mesh.position.set( v.x, v.y, v.z );
			v.mesh.rotation.y = v.yaw;

		}

	}

	dispose() {

		for ( const v of this.traffic.vehicles ) this._remove( v );
		this.scene.remove( this.group );
		this.bodyMat.dispose(); this.lightMat.dispose();

	}

}
