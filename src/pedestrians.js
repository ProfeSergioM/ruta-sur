// Ruta Sur · peatones
// --------------------------------------------------------------------------
// Gente que camina por las veredas de la red vial. Cada peatón sigue una
// arista del grafo por la vereda de un lado, y en cada esquina elige la calle
// que sigue; si la vereda siguiente queda al otro lado de una calle, la cruza
// en línea recta por la esquina (donde están los pasos de cebra). El tráfico
// frena ante un peatón que cruza; el camión que lo atropella paga una multa
// y el peatón vuelve a la vereda. Sin Three.js en la parte numérica.

import * as THREE from 'three';
import { MeshBuilder } from './testcity.js';
import { ROAD_WIDTH } from './openmap.js';
import { boxGap, truckBodies } from './traffic.js';

export const PED = {
	spawnMin: 25, spawnMax: 220, dropAt: 300,
	speedMin: 1.0, speedMax: 1.6,   // [m/s]
	offset: 1.2,                     // de la solera hacia adentro de la vereda [m]
	half: 0.28,                      // medio ancho de la caja en planta [m]
	fine: 100000,                    // multa por atropello [$]
};
const SHIRTS = [ [ 0.85, 0.2, 0.2 ], [ 0.2, 0.35, 0.7 ], [ 0.9, 0.85, 0.75 ], [ 0.2, 0.55, 0.35 ], [ 0.95, 0.75, 0.2 ], [ 0.5, 0.3, 0.6 ], [ 0.15, 0.15, 0.18 ], [ 0.95, 0.95, 0.95 ] ];
const PANTS = [ [ 0.15, 0.18, 0.3 ], [ 0.25, 0.25, 0.27 ], [ 0.5, 0.45, 0.38 ], [ 0.1, 0.1, 0.12 ] ];
const SKINS = [ [ 0.87, 0.68, 0.55 ], [ 0.72, 0.5, 0.36 ], [ 0.55, 0.36, 0.25 ], [ 0.93, 0.78, 0.66 ] ];

const fwdX = yaw => - Math.sin( yaw ), fwdZ = yaw => - Math.cos( yaw );

export class Pedestrians {

	/** graph: red vial; rng: aleatorio; count: cuántos mantener; groundAt( x, z ) → altura o null; signals: semáforos (opcional) */
	constructor( { graph, rng = Math.random, count = 16, groundAt = null, signals = null } ) {

		this.graph = graph; this.rng = rng; this.count = count; this.groundAt = groundAt; this.signals = signals;
		this.time = 0;          // reloj propio, el mismo ciclo que el tráfico
		this.waiting = 0;       // peatones esperando la luz en una esquina en el último paso
		this.list = [];
		this.enabled = true;
		this.hits = 0; this.spawned = 0; this.crossings = 0;
		this._bodies = []; this._gap = {}; this._since = 0;
		this._edges = [];
		if ( graph ) for ( let e = 0; e < graph.from.length; e ++ ) if ( graph.len[ e ] >= 10 && graph.main[ graph.from[ e ] ] ) this._edges.push( e );

	}

	sidewalkOffset( e ) { const w = this.graph.ways[ this.graph.wayOf[ e ] ]; return ( ROAD_WIDTH[ w.highway ] || 5 ) / 2 + PED.offset; }

	// Posición sobre la vereda de la arista `e`, a `s` metros del inicio, del lado `side` (1 derecha, -1 izquierda)
	sidewalkAt( e, s, side, out ) {

		const g = this.graph, a = g.from[ e ], ux = g.ux[ e ], uz = g.uz[ e ], off = this.sidewalkOffset( e ) * side;
		// con +X al oeste, la derecha del avance (ux, uz) es (-uz, ux)
		out.x = g.x[ a ] + ux * s - uz * off; out.z = g.z[ a ] + uz * s + ux * off;
		return out;

	}

	_place( p, e, s ) {

		p.edge = e; p.s = s;
		this.sidewalkAt( e, s, p.side, p );
		p.yaw = Math.atan2( - this.graph.ux[ e ], - this.graph.uz[ e ] );

	}

