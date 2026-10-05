// Ruta Sur · ciudad de pruebas
// --------------------------------------------------------------------------
// Una ciudad procedural que imita los defectos de una malla fotogramétrica a
// nivel de calle: calzada con ruido, soleras, autos estacionados convertidos
// en bultos, árboles como masas y una pasarela sobre la avenida. Sirve para
// conocer los controles sin conexión y para probar el juego sin pedir nada a la red.
//
// El módulo es puro (no depende de Three.js): entrega arreglos de vértices,
// colores e índices, y la red vial en el mismo formato que responde Overpass.
// Ejes del mundo: +X oeste, +Y arriba, +Z norte.

export const CITY = {
	pitch: 110,        // distancia entre ejes de calles [m]
	blocks: 6,         // manzanas por lado
	half: 7,           // semiancho de una calle, veredas incluidas [m]
	halfAve: 11,       // semiancho de una avenida [m]
	sidewalk: 2.5,     // ancho de vereda [m]
	curb: 0.15,        // alto de la solera [m]
	extent: 520,       // el suelo llega hasta esta distancia del centro [m]
};

function mulberry32( a ) {

	return function () {

		a |= 0; a = a + 0x6D2B79F5 | 0;
		let t = Math.imul( a ^ a >>> 15, 1 | a );
		t = t + Math.imul( t ^ t >>> 7, 61 | t ) ^ t;
		return ( ( t ^ t >>> 14 ) >>> 0 ) / 4294967296;

	};

}

function hash2( i, j ) { const s = Math.sin( i * 127.1 + j * 311.7 ) * 43758.5453; return s - Math.floor( s ); }
export function valueNoise( x, z, cell ) {

	const u = x / cell, v = z / cell, i = Math.floor( u ), j = Math.floor( v ), fu = u - i, fv = v - j;
	const a = hash2( i, j ), b = hash2( i + 1, j ), c = hash2( i, j + 1 ), d = hash2( i + 1, j + 1 );
	const su = fu * fu * ( 3 - 2 * fu ), sv = fv * fv * ( 3 - 2 * fv );
	return ( a + ( b - a ) * su ) * ( 1 - sv ) + ( c + ( d - c ) * su ) * sv;

}

const N = CITY.blocks;
const streetPos = i => ( i - N / 2 ) * CITY.pitch;       // i = 0..N
const isAvenue = i => i === N / 2;
const halfOf = i => isAvenue( i ) ? CITY.halfAve : CITY.half;

// Relieve de base: lomas suaves, una pendiente general hacia el norte y un cerro al noreste
export function baseHeight( x, z ) {

	const hill = 14 * Math.exp( - ( ( x + 220 ) ** 2 + ( z - 220 ) ** 2 ) / ( 2 * 120 * 120 ) );
	return 4 * Math.sin( x / 210 ) * Math.cos( z / 260 ) + 0.02 * z + hill;

}

// Distancia con signo al eje de la calle más cercana, por cada dirección
function streetInfo( x, z, out ) {

	// calle norte-sur más cercana (constante en x) y este-oeste (constante en z)
	let i = Math.round( x / CITY.pitch + N / 2 ), j = Math.round( z / CITY.pitch + N / 2 );
	i = Math.max( 0, Math.min( N, i ) ); j = Math.max( 0, Math.min( N, j ) );
	out.i = i; out.j = j;
	out.dx = Math.abs( x - streetPos( i ) ); out.dz = Math.abs( z - streetPos( j ) );
	out.hx = halfOf( i ); out.hz = halfOf( j );
	return out;

}

const _si = {};
const edge = N / 2 * CITY.pitch;

// Tipo de superficie: 0 calzada, 1 vereda, 2 interior de manzana, 3 campo fuera de la ciudad
export function surfaceAt( x, z ) {

	const s = streetInfo( x, z, _si );
	const inX = Math.abs( z ) <= edge + CITY.half, inZ = Math.abs( x ) <= edge + CITY.half;
	const onNS = s.dx <= s.hx && inX, onEW = s.dz <= s.hz && inZ;
	if ( ! onNS && ! onEW ) return ( Math.abs( x ) > edge + CITY.half || Math.abs( z ) > edge + CITY.half ) ? 3 : 2;
	const roadNS = onNS && s.dx <= s.hx - CITY.sidewalk, roadEW = onEW && s.dz <= s.hz - CITY.sidewalk;
	return ( roadNS || roadEW ) ? 0 : 1;

}

