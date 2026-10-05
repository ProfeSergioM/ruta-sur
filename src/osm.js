// Ruta Sur · red vial de OpenStreetMap
// --------------------------------------------------------------------------
// La red vial sale de OpenStreetMap (API Overpass): con ella se elige dónde
// aparece el camión, se generan destinos alcanzables, se calcula la ruta y se
// dibuja el minimapa. También se piden aquí los edificios del mapa abierto.
// Este módulo no depende de Three.js.

// Clases de vía que un camión puede usar, con su ancho en el minimapa y el
// factor de costo para la ruta (un camión prefiere las vías principales).
export const ROAD_CLASSES = {
	motorway: { rank: 0, cost: 1.0, width: 5, speed: 100 },
	motorway_link: { rank: 0, cost: 1.1, width: 3, speed: 60 },
	trunk: { rank: 1, cost: 1.0, width: 5, speed: 80 },
	trunk_link: { rank: 1, cost: 1.1, width: 3, speed: 50 },
	primary: { rank: 2, cost: 1.0, width: 4.5, speed: 50 },
	primary_link: { rank: 2, cost: 1.1, width: 3, speed: 50 },
	secondary: { rank: 3, cost: 1.05, width: 4, speed: 50 },
	secondary_link: { rank: 3, cost: 1.15, width: 3, speed: 50 },
	tertiary: { rank: 4, cost: 1.15, width: 3.5, speed: 50 },
	tertiary_link: { rank: 4, cost: 1.25, width: 3, speed: 50 },
	unclassified: { rank: 5, cost: 1.3, width: 3, speed: 50 },
	residential: { rank: 6, cost: 1.5, width: 2.5, speed: 50 },
	living_street: { rank: 7, cost: 3.0, width: 2, speed: 20 },
};

// Instancias públicas listadas en la wiki de OpenStreetMap (Overpass API)
export const OVERPASS_ENDPOINTS = [
	'https://overpass-api.de/api/interpreter',
	'https://overpass.private.coffee/api/interpreter',
];

// La salida debe ser "body": es el nivel que incluye los identificadores de los
// nodos de cada vía, con los que se reconocen los cruces. Con "tags" la respuesta
// trae la geometría pero no los nodos ("Print only ids and tags for each element
// and not coordinates or members", wiki de Overpass QL).
export function overpassQuery( lat, lon, radius ) {

	const classes = Object.keys( ROAD_CLASSES ).join( '|' );
	return `[out:json][timeout:40];
way["highway"~"^(${ classes })$"]["area"!="yes"](around:${ Math.round( radius ) },${ lat.toFixed( 6 ) },${ lon.toFixed( 6 ) });
out body geom qt;`;

}

// Edificios: cada vía cerrada con etiqueta "building", con sus etiquetas y su geometría.
// Los edificios dibujados como relaciones (patios interiores, varias partes) quedan fuera.
export function buildingsQuery( lat, lon, radius ) {

	return `[out:json][timeout:40];
way["building"](around:${ Math.round( radius ) },${ lat.toFixed( 6 ) },${ lon.toFixed( 6 ) });
out tags geom qt;`;

}

// Altura aproximada de un edificio por tipo, cuando OSM no trae altura ni pisos [m]
const BUILDING_HEIGHTS = {
	house: 5.5, detached: 5.5, semidetached_house: 5.5, terrace: 5.5, residential: 7, bungalow: 4, hut: 3, cabin: 3.5,
	garage: 3, garages: 3, shed: 3, roof: 3.5, carport: 3, kiosk: 3.2, service: 3.5, greenhouse: 3.5,
	apartments: 15, dormitory: 12, hotel: 14, office: 12, commercial: 9, retail: 6.5, supermarket: 7, industrial: 8, warehouse: 8,
	church: 13, chapel: 8, cathedral: 22, mosque: 12, temple: 10, school: 7.5, kindergarten: 4.5, university: 10, college: 9,
	hospital: 12, public: 8, civic: 8, government: 10, stadium: 15, sports_hall: 10, train_station: 10, transportation: 7,
	yes: 6,
};

// Altura de un edificio según sus etiquetas: "height" en metros, o los pisos a 3,2 m
// más el zócalo, o un valor típico de su tipo. `jitter` (0..1) dispersa las alturas
// supuestas para que una cuadra no salga toda igual.
export function buildingHeight( tags = {}, jitter = 0.5 ) {

	const h = parseFloat( String( tags.height || '' ).replace( ',', '.' ) );
	if ( h > 0 ) return Math.min( 300, h );
	const levels = parseFloat( String( tags[ 'building:levels' ] || '' ).replace( ',', '.' ) );
	if ( levels > 0 ) return Math.min( 300, 0.5 + 3.2 * levels );
	const base = BUILDING_HEIGHTS[ tags.building ] || BUILDING_HEIGHTS.yes;
	return base * ( 0.85 + 0.3 * jitter );

}

// ¿Puede pasar un camión? Decide la etiqueta más específica que esté presente.
function truckAllowed( tags ) {

	for ( const k of [ 'hgv', 'motor_vehicle', 'vehicle', 'access' ] ) {

		const v = tags[ k ];
		if ( v === undefined ) continue;
		return ! ( v === 'no' || v === 'private' );

	}

	return true;

}