	_spawnOne( truck ) {

		const g = this.graph, E = this._edges;
		if ( E.length === 0 ) return false;
		for ( let tries = 0; tries < 20; tries ++ ) {

			const e = E[ Math.floor( this.rng() * E.length ) ], s = this.rng() * g.len[ e ], side = this.rng() < 0.5 ? - 1 : 1;
			const p = { id: this.spawned, side, speed: PED.speedMin + this.rng() * ( PED.speedMax - PED.speedMin ), x: 0, z: 0, y: 0, yaw: 0, edge: e, s, crossing: null, hit: 0, hitCool: 0, phase: this.rng() * 6.28, mesh: null, half: PED.half, halfW: PED.half, groundT: 0,
				shirt: SHIRTS[ Math.floor( this.rng() * SHIRTS.length ) ], pants: PANTS[ Math.floor( this.rng() * PANTS.length ) ], skin: SKINS[ Math.floor( this.rng() * SKINS.length ) ], tall: 1.55 + this.rng() * 0.3 };
			this._place( p, e, s );
			const d = Math.hypot( p.x - truck.x, p.z - truck.z );
			if ( d < PED.spawnMin || d > PED.spawnMax ) continue;
			let near = false;
			for ( const o of this.list ) if ( Math.hypot( o.x - p.x, o.z - p.z ) < 3 ) { near = true; break; }
			if ( near ) continue;
			this.spawned ++;
			if ( this.groundAt ) { const gy = this.groundAt( p.x, p.z ); if ( gy !== null ) p.y = gy; }
			this.list.push( p );
			return true;

		}

		return false;

	}

	// Al final de la arista: la siguiente, preferentemente derecho; si su vereda queda al otro lado
	// de una calle, se cruza en línea recta desde la esquina
	_turn( p ) {

		const g = this.graph, e = p.edge, n = g.to[ e ], outs = g.adj[ n ];
		let best = - 1, bestDot = - 2;
		for ( const e2 of outs ) {

			if ( e2 === g.rev[ e ] ) continue;
			const dot = g.ux[ e ] * g.ux[ e2 ] + g.uz[ e ] * g.uz[ e2 ];
			// seguir derecho pesa más, pero una de cada cuatro esquinas, más o menos, se dobla
			const score = dot * 0.5 + this.rng();
			if ( score > bestDot ) { bestDot = score; best = e2; }

		}

		if ( best < 0 ) { best = g.rev[ e ]; if ( best < 0 ) { p.drop = true; return; } p.side = - p.side; } // calle sin salida: se devuelve por la otra vereda
		const from = { x: p.x, z: p.z }, to = this.sidewalkAt( best, 0, p.side, {} );
		const d = Math.hypot( to.x - from.x, to.z - from.z );
		p.edge = best; p.s = 0;
		if ( d > 2.5 ) {

			p.crossing = { x0: from.x, z0: from.z, x1: to.x, z1: to.z, t: 0, len: d, cr: null, wayId: null };
			// en un cruce con semáforo se cruza la calle cuyos autos tienen luz roja: la calle cruzada es
			// la que sale del nodo más perpendicular al recorrido del cruce
			const cr = this.signals ? this.signals.atNode( n ) : null;
			if ( cr && cr.kind === 'light' ) {

				const cx = ( to.x - from.x ) / d, cz = ( to.z - from.z ) / d;
				let bestDot = 2, wayId = null;
				for ( const e2 of outs ) { const dot = Math.abs( g.ux[ e2 ] * cx + g.uz[ e2 ] * cz ); if ( dot < bestDot ) { bestDot = dot; wayId = g.ways[ g.wayOf[ e2 ] ].id; } }
				if ( wayId !== null ) { p.crossing.cr = cr; p.crossing.wayId = wayId; }

			}

			this.crossings ++; p.yaw = Math.atan2( - ( to.x - from.x ), - ( to.z - from.z ) );

		} else this._place( p, best, 0 );

	}

	clearNear( x, z, r = 20 ) { for ( const p of this.list ) if ( Math.hypot( p.x - x, p.z - z ) < r ) p.drop = true; this._purge(); }

	_purge() {

		const keep = [];
		for ( const p of this.list ) { if ( p.drop ) { if ( this.onDrop ) this.onDrop( p ); } else keep.push( p ); }
		this.list = keep;

	}