// Altura del suelo, con soleras y la rugosidad propia de una malla fotogramétrica
export function groundHeight( x, z, rough = true ) {

	const type = surfaceAt( x, z );
	let h = baseHeight( x, z );
	if ( type === 1 || type === 2 ) h += CITY.curb;
	if ( rough ) {

		const amp = type === 0 ? 0.035 : ( type === 3 ? 0.25 : 0.06 );
		h += ( valueNoise( x, z, 0.9 ) - 0.5 ) * 2 * amp + ( valueNoise( x + 31, z - 17, 3.7 ) - 0.5 ) * amp;

	}

	return h;

}

// +X es el oeste: la primera calle (x más negativo) es la del extremo oriente
const NAMES_NS = [ '3 Oriente', '2 Oriente', '1 Oriente', 'Avenida Estación', '1 Poniente', '2 Poniente', '3 Poniente' ];
const NAMES_EW = [ '3 Sur', '2 Sur', '1 Sur', 'Avenida Alameda', '1 Norte', '2 Norte', '3 Norte' ];

/**
 * Genera la descripción completa de la ciudad: edificios, bultos, árboles y calles.
 */
export function generateCity( seed = 7 ) {

	const rnd = mulberry32( seed );
	const buildings = [], cars = [], trees = [], smears = [];
	const palette = [ [ 0.72, 0.69, 0.63 ], [ 0.62, 0.6, 0.58 ], [ 0.75, 0.72, 0.7 ], [ 0.58, 0.52, 0.46 ], [ 0.66, 0.68, 0.7 ], [ 0.7, 0.62, 0.55 ], [ 0.52, 0.55, 0.58 ] ];
	const carColors = [ [ 0.55, 0.56, 0.58 ], [ 0.2, 0.2, 0.22 ], [ 0.75, 0.75, 0.74 ], [ 0.45, 0.12, 0.1 ], [ 0.15, 0.22, 0.4 ], [ 0.82, 0.8, 0.72 ] ];

	// --- edificios: cada manzana se divide en una grilla de lotes
	for ( let bi = 0; bi < N; bi ++ ) for ( let bj = 0; bj < N; bj ++ ) {

		const x0 = streetPos( bi ) + halfOf( bi ) + 2.5, x1 = streetPos( bi + 1 ) - halfOf( bi + 1 ) - 2.5;
		const z0 = streetPos( bj ) + halfOf( bj ) + 2.5, z1 = streetPos( bj + 1 ) - halfOf( bj + 1 ) - 2.5;
		const nx = 2 + Math.floor( rnd() * 2 ), nz = 2 + Math.floor( rnd() * 2 );
		const central = Math.abs( bi - ( N - 1 ) / 2 ) < 1.6 && Math.abs( bj - ( N - 1 ) / 2 ) < 1.6;
		for ( let a = 0; a < nx; a ++ ) for ( let b = 0; b < nz; b ++ ) {

			if ( rnd() < 0.08 ) continue; // sitio eriazo
			const lx0 = x0 + ( x1 - x0 ) * a / nx, lx1 = x0 + ( x1 - x0 ) * ( a + 1 ) / nx;
			const lz0 = z0 + ( z1 - z0 ) * b / nz, lz1 = z0 + ( z1 - z0 ) * ( b + 1 ) / nz;
			const m = 0.6 + rnd() * 1.6;
			const h = central ? 12 + rnd() * 30 : 4 + rnd() * 9;
			buildings.push( { x0: lx0 + m, x1: lx1 - m, z0: lz0 + m, z1: lz1 - m, h, color: palette[ Math.floor( rnd() * palette.length ) ] } );

		}

	}

	// --- autos estacionados (bultos) junto a la solera, lejos de las esquinas
	const addCars = ( alongZ, i, side ) => {

		const c = streetPos( i ), off = ( halfOf( i ) - CITY.sidewalk - 1.15 ) * side;
		for ( let j = 0; j < N; j ++ ) {

			let s = streetPos( j ) + halfOf( j ) + 14;
			const sEnd = streetPos( j + 1 ) - halfOf( j + 1 ) - 14;
			while ( s < sEnd ) {

				if ( rnd() < 0.62 ) {

					const len = 4.1 + rnd() * 0.7, h = 1.35 + rnd() * 0.25;
					cars.push( alongZ
						? { x: c + off, z: s + len / 2, lx: 1.85, lz: len, h, color: carColors[ Math.floor( rnd() * carColors.length ) ] }
						: { x: s + len / 2, z: c + off, lx: len, lz: 1.85, h, color: carColors[ Math.floor( rnd() * carColors.length ) ] } );

				}

				s += 5.6 + rnd() * 1.2;

			}

		}

	};

	for ( let i = 0; i <= N; i ++ ) {

		if ( i === 0 || i === N ) continue;
		if ( ! isAvenue( i ) ) { addCars( true, i, i % 2 ? 1 : - 1 ); addCars( false, i, i % 2 ? - 1 : 1 ); }

	}

	// --- restos bajos de autos en movimiento sobre las avenidas (no bloquean)
	for ( let k = 0; k < 14; k ++ ) {

		const s = ( rnd() * 2 - 1 ) * ( edge - 30 ), lane = ( rnd() < 0.5 ? - 1 : 1 ) * ( 2 + rnd() * 3.5 );
		if ( k % 2 ) smears.push( { x: streetPos( N / 2 ) + lane, z: s, lx: 1.8, lz: 4.2, h: 0.25 + rnd() * 0.35 } );
		else smears.push( { x: s, z: streetPos( N / 2 ) + lane, lx: 4.2, lz: 1.8, h: 0.25 + rnd() * 0.35 } );

	}

	// --- árboles en las veredas
	for ( let i = 0; i <= N; i ++ ) for ( let j = 0; j < N; j ++ ) for ( const side of [ - 1, 1 ] ) {

		const c = streetPos( i ), off = ( halfOf( i ) - 1.1 ) * side;
		for ( let s = streetPos( j ) + halfOf( j ) + 9; s < streetPos( j + 1 ) - halfOf( j + 1 ) - 9; s += 13 + rnd() * 9 ) {

			if ( rnd() < 0.45 ) trees.push( { x: c + off, z: s, r: 1.8 + rnd() * 1.6, h: 5 + rnd() * 3.5 } );
			if ( rnd() < 0.45 ) trees.push( { x: s, z: c + off, r: 1.8 + rnd() * 1.6, h: 5 + rnd() * 3.5 } );

		}

	}

	// --- pasarela peatonal sobre la Avenida Alameda (corre de este a oeste)
	const bridge = { x: 165, z: streetPos( N / 2 ), halfSpan: CITY.halfAve + 1.5, width: 3, deck: 5.6, thick: 0.5 };

	return { seed, buildings, cars, smears, trees, bridge };

}

