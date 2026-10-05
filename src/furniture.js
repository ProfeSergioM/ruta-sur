// Ruta Sur · mobiliario urbano
// --------------------------------------------------------------------------
// Lo que puebla una calle además de los edificios: postes de luz, autos
// estacionados, paraderos, señales, semáforos, bancas y basureros. Cada pieza
// se escribe en dos constructores de malla: `solid` para lo que el camión
// choca (postes, carrocerías, bancas) y `decor` para lo que cuelga arriba o es
// delgado (brazos, techos, cables). Las placas de las señales van en `sign`,
// con la textura del atlas, y las lámparas de los semáforos en `glow`.
//
// Todas las piezas se colocan con un rumbo: `yaw` es el ángulo del eje de la
// calle, con el mismo convenio que el camión (el frente mira a -Z con yaw 0).

export const F = {
	post: [ 0.58, 0.58, 0.56 ], wood: [ 0.45, 0.38, 0.3 ], steel: [ 0.35, 0.37, 0.4 ], dark: [ 0.12, 0.13, 0.15 ],
	glass: [ 0.2, 0.26, 0.32 ], tire: [ 0.08, 0.08, 0.09 ], roof: [ 0.55, 0.58, 0.6 ], bench: [ 0.5, 0.36, 0.22 ],
	bin: [ 0.2, 0.35, 0.25 ], red: [ 0.9, 0.12, 0.1 ], green: [ 0.1, 0.8, 0.3 ], amber: [ 0.95, 0.7, 0.1 ], off: [ 0.18, 0.18, 0.2 ],
};
export const CAR_COLORS = [ [ 0.85, 0.85, 0.87 ], [ 0.2, 0.22, 0.25 ], [ 0.6, 0.62, 0.65 ], [ 0.55, 0.1, 0.1 ], [ 0.15, 0.25, 0.5 ], [ 0.75, 0.73, 0.68 ], [ 0.2, 0.4, 0.3 ], [ 0.8, 0.55, 0.15 ] ];

// Celdas del atlas de señales (cuatro de 64 px en una textura de 256 × 64): u de 0 a 1 por celda
export const SIGNS = { pare: 0, velocidad: 1, paradero: 2, noEstacionar: 3 };

const fwd = yaw => [ - Math.sin( yaw ), - Math.cos( yaw ) ], right = yaw => [ Math.cos( yaw ), - Math.sin( yaw ) ];

// Caja girada: centro (cx, cz), largo `l` en el sentido del rumbo, ancho `w` a lo ancho, de y0 a y1
export function boxAt( mb, cx, cz, yaw, l, w, y0, y1, col, roofShade = 0.8, dl = 0, dw = 0 ) {

	const [ fx, fz ] = fwd( yaw ), [ rx, rz ] = right( yaw );
	cx += fx * dl + rx * dw; cz += fz * dl + rz * dw;
	const hl = l / 2, hw = w / 2;
	// las esquinas en el mismo orden que las cajas de la ciudad de pruebas (con yaw 0: x creciente y luego z creciente)
	const c = [ [ - hw, hl ], [ hw, hl ], [ hw, - hl ], [ - hw, - hl ] ].map( ( [ a, b ] ) => [ cx + rx * a + fx * b, cz + rz * a + fz * b ] );
	for ( let k = 0; k < 4; k ++ ) {

		const a = c[ k ], b = c[ ( k + 1 ) % 4 ];
		const shade = [ 0.82, 1, 0.74, 0.9 ][ k ];
		const v0 = mb.vertex( a[ 0 ], y0, a[ 1 ], col, shade * 0.9 ), v1 = mb.vertex( b[ 0 ], y0, b[ 1 ], col, shade * 0.9 );
		const v2 = mb.vertex( b[ 0 ], y1, b[ 1 ], col, shade ), v3 = mb.vertex( a[ 0 ], y1, a[ 1 ], col, shade );
		mb.quad( v0, v3, v2, v1 );

	}

	const t = c.map( a => mb.vertex( a[ 0 ], y1, a[ 1 ], col, roofShade ) );
	mb.quad( t[ 0 ], t[ 3 ], t[ 2 ], t[ 1 ] );

}

// Poste de luz o teléfono: poste de hormigón con travesaño arriba
export function utilityPole( solid, decor, x, z, yaw ) {

	const H = 7.5;
	boxAt( solid, x, z, yaw, 0.24, 0.24, 0, H, F.post, 0.7 );
	boxAt( decor, x, z, yaw, 0.1, 1.3, H - 0.35, H - 0.25, F.wood, 0.7 );
	boxAt( decor, x, z, yaw, 0.1, 1.3, H - 0.95, H - 0.85, F.wood, 0.7 );

}