	/**
	 * Avanza un paso. Devuelve { hit: velocidad de cierre del atropello más fuerte [m/s] (0 si no hubo), who }
	 */
	step( truck, dt, collisions = true ) {

		const out = this._out || ( this._out = { hit: 0, who: null } );
		out.hit = 0; out.who = null;
		if ( ! this.enabled || ! this.graph ) return out;
		const g = this.graph, bodies = truckBodies( truck, this._bodies );
		this.time += dt; this.waiting = 0;
		for ( const p of this.list ) {

			const dTruck = Math.hypot( p.x - truck.x, p.z - truck.z );
			if ( dTruck > PED.dropAt ) { p.drop = true; continue; }
			if ( p.hitCool > 0 ) p.hitCool -= dt;
			p.phase += dt * 6;
			if ( p.crossing ) {

				const c = p.crossing;
				// antes de bajar de la solera, espera a que la calle cruzada tenga luz roja para los autos
				if ( c.t === 0 && c.cr && this.signals.state( c.cr, c.wayId, this.time ) !== 'red' ) { this.waiting ++; continue; }
				c.t += p.speed * dt;
				if ( c.t >= c.len ) { p.crossing = null; this._place( p, p.edge, 0 ); }
				else { const f = c.t / c.len; p.x = c.x0 + ( c.x1 - c.x0 ) * f; p.z = c.z0 + ( c.z1 - c.z0 ) * f; }

			} else {

				p.s += p.speed * dt;
				if ( p.s >= g.len[ p.edge ] ) this._turn( p );
				else this.sidewalkAt( p.edge, p.s, p.side, p );

			}

			if ( p.drop ) continue;
			p.groundT -= dt;
			if ( p.groundT <= 0 && this.groundAt ) { p.groundT = 0.4; const gy = this.groundAt( p.x, p.z ); if ( gy !== null ) p.y = gy; }

			// --- atropello: el camión lo toca y se acerca; el peatón vuelve a su vereda
			if ( ! collisions || dTruck > 30 || p.hitCool > 0 ) continue;
			for ( const b of bodies ) {

				const gap = boxGap( b, p, this._gap );
				if ( gap >= 0 ) continue;
				const n = this._gap, closing = b.vx * n.nx + b.vz * n.nz;
				if ( closing < 0.3 ) continue;
				if ( closing > out.hit ) { out.hit = closing; out.who = p; }
				p.hit ++; this.hits ++; p.hitCool = 4;
				p.crossing = null; this.sidewalkAt( p.edge, Math.min( p.s, g.len[ p.edge ] - 0.1 ), p.side, p );
				break;

			}

		}

		this._purge();
		this._since += dt;
		if ( this._since > 0.3 ) {

			this._since = 0;
			let k = 0;
			const burst = this.list.length < this.count / 2 ? 6 : 2;
			while ( this.list.length < this.count && k < burst ) { if ( ! this._spawnOne( truck ) ) break; k ++; }

		}

		return out;

	}

}

// --------------------------------------------------------------------------
// Vista: una malla por peatón (cuerpo, cabeza y piernas), que se balancea al caminar
// --------------------------------------------------------------------------
function personGeometry( p ) {

	const mb = new MeshBuilder(), h = p.tall, leg = h * 0.47, torso = h * 0.37, head = h * 0.16;
	mb.box( - 0.16, - 0.02, - 0.1, 0.1, 0, leg, p.pants, 0.6 );
	mb.box( 0.02, 0.16, - 0.1, 0.1, 0, leg, p.pants, 0.6 );
	mb.box( - 0.21, 0.21, - 0.12, 0.12, leg, leg + torso, p.shirt, 0.9 );
	mb.box( - 0.28, - 0.21, - 0.08, 0.08, leg + 0.1, leg + torso - 0.05, p.shirt, 0.8 );
	mb.box( 0.21, 0.28, - 0.08, 0.08, leg + 0.1, leg + torso - 0.05, p.shirt, 0.8 );
	mb.box( - 0.1, 0.1, - 0.1, 0.1, leg + torso, leg + torso + head, p.skin, 0.95 );
	const m = mb.finish(), geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
	geo.setAttribute( 'color', new THREE.BufferAttribute( m.colors, 3 ) );
	geo.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
	geo.computeVertexNormals();
	return geo;

}

export class PedestrianView {

	constructor( scene, peds ) {

		this.scene = scene; this.peds = peds;
		this.group = new THREE.Group(); this.group.name = 'Peatones';
		scene.add( this.group );
		this.mat = new THREE.MeshLambertMaterial( { vertexColors: true } );
		peds.onDrop = p => this._remove( p );

	}

	_remove( p ) { if ( p.mesh ) { this.group.remove( p.mesh ); p.mesh.geometry.dispose(); p.mesh = null; } }

	update() {

		for ( const p of this.peds.list ) {

			if ( ! p.mesh ) { p.mesh = new THREE.Mesh( personGeometry( p ), this.mat ); p.mesh.castShadow = true; this.group.add( p.mesh ); }
			p.mesh.position.set( p.x, p.y + 0.03 * Math.abs( Math.sin( p.phase ) ), p.z );
			p.mesh.rotation.y = p.yaw;

		}

	}

	dispose() { for ( const p of this.peds.list ) this._remove( p ); this.scene.remove( this.group ); this.mat.dispose(); }

}