// ---------------------------------------------------------------------------
// Geometría
// ---------------------------------------------------------------------------

export class MeshBuilder {

	constructor() { this.p = []; this.c = []; this.i = []; }
	get count() { return this.p.length / 3; }
	vertex( x, y, z, col, shade = 1 ) {

		this.p.push( x, y, z );
		this.c.push( col[ 0 ] * shade, col[ 1 ] * shade, col[ 2 ] * shade );
		return this.p.length / 3 - 1;

	}

	quad( a, b, c, d ) { this.i.push( a, b, c, a, c, d ); }
	tri( a, b, c ) { this.i.push( a, b, c ); }

	// Tronco de pirámide de base (lx, lz) y tapa reducida: la forma de un auto en la malla
	frustum( cx, cz, y0, lx, lz, h, inset, col ) {

		const bx = lx / 2, bz = lz / 2, tx = Math.max( 0.1, bx - inset ), tz = Math.max( 0.1, bz - inset * 0.6 );
		const corners = [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ];
		// caras laterales, cada una con sus vértices para un sombreado plano
		for ( let k = 0; k < 4; k ++ ) {

			const a = corners[ k ], b = corners[ ( k + 1 ) % 4 ];
			const shade = [ 0.78, 0.9, 0.7, 0.84 ][ k ];
			const v0 = this.vertex( cx + a[ 0 ] * bx, y0, cz + a[ 1 ] * bz, col, shade );
			const v1 = this.vertex( cx + b[ 0 ] * bx, y0, cz + b[ 1 ] * bz, col, shade );
			const v2 = this.vertex( cx + b[ 0 ] * tx, y0 + h, cz + b[ 1 ] * tz, col, shade );
			const v3 = this.vertex( cx + a[ 0 ] * tx, y0 + h, cz + a[ 1 ] * tz, col, shade );
			this.quad( v0, v3, v2, v1 );

		}

		const t = corners.map( a => this.vertex( cx + a[ 0 ] * tx, y0 + h, cz + a[ 1 ] * tz, col, 1 ) );
		this.quad( t[ 0 ], t[ 3 ], t[ 2 ], t[ 1 ] );

	}

