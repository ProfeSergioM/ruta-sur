// Ruta Sur · semáforos y discos Pare
// --------------------------------------------------------------------------
// Los cruces salen de la red vial: donde se encuentran dos vías principales
// hay semáforos, y donde una calle menor llega a una principal hay un Pare.
// Cada semáforo reparte sus vías en dos grupos que se turnan el verde con un
// ciclo fijo, desfasado por cruce. El tráfico consulta el estado al llegar al
// nodo; el camión recibe multa si cruza la línea con luz roja. Sin Three.js:
// el mundo abierto pinta las lámparas según el mismo estado.

import { findCrossings, hashId, ROAD_WIDTH } from './openmap.js';
import { nearestSegment } from './osm.js';

export const CYCLE = { green: 14, amber: 3, allRed: 1 };   // segundos por fase
export const PERIOD = 2 * ( CYCLE.green + CYCLE.amber + CYCLE.allRed );
export const MAJOR = 8;                                      // ancho de calzada desde el que una vía es principal [m]
export const RED_LIGHT_FINE = 30000;

// Clave de un cruce por su posición, compartida con las lámparas del mapa abierto (a 20 cm)
export const crossingKey = ( x, z ) => `${ Math.round( x * 5 ) },${ Math.round( z * 5 ) }`;

// Grupo de una vía en un cruce con semáforo: la principal de id menor va en el 0; las demás en el 1
export function groupOfWay( majorIds, wayId ) {

	if ( majorIds.length === 0 ) return - 1;
	return wayId === majorIds[ 0 ] ? 0 : 1;

}

// Estado de un grupo en el ciclo: el grupo 0 parte en verde; el 1, media vuelta después
export function phaseState( time, group ) {

	let t = ( ( time % PERIOD ) + PERIOD ) % PERIOD;
	if ( group === 1 ) t = ( t + PERIOD / 2 ) % PERIOD;
	if ( t < CYCLE.green ) return 'green';
	if ( t < CYCLE.green + CYCLE.amber ) return 'amber';
	return 'red';

}

export class Signals {

	/** graph: la red vial del juego (osm.js) */
	constructor( graph ) {

		this.graph = graph;
		this.byKey = new Map();     // clave de posición -> cruce
		this.byNode = new Map();    // índice de nodo -> cruce
		this.crossings = [];
		this.lights = 0; this.stops = 0;
		if ( graph ) this._build();

	}

	_build() {

		const g = this.graph;
		// las vías del grafo como las ve el mapa abierto: puntos en planta y ancho de calzada
		const ways = g.ways.map( w => ( { id: w.id, width: ROAD_WIDTH[ w.highway ] || 5, pts: Array.from( w.nodes, n => ( { x: g.x[ n ], z: g.z[ n ] } ) ) } ) );
		for ( const c of findCrossings( ways ) ) {

			const majors = [ ...new Set( c.approaches.filter( a => a.width >= MAJOR ).map( a => ways[ a.wi ].id ) ) ].sort( ( a, b ) => a - b );
			const minors = [ ...new Set( c.approaches.filter( a => a.width < MAJOR ).map( a => ways[ a.wi ].id ) ) ];
			let kind = null;
			if ( majors.length >= 2 ) kind = 'light';
			else if ( majors.length === 1 && minors.length > 0 ) kind = 'stop';
			if ( ! kind ) continue;
			const widest = Math.max( ...c.approaches.map( a => a.width ) );
			const cr = { x: c.x, z: c.z, kind, majorIds: majors, minorIds: minors, offset: hashId( Math.round( c.x ) * 7 + Math.round( c.z ) * 13 ) * PERIOD, stopBack: widest / 2 + 1.5, key: crossingKey( c.x, c.z ) };
			this.crossings.push( cr );
			this.byKey.set( cr.key, cr );
			if ( kind === 'light' ) this.lights ++; else this.stops ++;

		}

		// nodos del grafo que caen en un cruce
		for ( let n = 0; n < g.count; n ++ ) { const cr = this.byKey.get( crossingKey( g.x[ n ], g.z[ n ] ) ); if ( cr ) this.byNode.set( n, cr ); }

	}

	atNode( n ) { return this.byNode.get( n ) || null; }
	atKey( key ) { return this.byKey.get( key ) || null; }

	// Estado del semáforo `cr` para la vía `wayId` en el instante `time`: 'green' | 'amber' | 'red'.
	// Una calle menor que llega a un cruce con semáforo va con el grupo 1.
	state( cr, wayId, time ) {

		if ( cr.kind !== 'light' ) return 'green';
		const group = groupOfWay( cr.majorIds, wayId );
		return phaseState( time + cr.offset, group < 0 ? 1 : group );

	}

	// Qué debe hacer un vehículo que llega por `wayId` al cruce: 'go' | 'stop' (Pare) | el color de la luz
	ruleFor( cr, wayId, time ) {

		if ( cr.kind === 'stop' ) return cr.minorIds.includes( wayId ) ? 'stop' : 'go';
		return this.state( cr, wayId, time );

	}

	// El cruce con semáforo más cercano dentro de `r` metros
	nearestLight( x, z, r = 30 ) {

		let best = null, bd = r;
		for ( const cr of this.crossings ) {

			if ( cr.kind !== 'light' ) continue;
			const d = Math.hypot( cr.x - x, cr.z - z );
			if ( d < bd ) { bd = d; best = cr; }

		}

		return best;

	}

	/**
	 * Vigila al camión: devuelve 'red' la vez que cruza la línea de detención de un semáforo
	 * en rojo por su vía (la más cercana), andando a más de 1 m/s; si no, null. t: estado del camión.
	 */
	watch( t, time ) {

		const cr = this.nearestLight( t.x, t.z, 40 );
		if ( ! cr ) { this._armed = null; return null; }
		const seg = nearestSegment( this.graph, t.x, t.z, 20 );
		if ( ! seg ) { this._armed = null; return null; }
		const wayId = seg.way.id;
		const fx = - Math.sin( t.yaw ), fz = - Math.cos( t.yaw );
		const along = ( cr.x - t.x ) * fx + ( cr.z - t.z ) * fz;      // del camión al centro del cruce, en el sentido de marcha
		const side = Math.abs( ( cr.x - t.x ) * fz - ( cr.z - t.z ) * fx );
		if ( along > cr.stopBack + 1 && side < 9 ) {

			// viene hacia el cruce: queda armado si todavía no lo pasó
			if ( ! this._armed || this._armed.cr !== cr ) this._armed = { cr, fired: false };
			return null;

		}

		if ( ! this._armed || this._armed.cr !== cr || this._armed.fired ) return null;
		// acaba de cruzar la línea de detención (el frente del camión está a stopBack del centro)
		if ( along <= cr.stopBack + 1 && along > - 8 && Math.abs( t.v ) > 1 && groupOfWay( cr.majorIds, wayId ) >= 0 ) {

			this._armed.fired = true;
			return this.state( cr, wayId, time ) === 'red' ? 'red' : null;

		}

		return null;

	}

}