// Auto estacionado, mirando en el sentido `yaw`
export function parkedCar( solid, x, z, yaw, color, seed = 0 ) {

	// la carrocería llega a 1,05 m o más: las sondas del camión, a un metro del suelo, la encuentran de punta a punta
	const L = 4.2 + 0.6 * seed, W = 1.75, hood = 1.05 + 0.1 * seed;
	boxAt( solid, x, z, yaw, L, W, 0.3, hood, color, 0.9 );
	boxAt( solid, x, z, yaw, L * 0.5, W - 0.24, hood, hood + 0.5, F.glass, 0.3, - L * 0.05 );
	boxAt( solid, x, z, yaw, L * 0.5 - 0.6, W - 0.3, hood + 0.46, hood + 0.54, color, 0.9, - L * 0.05 );
	const r = 0.32;
	for ( const dl of [ L / 2 - 0.85, - L / 2 + 0.85 ] ) for ( const s of [ - 1, 1 ] ) boxAt( solid, x, z, yaw, 2 * r, 0.24, 0, 2 * r, F.tire, 0.6, dl, s * ( W / 2 - 0.02 ) );

}

// Paradero: dos postes, panel trasero, techo y banca; se abre hacia la calle (la derecha del rumbo)
export function busStop( solid, decor, x, z, yaw ) {

	const L = 3.2, D = 1.4;
	for ( const dl of [ - L / 2 + 0.1, L / 2 - 0.1 ] ) boxAt( solid, x, z, yaw, 0.12, 0.12, 0, 2.5, F.steel, 0.7, dl, - D / 2 + 0.06 );
	boxAt( solid, x, z, yaw, L, 0.06, 0.9, 2.4, F.glass, 0.5, 0, - D / 2 + 0.03 ); // panel trasero, del lado de la vereda
	boxAt( decor, x, z, yaw, L + 0.2, D, 2.5, 2.62, F.roof, 0.9 );
	boxAt( solid, x, z, yaw, 1.8, 0.42, 0.42, 0.5, F.bench, 0.9, 0, - D / 2 + 0.35 );

}

// Banca de plaza y basurero
export function bench( solid, x, z, yaw ) {

	boxAt( solid, x, z, yaw, 1.7, 0.45, 0.4, 0.48, F.bench, 0.95 );
	boxAt( solid, x, z, yaw, 1.7, 0.08, 0.48, 0.9, F.bench, 0.9, 0, - 0.18 );
	for ( const dl of [ - 0.7, 0.7 ] ) boxAt( solid, x, z, yaw, 0.08, 0.4, 0, 0.4, F.steel, 0.7, dl );

}

export function bin( solid, x, z, yaw ) { boxAt( solid, x, z, yaw, 0.5, 0.5, 0, 0.95, F.bin, 0.7 ); }

// Señal: poste delgado y placa cuadrada que mira contra el rumbo (hacia quien viene por la calle)
export function roadSign( solid, sign, x, z, yaw, cell, size = 0.75, h = 2.2 ) {

	boxAt( solid, x, z, yaw, 0.08, 0.08, 0, h + size / 2, F.steel, 0.7 );
	const [ rx, rz ] = right( yaw ), [ fx, fz ] = fwd( yaw );
	const hs = size / 2, u0 = cell, u1 = cell + 1, w = [ 1, 1, 1 ];
	// la placa, apenas delante del poste; el frente mira hacia -rumbo, el dorso gris hacia +rumbo
	const px = x - fx * 0.06, pz = z - fz * 0.06;
	const a = sign.vertex( px + rx * hs, h, pz + rz * hs, w, 1, u0, 0 ), b = sign.vertex( px - rx * hs, h, pz - rz * hs, w, 1, u1, 0 );
	const c = sign.vertex( px - rx * hs, h + size, pz - rz * hs, w, 1, u1, 1 ), d = sign.vertex( px + rx * hs, h + size, pz + rz * hs, w, 1, u0, 1 );
	sign.quad( a, b, c, d );
	const g = [ 0.45, 0.46, 0.48 ], e = sign.vertex( px - rx * hs, h, pz - rz * hs, g, 1, 0.02, 0.98 ), f = sign.vertex( px + rx * hs, h, pz + rz * hs, g, 1, 0.02, 0.98 );
	const gg = sign.vertex( px + rx * hs, h + size, pz + rz * hs, g, 1, 0.02, 0.98 ), hh = sign.vertex( px - rx * hs, h + size, pz - rz * hs, g, 1, 0.02, 0.98 );
	sign.quad( e, f, gg, hh );

}

// Semáforo: poste con cabezal de tres lámparas, con la que está encendida según `lit` ('red' | 'green')
export function trafficLight( solid, decor, glow, x, z, yaw, lit = 'red' ) {

	const H = 3.6;
	boxAt( solid, x, z, yaw, 0.14, 0.14, 0, H, F.steel, 0.7 );
	boxAt( decor, x, z, yaw, 0.3, 0.3, H - 1.05, H + 0.05, F.dark, 0.6, - 0.12 );
	const lamps = [ [ 'red', F.red, H - 0.2 ], [ 'amber', F.amber, H - 0.5 ], [ 'green', F.green, H - 0.8 ] ];
	for ( const [ name, col, y ] of lamps ) boxAt( glow, x, z, yaw, 0.22, 0.08, y - 0.1, y + 0.1, name === lit ? col : F.off, 1, - 0.12, - 0.19 );

}