	box( x0, x1, z0, z1, y0, y1, col, roofShade = 0.8 ) {

		const cs = [ [ x0, z0 ], [ x1, z0 ], [ x1, z1 ], [ x0, z1 ] ];
		for ( let k = 0; k < 4; k ++ ) {

			const a = cs[ k ], b = cs[ ( k + 1 ) % 4 ];
			const shade = [ 0.82, 1, 0.74, 0.9 ][ k ];
			const v0 = this.vertex( a[ 0 ], y0, a[ 1 ], col, shade * 0.9 ), v1 = this.vertex( b[ 0 ], y0, b[ 1 ], col, shade * 0.9 );
			const v2 = this.vertex( b[ 0 ], y1, b[ 1 ], col, shade ), v3 = this.vertex( a[ 0 ], y1, a[ 1 ], col, shade );
			this.quad( v0, v3, v2, v1 );

		}

		const t = cs.map( a => this.vertex( a[ 0 ], y1, a[ 1 ], col, roofShade ) );
		this.quad( t[ 0 ], t[ 3 ], t[ 2 ], t[ 1 ] );

	}

	// Masa redondeada (copa de árbol)
	blob( cx, cy, cz, rx, ry, col ) {

		const seg = 7, rings = 4, base = this.count;
		for ( let r = 0; r <= rings; r ++ ) {

			const phi = Math.PI * r / rings, y = Math.cos( phi ), s = Math.sin( phi );
			for ( let k = 0; k < seg; k ++ ) {

				const th = 2 * Math.PI * k / seg;
				this.vertex( cx + Math.cos( th ) * s * rx, cy + y * ry, cz + Math.sin( th ) * s * rx, col, 0.75 + 0.25 * ( y * 0.5 + 0.5 ) );

			}

		}

		for ( let r = 0; r < rings; r ++ ) for ( let k = 0; k < seg; k ++ ) {

			const a = base + r * seg + k, b = base + r * seg + ( k + 1 ) % seg, c = a + seg, d = b + seg;
			this.quad( a, b, d, c );

		}

	}

	finish() {

		return { positions: new Float32Array( this.p ), colors: new Float32Array( this.c ), indices: new Uint32Array( this.i ) };

	}

}

const COLORS = {
	road: [ 0.25, 0.25, 0.27 ], roadLine: [ 0.78, 0.76, 0.62 ], sidewalk: [ 0.6, 0.59, 0.57 ],
	block: [ 0.43, 0.47, 0.39 ], field: [ 0.47, 0.5, 0.36 ], trunk: [ 0.3, 0.24, 0.18 ], leaf: [ 0.24, 0.36, 0.2 ],
	concrete: [ 0.62, 0.62, 0.6 ],
};