// Velocidad máxima en km/h. Los valores que no son un número ("CL:urban",
// "signals", "30;50") dejan la velocidad propia de la clase de vía.
function parseMaxspeed( v, fallback ) {

	if ( typeof v !== 'string' && typeof v !== 'number' ) return fallback;
	const m = String( v ).match( /^\s*(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?\s*$/i );
	if ( ! m ) return fallback;
	let n = parseFloat( m[ 1 ] );
	if ( m[ 2 ] && m[ 2 ].toLowerCase() === 'mph' ) n *= 1.609344;
	n = Math.round( n );
	return n >= 5 && n <= 150 ? n : fallback;

}

// Componente fuertemente conexa más grande del grafo dirigido: los nodos desde
// los que se puede ir a cualquier otro y volver. Fuera de ella quedan las vías de
// un sentido que salen del área consultada y los tramos sin retorno.
function mainComponent( n, adj, from, to ) {

	// orden de salida de un recorrido en profundidad (iterativo)
	const order = new Int32Array( n ), seen = new Uint8Array( n );
	const stackNode = [], stackIdx = [];
	let k = 0;
	for ( let s = 0; s < n; s ++ ) {

		if ( seen[ s ] ) continue;
		seen[ s ] = 1; stackNode.push( s ); stackIdx.push( 0 );
		while ( stackNode.length > 0 ) {

			const top = stackNode.length - 1, u = stackNode[ top ], i = stackIdx[ top ], out = adj[ u ];
			if ( i < out.length ) {

				stackIdx[ top ] = i + 1;
				const v = to[ out[ i ] ];
				if ( ! seen[ v ] ) { seen[ v ] = 1; stackNode.push( v ); stackIdx.push( 0 ); }

			} else { order[ k ++ ] = u; stackNode.pop(); stackIdx.pop(); }

		}

	}

	// recorrido del grafo inverso en orden de salida decreciente
	const radj = Array.from( { length: n }, () => [] );
	for ( let e = 0; e < to.length; e ++ ) radj[ to[ e ] ].push( from[ e ] );
	const comp = new Int32Array( n ).fill( - 1 ), size = [];
	for ( let i = n - 1; i >= 0; i -- ) {

		const s = order[ i ];
		if ( comp[ s ] >= 0 ) continue;
		const c = size.length, st = [ s ];
		let count = 0;
		comp[ s ] = c;
		while ( st.length > 0 ) {

			const u = st.pop(); count ++;
			for ( const v of radj[ u ] ) if ( comp[ v ] < 0 ) { comp[ v ] = c; st.push( v ); }

		}

		size.push( count );

	}

	let best = 0;
	for ( let i = 1; i < size.length; i ++ ) if ( size[ i ] > size[ best ] ) best = i;
	const main = new Uint8Array( n );
	for ( let i = 0; i < n; i ++ ) main[ i ] = comp[ i ] === best ? 1 : 0;
	return main;

}

const CELL = 120;
const key = ( cx, cz ) => cx * 73856093 ^ cz * 19349663;

/**
 * Construye el grafo a partir de la respuesta de Overpass ("out geom").
 * `geo` convierte latitud y longitud a coordenadas del mundo.
 */
export function buildGraph( osm, geo ) {

	const nodeIndex = new Map();
	const xs = [], zs = [];
	const ways = [];
	const tmp = { x: 0, y: 0, z: 0 };

	for ( const el of osm.elements || [] ) {

		if ( el.type !== 'way' || ! Array.isArray( el.geometry ) || el.geometry.length < 2 ) continue;
		const tags = el.tags || {};
		const cls = ROAD_CLASSES[ tags.highway ];
		if ( ! cls ) continue;
		// vías cerradas al tránsito general o a camiones
		if ( ! truckAllowed( tags ) ) continue;

		// Identidad de cada nodo: su id de OpenStreetMap. Si la respuesta no trae la
		// lista de nodos, dos puntos con las mismas coordenadas son el mismo nodo.
		const ids = Array.isArray( el.nodes ) && el.nodes.length === el.geometry.length ? el.nodes : null;
		const idx = [];
		for ( let i = 0; i < el.geometry.length; i ++ ) {

			const gpt = el.geometry[ i ];
			if ( ! gpt || ! Number.isFinite( gpt.lat ) || ! Number.isFinite( gpt.lon ) ) continue;
			const id = ids ? ids[ i ] : `${ gpt.lat.toFixed( 7 ) },${ gpt.lon.toFixed( 7 ) }`;
			let n = nodeIndex.get( id );
			if ( n === undefined ) {

				geo.toWorld( gpt.lat, gpt.lon, geo.h0, tmp );
				n = xs.length;
				xs.push( tmp.x ); zs.push( tmp.z );
				nodeIndex.set( id, n );

			}

			if ( idx.length === 0 || idx[ idx.length - 1 ] !== n ) idx.push( n );

		}

		if ( idx.length < 2 ) continue;

		let oneway = 0;
		const ow = tags.oneway;
		if ( ow === 'yes' || ow === 'true' || ow === '1' ) oneway = 1;
		else if ( ow === '-1' || ow === 'reverse' ) oneway = - 1;
		else if ( ow !== 'no' && ( tags.junction === 'roundabout' || tags.highway === 'motorway' || tags.highway === 'motorway_link' ) ) oneway = 1;

		ways.push( {
			id: el.id,
			name: tags.name || tags.ref || '',
			highway: tags.highway,
			rank: cls.rank, costFactor: cls.cost, width: cls.width,
			oneway,
			maxspeed: parseMaxspeed( tags.maxspeed, cls.speed ),
			roundabout: tags.junction === 'roundabout',
			nodes: idx,
		} );

	}

	const n = xs.length;
	const x = Float64Array.from( xs ), z = Float64Array.from( zs );

	// aristas dirigidas. Cada una guarda su dirección y, si la vía tiene dos
	// sentidos, la arista contraria: con eso la ruta distingue un giro de una vuelta en U.
	const from = [], to = [], len = [], cost = [], wayOf = [], rev = [], ux = [], uz = [];
	const adj = Array.from( { length: n }, () => [] );
	const degree = new Uint8Array( n );
	const grid = new Map();

	ways.forEach( ( w, wi ) => {

		w.fwd = new Int32Array( w.nodes.length - 1 ).fill( - 1 ); // arista del tramo i en el sentido de los nodos
		w.bwd = new Int32Array( w.nodes.length - 1 ).fill( - 1 ); // arista del tramo i en el sentido contrario
		for ( let i = 0; i < w.nodes.length - 1; i ++ ) {

			const a = w.nodes[ i ], b = w.nodes[ i + 1 ];
			const d = Math.hypot( x[ b ] - x[ a ], z[ b ] - z[ a ] );
			const dx = d > 0 ? ( x[ b ] - x[ a ] ) / d : 0, dz = d > 0 ? ( z[ b ] - z[ a ] ) / d : 0;
			let ef = - 1, eb = - 1;
			if ( w.oneway >= 0 ) { ef = from.length; adj[ a ].push( ef ); from.push( a ); to.push( b ); len.push( d ); cost.push( d * w.costFactor ); wayOf.push( wi ); rev.push( - 1 ); ux.push( dx ); uz.push( dz ); }
			if ( w.oneway <= 0 ) { eb = from.length; adj[ b ].push( eb ); from.push( b ); to.push( a ); len.push( d ); cost.push( d * w.costFactor ); wayOf.push( wi ); rev.push( - 1 ); ux.push( - dx ); uz.push( - dz ); }
			if ( ef >= 0 && eb >= 0 ) { rev[ ef ] = eb; rev[ eb ] = ef; }
			w.fwd[ i ] = ef; w.bwd[ i ] = eb;
			if ( degree[ a ] < 255 ) degree[ a ] ++;
			if ( degree[ b ] < 255 ) degree[ b ] ++;

			// índice espacial del tramo
			const cx0 = Math.floor( Math.min( x[ a ], x[ b ] ) / CELL ), cx1 = Math.floor( Math.max( x[ a ], x[ b ] ) / CELL );
			const cz0 = Math.floor( Math.min( z[ a ], z[ b ] ) / CELL ), cz1 = Math.floor( Math.max( z[ a ], z[ b ] ) / CELL );
			for ( let cx = cx0; cx <= cx1; cx ++ ) for ( let cz = cz0; cz <= cz1; cz ++ ) {

				const k = key( cx, cz );
				let list = grid.get( k );
				if ( ! list ) grid.set( k, list = [] );
				list.push( wi, i );

			}

		}

	} );

	return {
		count: n, x, z, ways, adj, degree,
		main: mainComponent( n, adj, from, to ),
		from: Int32Array.from( from ), to: Int32Array.from( to ),
		len: Float64Array.from( len ), cost: Float64Array.from( cost ), wayOf: Int32Array.from( wayOf ),
		rev: Int32Array.from( rev ), ux: Float64Array.from( ux ), uz: Float64Array.from( uz ),
		grid,
	};

}

// Recorre los tramos dentro de un rectángulo. cb( way, i, ax, az, bx, bz )
export function forSegmentsIn( g, x0, z0, x1, z1, cb ) {

	const seen = _seen; seen.clear();
	const cx0 = Math.floor( x0 / CELL ), cx1 = Math.floor( x1 / CELL ), cz0 = Math.floor( z0 / CELL ), cz1 = Math.floor( z1 / CELL );
	for ( let cx = cx0; cx <= cx1; cx ++ ) for ( let cz = cz0; cz <= cz1; cz ++ ) {

		const list = g.grid.get( key( cx, cz ) );
		if ( ! list ) continue;
		for ( let k = 0; k < list.length; k += 2 ) {

			const wi = list[ k ], i = list[ k + 1 ];
			const id = wi * 65536 + i;
			if ( seen.has( id ) ) continue;
			seen.add( id );
			const w = g.ways[ wi ], a = w.nodes[ i ], b = w.nodes[ i + 1 ];
			cb( w, i, g.x[ a ], g.z[ a ], g.x[ b ], g.z[ b ], a, b );

		}

	}

}

const _seen = new Set();

// Tramo más cercano a un punto. Devuelve null si no hay ninguno dentro de maxDist.
export function nearestSegment( g, px, pz, maxDist = 120, filter = null ) {

	let best = null, bestD = maxDist;
	forSegmentsIn( g, px - maxDist, pz - maxDist, px + maxDist, pz + maxDist, ( w, i, ax, az, bx, bz, a, b ) => {

		if ( filter && ! filter( w, a, b ) ) return;
		const dx = bx - ax, dz = bz - az;
		const l2 = dx * dx + dz * dz;
		if ( l2 < 1e-9 ) return;
		let t = ( ( px - ax ) * dx + ( pz - az ) * dz ) / l2;
		t = t < 0 ? 0 : ( t > 1 ? 1 : t );
		const qx = ax + dx * t, qz = az + dz * t;
		const d = Math.hypot( px - qx, pz - qz );
		if ( d < bestD ) { bestD = d; best = { way: w, seg: i, t, x: qx, z: qz, dist: d, a, b, dx, dz }; }

	} );
	return best;

}

// --- cola de prioridad mínima -------------------------------------------------
class Heap {

	constructor() { this.k = []; this.v = []; }
	get size() { return this.k.length; }
	push( key, value ) {

		const k = this.k, v = this.v;
		let i = k.length;
		k.push( key ); v.push( value );
		while ( i > 0 ) {

			const p = ( i - 1 ) >> 1;
			if ( k[ p ] <= key ) break;
			k[ i ] = k[ p ]; v[ i ] = v[ p ];
			i = p;

		}

		k[ i ] = key; v[ i ] = value;

	}

	pop() {

		const k = this.k, v = this.v;
		const top = v[ 0 ], lastK = k.pop(), lastV = v.pop();
		const n = k.length;
		if ( n > 0 ) {

			let i = 0;
			for ( ;; ) {

				let c = 2 * i + 1;
				if ( c >= n ) break;
				if ( c + 1 < n && k[ c + 1 ] < k[ c ] ) c ++;
				if ( k[ c ] >= lastK ) break;
				k[ i ] = k[ c ]; v[ i ] = v[ c ];
				i = c;

			}

			k[ i ] = lastK; v[ i ] = lastV;

		}

		return top;

	}

}

// --- costos de giro -----------------------------------------------------------
// Un camión articulado de 16,5 m no gira en U en una calle. La ruta se busca
// sobre las aristas (el estado es "llegué a este nodo por esta arista"), y así
// puede cobrar cada giro según su ángulo. Los valores están en metros de
// recorrido equivalente.
export const TURN_COST = {
	uturn: 3000,    // invertir la marcha en plena calle: solo si no hay otra forma de llegar
	deadEnd: 400,   // volver desde un fondo de saco
	hairpin: 800,   // giro de más de 150° en una intersección
	turn: 12,       // giro de más de 45°: a igual distancia, la ruta con menos giros
};

function turnCost( g, e, e2 ) {

	const u = g.to[ e ];
	if ( e2 === g.rev[ e ] ) return g.adj[ u ].length <= 1 ? TURN_COST.deadEnd : TURN_COST.uturn;
	if ( g.degree[ u ] < 3 ) return 0;                       // una curva de la misma vía es parte del camino
	const c = g.ux[ e ] * g.ux[ e2 ] + g.uz[ e ] * g.uz[ e2 ];
	if ( c < - 0.866 ) return TURN_COST.hairpin;
	if ( c < 0.707 ) return TURN_COST.turn;
	return 0;

}

/**
 * Dijkstra sobre las aristas dirigidas. starts: [ { edge, cost } ], donde `cost`
 * es el costo de llegar al final de esa arista. Si se indica `goal` (un nodo),
 * se detiene al alcanzarlo.
 * Devuelve { dist, prev } por arista y { nodeDist, nodeEdge } por nodo.
 */
export function searchEdges( g, starts, goal = - 1, maxCost = Infinity ) {

	const E = g.from.length;
	const dist = new Float64Array( E ).fill( Infinity );
	const prev = new Int32Array( E ).fill( - 1 );
	const nodeDist = new Float64Array( g.count ).fill( Infinity );
	const nodeEdge = new Int32Array( g.count ).fill( - 1 );
	const seedVia = new Map();   // arista de partida -> tramos ya recorridos para llegar a ella (ver startEdges)
	const heap = new Heap();
	for ( const s of starts ) if ( s.cost < dist[ s.edge ] ) { dist[ s.edge ] = s.cost; seedVia.set( s.edge, s.chain ? s.chain.slice( 0, - 1 ) : [] ); heap.push( s.cost, s.edge ); }

	while ( heap.size > 0 ) {

		const d = heap.k[ 0 ];
		const e = heap.pop();
		if ( d > dist[ e ] ) continue;
		if ( d > maxCost ) break;
		const u = g.to[ e ];
		if ( d < nodeDist[ u ] ) { nodeDist[ u ] = d; nodeEdge[ u ] = e; }
		if ( u === goal ) break;
		const out = g.adj[ u ];
		for ( let i = 0; i < out.length; i ++ ) {

			const e2 = out[ i ];
			const nd = d + turnCost( g, e, e2 ) + g.cost[ e2 ];
			if ( nd < dist[ e2 ] ) { dist[ e2 ] = nd; prev[ e2 ] = e; heap.push( nd, e2 ); }

		}

	}

	return { dist, prev, nodeDist, nodeEdge, seedVia };

}

/**
 * Tramo sobre el que va un vehículo en (px, pz) con rumbo (hx, hz).
 * En una intersección el tramo más cercano suele ser el de la calle que se
 * cruza, así que la distancia sola no alcanza: se premia el tramo paralelo al
 * rumbo y, en una vía de un sentido, el que coincide con el sentido de tránsito.
 */
export function matchSegment( g, px, pz, hx = 0, hz = 0, maxDist = 200 ) {

	const R = 30, WEIGHT = 12;
	let best = null, bestScore = Infinity;
	forSegmentsIn( g, px - R, pz - R, px + R, pz + R, ( w, i, ax, az, bx, bz, a, b ) => {

		const dx = bx - ax, dz = bz - az;
		const l2 = dx * dx + dz * dz;
		if ( l2 < 1e-9 ) return;
		let t = ( ( px - ax ) * dx + ( pz - az ) * dz ) / l2;
		t = t < 0 ? 0 : ( t > 1 ? 1 : t );
		const qx = ax + dx * t, qz = az + dz * t;
		const d = Math.hypot( px - qx, pz - qz );
		if ( d > R ) return;
		const cos = ( dx * hx + dz * hz ) / Math.sqrt( l2 );
		const align = w.oneway === 0 ? Math.abs( cos ) : cos * w.oneway;
		const score = d + WEIGHT * ( 1 - align );
		if ( score < bestScore ) { bestScore = score; best = { way: w, seg: i, t, x: qx, z: qz, dist: d, a, b, dx, dz }; }

	} );
	return best || nearestSegment( g, px, pz, maxDist );

}

// Distancia mínima al cruce para que la ruta pueda pedir un giro en él: 8 m
// (con menos, la cabina ya está dentro de la intersección) más 2 s de marcha
// para frenar y abrirse.
export const turnReach = speed => 8 + 2 * speed;

/**
 * Estados de partida para un vehículo en (px, pz) con rumbo (hx, hz) y rapidez
 * `speed` [m/s]. Se prefiere seguir en el sentido en que ya mira el camión.
 *
 * Un giro necesita distancia. Si hay un cruce más cerca que turnReach( speed ), la
 * ruta lo pasa derecho y recién puede doblar después. En los datos reales cada
 * cruce viene precedido de nodos intermedios (pasos de peatones, líneas de
 * detención) a pocos metros, así que no basta mirar el final del tramo actual:
 * se avanza por la calle, tramo a tramo, hasta completar esa distancia.
 *
 * Cada estado es { edge, cost, chain, c0, reversed }: `chain` son las aristas ya
 * decididas desde la posición del camión (la última es `edge`) y `c0` el costo de
 * llegar al final de la primera.
 */
export function startEdges( g, px, pz, hx, hz, speed = 0, reach = turnReach( speed ) ) {

	const s = matchSegment( g, px, pz, hx, hz );
	if ( ! s ) return null;
	const L = Math.hypot( s.dx, s.dz ) || 1;
	const along = ( s.dx * hx + s.dz * hz ) / L;       // > 0: el camión mira de a hacia b
	const dA = s.t * L, dB = ( 1 - s.t ) * L;
	const w = s.way, f = w.costFactor;
	const ef = w.fwd[ s.seg ], eb = w.bwd[ s.seg ];
	const out = [];
	const add = ( e0, d0, reversed ) => {

		// partir contra el rumbo es una vuelta en U
		const c0 = d0 * f + ( reversed ? TURN_COST.uturn : 0 );
		const seed = ( chain, cost ) => out.push( { edge: chain[ chain.length - 1 ], cost, chain, c0, reversed } );
		if ( reversed ) return seed( [ e0 ], c0 );
		// se avanza por la calle hasta completar la distancia mínima, pasando derecho los cruces
		const walk = ( chain, d, cost ) => {

			const e = chain[ chain.length - 1 ], u = g.to[ e ];
			if ( d >= reach || chain.length > 48 ) return seed( chain, cost );
			const outs = g.adj[ u ].filter( x => x !== g.rev[ e ] );
			if ( g.degree[ u ] >= 3 ) {

				const ahead = outs.filter( e2 => g.ux[ e ] * g.ux[ e2 ] + g.uz[ e ] * g.uz[ e2 ] > 0.707 );
				if ( ahead.length === 0 ) return seed( chain, cost );   // la calle termina aquí: no queda más que doblar
				for ( const e2 of ahead ) walk( [ ...chain, e2 ], d + g.len[ e2 ], cost + g.cost[ e2 ] );

			} else {

				if ( outs.length !== 1 ) return seed( chain, cost );    // fondo de saco
				walk( [ ...chain, outs[ 0 ] ], d + g.len[ outs[ 0 ] ], cost + g.cost[ outs[ 0 ] ] );

			}

		};

		walk( [ e0 ], d0, c0 );

	};

	// con el camión atravesado (|along| chico) ningún sentido cuenta como vuelta en U
	if ( ef >= 0 ) add( ef, dB, along < - 0.2 );
	if ( eb >= 0 ) add( eb, dA, along > 0.2 );
	return { starts: out, seg: s };

}

/**
 * Ruta entre la posición del camión y un nodo de destino.
 * Devuelve { points: [ {x,z} ], cum, nodes, edges, length, maneuvers, reverseStart, earlyTurn } o null.
 * `earlyTurn` indica que la única ruta posible dobla en un cruce más cercano que la distancia mínima.
 */
export function route( g, px, pz, hx, hz, goal, speed = 0 ) {

	let st = startEdges( g, px, pz, hx, hz, speed );
	if ( ! st ) return null;
	let res = searchEdges( g, st.starts, goal );
	let earlyTurn = false;
	if ( res.nodeEdge[ goal ] < 0 && ! st.starts.some( s => s.chain.some( e => g.to[ e ] === goal ) ) ) {

		// Pasar derecho el cruce cercano puede sacar al camión de la red (una calle de un
		// sentido que no vuelve). Si así no hay ruta, se acepta doblar en ese cruce.
		st = startEdges( g, px, pz, hx, hz, speed, 0 );
		res = searchEdges( g, st.starts, goal );
		earlyTurn = true;

	}


	// el destino puede estar en el tramo que el camión recorre derecho antes de poder doblar: llegar a él no exige girar
	let direct = null;
	for ( const s of st.starts ) {

		let cost = s.c0;
		for ( let k = 0; k < s.chain.length - 1; k ++ ) {

			if ( k > 0 ) cost += g.cost[ s.chain[ k ] ];
			if ( g.to[ s.chain[ k ] ] === goal && ( ! direct || cost < direct.cost ) ) direct = { cost, edges: s.chain.slice( 0, k + 1 ) };

		}

	}

	let edges = [];
	let e = res.nodeEdge[ goal ];
	if ( direct && ! ( e >= 0 && res.nodeDist[ goal ] <= direct.cost ) ) edges = direct.edges;
	else {

		if ( e < 0 ) return null;
		while ( e >= 0 ) {

			edges.push( e );
			const p = res.prev[ e ];
			if ( p < 0 ) { const via = res.seedVia.get( e ) || []; for ( let k = via.length - 1; k >= 0; k -- ) edges.push( via[ k ] ); }
			e = p;

		}

		edges.reverse();

	}

	const nodes = edges.map( k => g.to[ k ] );
	const first = st.starts.find( s => s.chain[ 0 ] === edges[ 0 ] );

	// distancia recorrida al llegar a cada nodo de la ruta
	const at = [ Math.hypot( g.x[ nodes[ 0 ] ] - st.seg.x, g.z[ nodes[ 0 ] ] - st.seg.z ) ];
	for ( let i = 1; i < edges.length; i ++ ) at.push( at[ i - 1 ] + g.len[ edges[ i ] ] );

	// polilínea de la ruta, sin puntos repetidos
	const points = [ { x: st.seg.x, z: st.seg.z } ], cum = [ 0 ];
	for ( let i = 0; i < nodes.length; i ++ ) {

		const p = { x: g.x[ nodes[ i ] ], z: g.z[ nodes[ i ] ] }, q = points[ points.length - 1 ];
		const d = Math.hypot( p.x - q.x, p.z - q.z );
		if ( d < 0.01 && i < nodes.length - 1 ) continue;
		points.push( p ); cum.push( cum[ cum.length - 1 ] + d );

	}

	// maniobras: cambios de rumbo en las intersecciones
	const maneuvers = [];
	const ring = e => g.ways[ g.wayOf[ e ] ].roundabout;
	for ( let i = 0; i < edges.length - 1; i ++ ) {

		const n = nodes[ i ], e1 = edges[ i ], e2 = edges[ i + 1 ];
		const wayOut = g.ways[ g.wayOf[ e2 ] ];

		if ( ring( e2 ) ) {

			if ( ring( e1 ) ) continue; // ya dentro del anillo: la indicación se dio al entrar
			// Entrada a una rotonda: una sola indicación con el número de la salida.
			// Se cuentan los nodos del anillo desde los que sale una vía.
			let exits = 0, j = i + 1;
			for ( ; j < edges.length && ring( edges[ j ] ); j ++ ) if ( g.adj[ nodes[ j ] ].some( e => ! ring( e ) ) ) exits ++;
			const left = j < edges.length;                      // la ruta sale del anillo por edges[ j ]
			const exitName = left ? g.ways[ g.wayOf[ edges[ j ] ] ].name : '';
			maneuvers.push( { at: at[ i ], node: n, side: 'right', kind: 'roundabout', angle: 0, exit: left ? exits : 0, name: exitName, roundabout: true } );
			if ( left ) maneuvers.push( { at: at[ j - 1 ], node: nodes[ j - 1 ], side: 'right', kind: 'exit', angle: 0, exit: exits, name: exitName, roundabout: false } );
			i = j - 1;
			continue;

		}

		if ( ring( e1 ) ) {

			// la ruta partió dentro de una rotonda y aquí la deja
			maneuvers.push( { at: at[ i ], node: n, side: 'right', kind: 'exit', angle: 0, exit: 0, name: wayOut.name, roundabout: false } );
			continue;

		}

		const back = e2 === g.rev[ e1 ];
		if ( g.degree[ n ] < 3 && ! back ) continue;
		// con +X al oeste, un giro a la izquierda da producto cruz negativo
		const cross = g.ux[ e1 ] * g.uz[ e2 ] - g.uz[ e1 ] * g.ux[ e2 ], dot = g.ux[ e1 ] * g.ux[ e2 ] + g.uz[ e1 ] * g.uz[ e2 ];
		const angle = Math.atan2( - cross, dot ); // positivo = izquierda
		const deg = Math.abs( angle ) * 180 / Math.PI;
		if ( deg < 28 ) continue;
		// Una pista de viraje que desemboca en la calle siguiente no es una decisión:
		// hay una sola salida y el cambio de rumbo es suave. No se anuncia.
		if ( ! back && deg < 60 && g.adj[ n ].filter( e => e !== g.rev[ e1 ] ).length <= 1 ) continue;
		maneuvers.push( {
			at: at[ i ],
			node: n,
			side: angle > 0 ? 'left' : 'right',
			kind: back || deg > 150 ? 'uturn' : ( deg > 110 ? 'sharp' : ( deg < 50 ? 'slight' : 'turn' ) ),
			angle,
			name: wayOut.name,
			roundabout: false,
		} );

	}

	return { points, cum, nodes, edges, length: cum[ cum.length - 1 ], maneuvers, goal, reverseStart: !! ( first && first.reversed ), earlyTurn };

}

// Sigue el avance del camión a lo largo de una ruta.
// Una ruta puede pasar dos veces por el mismo punto: rodea la manzana y vuelve a
// cruzar su partida, o entra a un fondo de saco y regresa. El punto más cercano
// de la polilínea no basta para saber en cuál de las dos pasadas va el camión.
// El seguimiento usa lo que sí se sabe: desde la última posición, el avance
// sobre la ruta no pudo cambiar más que la distancia recorrida.
export class RouteTracker {

	constructor( rt ) {

		this.route = rt;
		this.seg = 0;
		this.along = 0;      // distancia recorrida sobre la ruta [m]
		this.offset = 0;     // distancia lateral a la ruta [m]
		this._x = null; this._z = null; this._hx = 0; this._hz = 0;

	}

	/**
	 * (px, pz): posición del camión. (hx, hz): su rumbo, si se conoce; sin él se usa
	 * la dirección del último desplazamiento.
	 */
	update( px, pz, hx = 0, hz = 0 ) {

		const { points, cum } = this.route;
		const moved = this._x === null ? 0 : Math.hypot( px - this._x, pz - this._z );
		if ( hx === 0 && hz === 0 ) {

			if ( moved > 0.05 ) { this._hx = ( px - this._x ) / moved; this._hz = ( pz - this._z ) / moved; }
			hx = this._hx; hz = this._hz;

		}

		this._x = px; this._z = pz;
		const lo = this.along - moved - TRACK_BACK, hi = this.along + moved + TRACK_AHEAD;

		let best = Infinity, bestScore = Infinity, bestSeg = this.seg, bestAlong = this.along, bestGap = Infinity;
		for ( let i = 0; i < points.length - 1; i ++ ) {

			if ( cum[ i + 1 ] < lo ) continue;
			if ( cum[ i ] > hi ) break;
			const a = points[ i ], b = points[ i + 1 ];
			const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz, L = cum[ i + 1 ] - cum[ i ];
			if ( l2 < 1e-9 ) continue;
			// el tramo se recorta a la ventana de avance posible
			const t0 = Math.max( 0, ( lo - cum[ i ] ) / L ), t1 = Math.min( 1, ( hi - cum[ i ] ) / L );
			let t = ( ( px - a.x ) * dx + ( pz - a.z ) * dz ) / l2;
			t = t < t0 ? t0 : ( t > t1 ? t1 : t );
			const d = Math.hypot( px - ( a.x + dx * t ), pz - ( a.z + dz * t ) );
			const al = cum[ i ] + L * t;
			// Ida y vuelta por la misma calle: los dos tramos quedan a la misma distancia.
			// Decide el rumbo del camión; un tramo que apunta en contra pesa como unos metros más.
			const score = d + ( dx * hx + dz * hz < 0 ? TRACK_AGAINST : 0 );
			const gap = Math.abs( al - this.along );
			if ( score < bestScore - 1e-6 || ( score < bestScore + 1e-6 && ( gap < bestGap - 1e-6 || ( gap < bestGap + 1e-6 && al > bestAlong ) ) ) ) { best = d; bestScore = score; bestSeg = i; bestAlong = al; bestGap = gap; }

		}

		// Lejos de la ventana, el camión pudo tomar un atajo y volver a la ruta más
		// adelante: se acepta un punto posterior si el camión está claramente sobre él
		// y va en el sentido de ese tramo.
		if ( best > TRACK_LOST ) {

			let near = TRACK_REJOIN;
			for ( let i = 0; i < points.length - 1; i ++ ) {

				if ( cum[ i + 1 ] <= this.along ) continue;
				const a = points[ i ], b = points[ i + 1 ];
				const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
				if ( l2 < 1e-9 ) continue;
				if ( ( hx !== 0 || hz !== 0 ) && dx * hx + dz * hz < 0.5 * Math.sqrt( l2 ) ) continue;
				let t = ( ( px - a.x ) * dx + ( pz - a.z ) * dz ) / l2;
				t = t < 0 ? 0 : ( t > 1 ? 1 : t );
				const al = cum[ i ] + ( cum[ i + 1 ] - cum[ i ] ) * t;
				if ( al <= this.along ) continue;
				const d = Math.hypot( px - ( a.x + dx * t ), pz - ( a.z + dz * t ) );
				if ( d < near ) { near = d; best = d; bestSeg = i; bestAlong = al; }

			}

		}

		this.seg = bestSeg;
		this.offset = best;
		this.along = Math.min( Math.max( bestAlong, 0 ), this.route.length );
		return this;

	}

	get remaining() { return Math.max( 0, this.route.length - this.along ); }

	// Próxima maniobra por delante, o null
	next() {

		for ( const m of this.route.maneuvers ) if ( m.at > this.along + 4 ) return m;
		return null;

	}

}

// Ventana del seguimiento [m]: holgura hacia atrás y hacia adelante sobre lo recorrido,
// distancia a la ruta desde la que se busca un reingreso y cercanía que lo confirma.
const TRACK_BACK = 12, TRACK_AHEAD = 20, TRACK_LOST = 25, TRACK_REJOIN = 8, TRACK_AGAINST = 6;

/**
 * Elige un destino de entrega: un nodo alcanzable, a una distancia de ruta
 * dentro de [ dMin, dMax ], de preferencia una esquina con nombre.
 * rng: función que devuelve un número en [0, 1).
 */
export function pickDestination( g, px, pz, hx, hz, dMin, dMax, rng = Math.random, speed = 0 ) {

	const st = startEdges( g, px, pz, hx, hz, speed );
	if ( ! st ) return null;
	const dist = searchEdges( g, st.starts, - 1, dMax * 1.6 ).nodeDist;

	// nombres de las vías que pasan por cada nodo
	const corners = [], plain = [];
	const namesAt = new Map();
	g.ways.forEach( w => {

		if ( ! w.name || w.rank > 6 ) return;
		for ( const n of w.nodes ) {

			if ( ! g.main[ n ] ) continue; // desde un tramo sin retorno no habría encargo siguiente

			let s = namesAt.get( n );
			if ( ! s ) namesAt.set( n, s = new Set() );
			s.add( w.name );

		}

	} );

	for ( const [ n, names ] of namesAt ) {

		// la distancia de ruta pondera el tipo de vía; se acota con la distancia real aproximada
		const d = dist[ n ];
		if ( ! ( d >= dMin && d <= dMax * 1.5 ) ) continue;
		const straight = Math.hypot( g.x[ n ] - px, g.z[ n ] - pz );
		if ( straight < dMin * 0.5 || straight > dMax ) continue;
		( names.size >= 2 && g.degree[ n ] >= 3 ? corners : plain ).push( n );

	}

	const pool = corners.length >= 3 ? corners : corners.concat( plain );
	if ( pool.length === 0 ) return null;
	const node = pool[ Math.floor( rng() * pool.length ) % pool.length ];
	const names = [ ...namesAt.get( node ) ];
	return { node, x: g.x[ node ], z: g.z[ node ], label: names.length >= 2 ? `${ names[ 0 ] } con ${ names[ 1 ] }` : names[ 0 ] };

}

// Punto de aparición: sobre la vía más cercana a (px, pz), a media cuadra, con
// el rumbo de la calle y por la pista derecha. Partir en plena intersección
// deja al camión cruzado respecto de la mitad de las rutas posibles.
// yawHint: rumbo preferido cuando la calle tiene dos sentidos.
export function spawnPoint( g, px, pz, yawHint = null ) {

	const s = nearestSegment( g, px, pz, 400, ( w, a, b ) => w.rank <= 6 && g.main[ a ] && g.main[ b ] )
		|| nearestSegment( g, px, pz, 400, w => w.rank <= 6 ) || nearestSegment( g, px, pz, 400 );
	if ( ! s ) return null;
	const w = s.way, n = w.nodes;

	// distancia a lo largo de la vía y posición de sus cruces
	const cum = [ 0 ];
	for ( let i = 1; i < n.length; i ++ ) cum.push( cum[ i - 1 ] + Math.hypot( g.x[ n[ i ] ] - g.x[ n[ i - 1 ] ], g.z[ n[ i ] ] - g.z[ n[ i - 1 ] ] ) );
	const s0 = cum[ s.seg ] + ( cum[ s.seg + 1 ] - cum[ s.seg ] ) * s.t;
	const J = [];
	for ( let i = 0; i < n.length; i ++ ) if ( i === 0 || i === n.length - 1 || g.degree[ n[ i ] ] >= 3 ) J.push( cum[ i ] );
	// cuadra que contiene al punto; si cae justo en un cruce, la más larga de las dos vecinas
	let k = 0;
	while ( k < J.length - 2 && J[ k + 1 ] < s0 - 1e-6 ) k ++;
	if ( k < J.length - 2 && Math.abs( J[ k + 1 ] - s0 ) <= 1e-6 && J[ k + 2 ] - J[ k + 1 ] > J[ k + 1 ] - J[ k ] ) k ++;
	const margin = Math.min( 20, ( J[ k + 1 ] - J[ k ] ) / 2 );
	const s1 = Math.min( Math.max( s0, J[ k ] + margin ), J[ k + 1 ] - margin );
	let i = 0;
	while ( i < n.length - 2 && cum[ i + 1 ] < s1 ) i ++;
	const L = cum[ i + 1 ] - cum[ i ] || 1, t = ( s1 - cum[ i ] ) / L;
	const ax = g.x[ n[ i ] ], az = g.z[ n[ i ] ], bx = g.x[ n[ i + 1 ] ], bz = g.z[ n[ i + 1 ] ];
	const qx = ax + ( bx - ax ) * t, qz = az + ( bz - az ) * t;

	let dx = ( bx - ax ) / L, dz = ( bz - az ) / L;
	if ( w.oneway < 0 ) { dx = - dx; dz = - dz; }
	else if ( w.oneway === 0 && yawHint !== null && dx * - Math.sin( yawHint ) + dz * - Math.cos( yawHint ) < 0 ) { dx = - dx; dz = - dz; }
	// en una calle de dos sentidos se circula por la derecha (con +X al oeste, la derecha del avance es (-dz, dx))
	const off = w.oneway === 0 ? ( w.rank <= 4 ? 1.75 : 1.3 ) : 0;
	return { x: qx - dz * off, z: qz + dx * off, yaw: Math.atan2( - dx, - dz ), way: w };

}

// Texto de una maniobra para el tablero
export function maneuverText( m ) {

	if ( ! m ) return '';
	if ( m.kind === 'roundabout' ) return m.exit > 0 ? `En la rotonda, toma la ${ m.exit }.ª salida${ m.name ? ` por ${ m.name }` : '' }` : 'Entra a la rotonda';
	if ( m.kind === 'exit' ) return `Sal de la rotonda${ m.name ? ` por ${ m.name }` : '' }`;
	const side = m.side === 'left' ? 'a la izquierda' : 'a la derecha';
	let verb;
	if ( m.kind === 'uturn' ) verb = 'Da la vuelta';
	else if ( m.kind === 'slight' ) verb = `Mantente ${ side }`;
	else if ( m.kind === 'sharp' ) verb = `Gira cerrado ${ side }`;
	else verb = `Gira ${ side }`;
	return m.name ? `${ verb } por ${ m.name }` : verb;

}
