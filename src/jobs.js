// Ruta Sur · encargos de reparto
// --------------------------------------------------------------------------
// Un encargo es una carga y una esquina de destino dentro de la ciudad. El
// pago depende de la distancia y del peso, y se descuenta por daño.
// El módulo no depende de Three.js.

import { pickDestination, route, RouteTracker, maneuverText } from './osm.js';

// carga, rango de masa en toneladas para el articulado y tarifa relativa
export const CARGAS = [
	{ nombre: 'Salmón congelado', masa: [ 14, 22 ], tarifa: 1.25 },
	{ nombre: 'Madera aserrada', masa: [ 18, 25 ], tarifa: 1.0 },
	{ nombre: 'Fruta de exportación', masa: [ 12, 20 ], tarifa: 1.15 },
	{ nombre: 'Cemento en sacos', masa: [ 20, 25 ], tarifa: 0.95 },
	{ nombre: 'Bebidas', masa: [ 10, 18 ], tarifa: 1.0 },
	{ nombre: 'Electrodomésticos', masa: [ 6, 12 ], tarifa: 1.2 },
	{ nombre: 'Harina', masa: [ 15, 24 ], tarifa: 1.0 },
	{ nombre: 'Materiales de construcción', masa: [ 16, 25 ], tarifa: 1.05 },
];

const RETRY = 8; // segundos entre intentos de encontrar un encargo cuando no hay destino alcanzable

export function payFor( lengthM, massKg, tarifa ) {

	const km = lengthM / 1000, t = massKg / 1000;
	return Math.round( ( 15000 + 14000 * km + 550 * t * km ) * tarifa / 100 ) * 100;

}

export class Jobs {

	/**
	 * graph: grafo vial (o null para modo libre); spec: vehículo; rng: aleatorio en [0,1)
	 */
	constructor( { graph, spec, rng = Math.random, store = null } ) {

		this.graph = graph; this.spec = spec; this.rng = rng; this.store = store;
		this.state = graph ? 'none' : 'libre';   // none | offer | active | done | libre
		this.job = null;
		this.tracker = null;
		this.folio = 1;
		this.entregas = 0; this.total = 0;
		this.offRoute = 0; this.doneT = 0; this.retryT = 0;
		this.last = null;       // resultado del último encargo
		if ( store ) {

			const s = store.get();
			if ( s ) { this.entregas = s.entregas | 0; this.total = + s.total || 0; this.folio = ( s.entregas | 0 ) + 1; }

		}

	}

	_heading( t ) { return [ - Math.sin( t.yaw ), - Math.cos( t.yaw ) ]; }

	// Propone un encargo desde la posición actual. Devuelve false si no hay destino alcanzable.
	offer( t ) {

		if ( ! this.graph ) return false;
		const [ hx, hz ] = this._heading( t );
		for ( let attempt = 0; attempt < 6; attempt ++ ) {

			// si la red es chica, se acepta un destino más cercano
			const dMin = attempt < 3 ? 700 : 250, dMax = attempt < 3 ? 2200 : 900;
			const dest = pickDestination( this.graph, t.x, t.z, hx, hz, dMin, dMax, this.rng, Math.abs( t.v ) );
			if ( ! dest ) continue;
			const rt = route( this.graph, t.x, t.z, hx, hz, dest.node, Math.abs( t.v ) );
			if ( ! rt || rt.length < 150 ) continue;
			const c = CARGAS[ Math.floor( this.rng() * CARGAS.length ) % CARGAS.length ];
			const scale = this.spec.maxCargo / 25000;
			const mass = Math.round( ( c.masa[ 0 ] + this.rng() * ( c.masa[ 1 ] - c.masa[ 0 ] ) ) * scale * 2 ) / 2 * 1000;
			this.job = { folio: this.folio, cargo: c.nombre, mass, dest, route: rt, length: rt.length, pay: payFor( rt.length, mass, c.tarifa ), tarifa: c.tarifa };
			this.tracker = new RouteTracker( rt );
			this.state = 'offer';
			return true;

		}

		// sin destino alcanzable desde aquí: no queda encargo a medias y se vuelve a intentar más adelante
		this.state = 'none'; this.job = null; this.tracker = null; this.retryT = RETRY;
		return false;

	}

	/**
	 * Acepta el encargo ofrecido. Si el camión se movió desde la oferta, la ruta y el
	 * pago se calculan desde donde está ahora; si el destino quedó a menos de 150 m,
	 * el encargo se reemplaza por otro y se devuelve false.
	 */
	accept( t ) {

		if ( this.state !== 'offer' ) return false;
		const p0 = this.job.route.points[ 0 ];
		if ( Math.hypot( t.x - p0.x, t.z - p0.z ) > 30 ) {

			const [ hx, hz ] = this._heading( t );
			const rt = route( this.graph, t.x, t.z, hx, hz, this.job.dest.node, Math.abs( t.v ) );
			if ( ! rt || rt.length < 150 ) { this.offer( t ); return false; }
			this.job.route = rt; this.job.length = rt.length;
			this.job.pay = payFor( rt.length, this.job.mass, this.job.tarifa );
			this.tracker = new RouteTracker( rt );
			this.tracker.update( t.x, t.z, ...this._heading( t ) );

		}

		t.cargoMass = this.job.mass;
		this.job.damage0 = t.damage;
		this.job.time = 0;
		this.state = 'active';
		this.offRoute = 0;
		return true;

	}