function groundColor( x, z ) {

	const type = surfaceAt( x, z );
	if ( type === 0 ) {

		// eje de la calzada, segmentado en las avenidas
		const s = streetInfo( x, z, _si );
		const onNS = s.dx <= s.hx - CITY.sidewalk, onEW = s.dz <= s.hz - CITY.sidewalk;
		if ( onNS !== onEW ) {

			const d = onNS ? s.dx : s.dz, along = onNS ? z : x;
			if ( d < 0.35 && ( Math.floor( along / 4 ) % 2 === 0 ) ) return COLORS.roadLine;

		}

		const n = 0.94 + 0.12 * valueNoise( x, z, 6 );
		return [ COLORS.road[ 0 ] * n, COLORS.road[ 1 ] * n, COLORS.road[ 2 ] * n ];

	}

	if ( type === 1 ) return COLORS.sidewalk;
	const base = type === 2 ? COLORS.block : COLORS.field;
	const n = 0.85 + 0.3 * valueNoise( x, z, 14 );
	return [ base[ 0 ] * n, base[ 1 ] * n, base[ 2 ] * n ];

}

/**
 * Malla de una región rectangular de la ciudad.
 * opts.step: separación de la grilla del suelo [m]; opts.detail: incluye bultos y árboles;
 * opts.lift: desplazamiento vertical (para simular el error de un nivel de detalle grueso).
 */
export function buildRegion( city, x0, z0, x1, z1, opts = {} ) {

	const { step = 1, detail = true, lift = 0, rough = true } = opts;
	const mb = new MeshBuilder();
	const nx = Math.max( 1, Math.round( ( x1 - x0 ) / step ) ), nz = Math.max( 1, Math.round( ( z1 - z0 ) / step ) );

	// suelo
	for ( let j = 0; j <= nz; j ++ ) for ( let i = 0; i <= nx; i ++ ) {

		const x = x0 + ( x1 - x0 ) * i / nx, z = z0 + ( z1 - z0 ) * j / nz;
		mb.vertex( x, groundHeight( x, z, rough ) + lift, z, groundColor( x, z ) );

	}

	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const a = j * ( nx + 1 ) + i, b = a + 1, c = a + nx + 1, d = c + 1;
		mb.quad( a, c, d, b );

	}

	const inside = ( x, z ) => x >= x0 && x < x1 && z >= z0 && z < z1;

	for ( const b of city.buildings ) {

		const cx = ( b.x0 + b.x1 ) / 2, cz = ( b.z0 + b.z1 ) / 2;
		if ( ! inside( cx, cz ) ) continue;
		const yb = baseHeight( cx, cz ) - 1.5;
		mb.box( b.x0, b.x1, b.z0, b.z1, yb + lift, baseHeight( cx, cz ) + CITY.curb + b.h + lift, b.color );

	}

	if ( detail ) {

		for ( const c of city.cars ) if ( inside( c.x, c.z ) ) mb.frustum( c.x, c.z, groundHeight( c.x, c.z, false ) - 0.05 + lift, c.lx, c.lz, c.h, 0.45, c.color );
		for ( const c of city.smears ) if ( inside( c.x, c.z ) ) mb.frustum( c.x, c.z, groundHeight( c.x, c.z, false ) - 0.05 + lift, c.lx, c.lz, c.h, 0.5, COLORS.road );
		for ( const t of city.trees ) {

			if ( ! inside( t.x, t.z ) ) continue;
			const y = groundHeight( t.x, t.z, false ) + lift;
			mb.frustum( t.x, t.z, y - 0.1, 0.7, 0.7, t.h * 0.55, 0.12, COLORS.trunk );
			mb.blob( t.x, y + t.h * 0.72, t.z, t.r, t.h * 0.4, COLORS.leaf );

		}

	}

	// pasarela: dos pilares y un tablero sobre la avenida
	const br = city.bridge;
	if ( inside( br.x, br.z ) ) {

		const y = baseHeight( br.x, br.z ) + lift;
		const w = br.width / 2;
		mb.box( br.x - w, br.x + w, br.z - br.halfSpan, br.z + br.halfSpan, y + br.deck, y + br.deck + br.thick, COLORS.concrete, 0.9 );
		// cara inferior del tablero
		const u = [ [ br.x - w, br.z - br.halfSpan ], [ br.x + w, br.z - br.halfSpan ], [ br.x + w, br.z + br.halfSpan ], [ br.x - w, br.z + br.halfSpan ] ].map( q => mb.vertex( q[ 0 ], y + br.deck, q[ 1 ], COLORS.concrete, 0.55 ) );
		mb.quad( u[ 0 ], u[ 1 ], u[ 2 ], u[ 3 ] );
		for ( const s of [ - 1, 1 ] ) mb.box( br.x - 0.5, br.x + 0.5, br.z + s * ( br.halfSpan - 0.6 ) - 0.5, br.z + s * ( br.halfSpan - 0.6 ) + 0.5, y - 0.5, y + br.deck, COLORS.concrete );

	}

	return mb.finish();

}

// Lista de regiones (teselas) que cubren la ciudad y sus alrededores
export function cityChunks( size = CITY.pitch ) {

	const out = [], e = CITY.extent;
	const n = Math.ceil( 2 * e / size );
	for ( let i = 0; i < n; i ++ ) for ( let j = 0; j < n; j ++ ) out.push( { x0: - e + i * size, z0: - e + j * size, x1: - e + ( i + 1 ) * size, z1: - e + ( j + 1 ) * size } );
	return out;

}

// ---------------------------------------------------------------------------
// Red vial, en el formato de respuesta de Overpass ("out tags geom")
// ---------------------------------------------------------------------------
export function cityRoadsOSM( geo ) {

	const elements = [];
	const id = ( i, j, k = 0 ) => 1000000 + i * 10000 + j * 100 + k;      // nodo de la esquina (i, j) y sus intermedios
	const g = { lat: 0, lon: 0, h: 0 };
	const pt = ( x, z ) => { geo.toGeo( x, baseHeight( x, z ), z, g ); return { lat: g.lat, lon: g.lon }; };
	const SUB = 4; // tramos por cuadra

	// calles norte-sur (x constante)
	for ( let i = 0; i <= N; i ++ ) {

		const nodes = [], geometry = [];
		for ( let j = 0; j < N; j ++ ) for ( let k = 0; k < SUB; k ++ ) {

			nodes.push( k === 0 ? id( i, j ) : 500000000 + id( i, j, k ) );
			geometry.push( pt( streetPos( i ), streetPos( j ) + CITY.pitch * k / SUB ) );

		}

		nodes.push( id( i, N ) ); geometry.push( pt( streetPos( i ), streetPos( N ) ) );
		const tags = { highway: isAvenue( i ) ? 'secondary' : 'residential', name: NAMES_NS[ i ] };
		if ( ! isAvenue( i ) && i > 0 && i < N ) tags.oneway = i % 2 ? 'yes' : '-1';
		elements.push( { type: 'way', id: 2000 + i, nodes, geometry, tags } );

	}

	// calles este-oeste (z constante)
	for ( let j = 0; j <= N; j ++ ) {

		const nodes = [], geometry = [];
		for ( let i = 0; i < N; i ++ ) for ( let k = 0; k < SUB; k ++ ) {

			nodes.push( k === 0 ? id( i, j ) : 700000000 + id( i, j, k ) );
			geometry.push( pt( streetPos( i ) + CITY.pitch * k / SUB, streetPos( j ) ) );

		}

		nodes.push( id( N, j ) ); geometry.push( pt( streetPos( N ), streetPos( j ) ) );
		const tags = { highway: isAvenue( j ) ? 'secondary' : 'residential', name: NAMES_EW[ j ] };
		if ( ! isAvenue( j ) && j > 0 && j < N ) tags.oneway = j % 2 ? '-1' : 'yes';
		elements.push( { type: 'way', id: 3000 + j, nodes, geometry, tags } );

	}

	return { version: 0.6, generator: 'Ruta Sur · ciudad de pruebas', elements };

}

// Punto de partida recomendado: sobre la Avenida Alameda, por la pista derecha y mirando al este
export const CITY_START = { x: 60, z: - 3.2, compass: 90 };