	// Multa: se descuenta de la caja (que no baja de cero) y se guarda
	fine( amount ) {

		this.total = Math.max( 0, this.total - amount );
		if ( this.store ) this.store.set( { entregas: this.entregas, total: this.total } );
		return this.total;

	}

	// Daño a la carga desde que se aceptó el encargo (0..1)
	damage( t ) { return this.job && this.job.damage0 !== undefined ? Math.max( 0, t.damage - this.job.damage0 ) : 0; }

	currentPay( t ) {

		if ( ! this.job ) return 0;
		return Math.round( this.job.pay * ( 1 - 0.6 * Math.min( 1, this.damage( t ) ) ) / 100 ) * 100;

	}

	/**
	 * Avanza el estado. Devuelve un evento: null | 'delivered' | 'rerouted' | 'offer'
	 */
	update( t, dt ) {

		if ( this.state === 'done' ) {

			this.doneT -= dt;
			if ( this.doneT <= 0 ) { this.offer( t ); return this.state === 'offer' ? 'offer' : null; }
			return null;

		}

		if ( this.state === 'none' ) {

			// el camión pudo quedar en un tramo sin salida hacia el resto de la red: se reintenta cada cierto tiempo
			this.retryT -= dt;
			if ( this.retryT > 0 ) return null;
			this.offer( t );
			return this.state === 'offer' ? 'offer' : null;

		}

		if ( this.state !== 'active' && this.state !== 'offer' ) return null;
		this.tracker.update( t.x, t.z, ...this._heading( t ) );
		if ( this.state === 'offer' ) return null;

		const j = this.job;
		j.time += dt;
		const d = Math.hypot( t.x - j.dest.x, t.z - j.dest.z );
		if ( d < 16 && Math.abs( t.v ) < 0.6 ) {

			const pay = this.currentPay( t );
			// bono por puntualidad: 25 km/h de promedio más una holgura
			const par = j.length / 6.9 + 45;
			const bonus = j.time <= par ? Math.round( pay * 0.1 / 100 ) * 100 : 0;
			this.last = { ...j, paid: pay + bonus, bonus, damage: this.damage( t ) };
			this.total += pay + bonus; this.entregas ++; this.folio ++;
			if ( this.store ) this.store.set( { entregas: this.entregas, total: this.total } );
			t.cargoMass = 0;
			this.state = 'done'; this.doneT = 7;
			this.job = null; this.tracker = null;
			return 'delivered';

		}

		// fuera de la ruta por más de un par de segundos: se calcula de nuevo
		if ( this.tracker.offset > 45 ) {

			this.offRoute += dt;
			if ( this.offRoute > 2 ) {

				this.offRoute = 0;
				const [ hx, hz ] = this._heading( t );
				const rt = route( this.graph, t.x, t.z, hx, hz, j.dest.node, Math.abs( t.v ) );
				if ( rt ) { j.route = rt; this.tracker = new RouteTracker( rt ); this.tracker.update( t.x, t.z, ...this._heading( t ) ); return 'rerouted'; }

			}

		} else this.offRoute = 0;

		return null;

	}

	// Próxima indicación para el tablero: { dist (m, o null), texto, lado } o null
	guidance( t = null ) {

		if ( this.state !== 'active' || ! this.tracker ) return null;
		const m = this.tracker.next();
		const rem = this.tracker.remaining;
		// la única ruta posible parte hacia atrás: se avisa mientras el camión siga de espaldas a ella
		const rt = this.tracker.route;
		if ( t && rt.reverseStart && this.tracker.along < 25 && rt.points.length > 1 ) {

			const [ hx, hz ] = this._heading( t );
			if ( ( rt.points[ 1 ].x - rt.points[ 0 ].x ) * hx + ( rt.points[ 1 ].z - rt.points[ 0 ].z ) * hz < 0 ) return { dist: null, texto: 'Da la vuelta cuando puedas', lado: 'uturn' };

		}

		if ( ! m || m.at - this.tracker.along > rem ) return { dist: rem, texto: `Destino: ${ this.job.dest.label }`, lado: 'arrive' };
		const d = m.at - this.tracker.along;
		if ( d > rem - 25 && rem < 400 ) return { dist: rem, texto: `Destino: ${ this.job.dest.label }`, lado: 'arrive' };
		return { dist: d, texto: maneuverText( m ), lado: m.kind === 'roundabout' ? 'roundabout' : m.side };

	}

}
