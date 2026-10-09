// Ruta Sur · modelo visual del camión
// --------------------------------------------------------------------------
// El camión se arma con primitivas a partir de las medidas de la física, así
// que lo que se ve coincide con lo que se simula. Cada unidad tiene su origen
// en el suelo, bajo su eje de referencia, y mira hacia -Z.

import * as THREE from 'three';
import { trailerAxleXZ } from './physics.js';

const C = {
	cab: 0xc23b22, cabDark: 0x8f2a18, glass: 0x1b2730, steel: 0x2c3036, rubber: 0x16171a,
	rim: 0xb9bcc0, chrome: 0xc9ccd0, body: 0xe9e6de, bodyShade: 0xcfccc4, green: 0x0e6b45,
	dash: 0x23272c, dashLight: 0x363b42, lampRed: 0xd32f1e, lampWhite: 0xfff3cf, amber: 0xf2a33a,
};

const mats = {};
function mat( name, opts ) {

	if ( ! mats[ name ] ) mats[ name ] = new THREE.MeshLambertMaterial( opts );
	return mats[ name ];

}

function box( w, h, d, material, x = 0, y = 0, z = 0 ) {

	const m = new THREE.Mesh( new THREE.BoxGeometry( w, h, d ), material );
	m.position.set( x, y, z );
	return m;

}

// Rueda con su eje a lo ancho del camión. Devuelve el grupo que dirige y el que gira.
function wheel( radius, width, dual = false ) {

	const holder = new THREE.Group();
	const spinner = new THREE.Group();
	holder.add( spinner );
	const tire = new THREE.CylinderGeometry( radius, radius, width, 20 );
	tire.rotateZ( Math.PI / 2 );
	const rimG = new THREE.CylinderGeometry( radius * 0.55, radius * 0.55, width + 0.02, 12 );
	rimG.rotateZ( Math.PI / 2 );
	const offsets = dual ? [ - width * 0.56, width * 0.56 ] : [ 0 ];
	for ( const o of offsets ) {

		const t = new THREE.Mesh( tire, mat( 'rubber', { color: C.rubber } ) );
		const r = new THREE.Mesh( rimG, mat( 'rim', { color: C.rim } ) );
		t.position.x = o; r.position.x = o;
		spinner.add( t, r );

	}

	// una marca en la llanta para que se note el giro
	const lug = box( 0.05, radius * 0.9, 0.08, mat( 'steel', { color: C.steel } ) );
	lug.position.x = ( dual ? width * 1.1 : width * 0.52 );
	spinner.add( lug );
	const lug2 = lug.clone(); lug2.position.x = - lug.position.x; spinner.add( lug2 );
	return { holder, spinner };

}

function shadowTexture() {

	const c = document.createElement( 'canvas' );
	c.width = 64; c.height = 256;
	const g = c.getContext( '2d' );
	g.clearRect( 0, 0, 64, 256 );
	// rectángulo de bordes suaves
	for ( let i = 0; i < 14; i ++ ) {

		g.fillStyle = `rgba(0,0,0,${ 0.055 })`;
		const p = i * 1.6;
		g.fillRect( p, p * 1.5, 64 - 2 * p, 256 - 3 * p );

	}

	const t = new THREE.CanvasTexture( c );
	t.colorSpace = THREE.SRGBColorSpace;
	return t;

}

function sideTexture( name ) {

	const c = document.createElement( 'canvas' );
	c.width = 1024; c.height = 256;
	const draw = () => {

		const g = c.getContext( '2d' );
		g.fillStyle = '#e9e6de'; g.fillRect( 0, 0, 1024, 256 );
		g.fillStyle = '#0e6b45'; g.fillRect( 0, 178, 1024, 34 );
		g.fillStyle = '#f2a33a'; g.fillRect( 0, 214, 1024, 8 );
		g.fillStyle = '#0e6b45';
		g.font = "900 104px 'Overpass', 'Arial Narrow', Arial, sans-serif";
		g.textBaseline = 'middle';
		g.fillText( name.toUpperCase(), 60, 98 );
		// costillas de la carrocería
		g.fillStyle = 'rgba(0,0,0,0.05)';
		for ( let x = 0; x < 1024; x += 64 ) g.fillRect( x, 0, 3, 256 );

	};

	draw();
	const t = new THREE.CanvasTexture( c );
	t.colorSpace = THREE.SRGBColorSpace;
	t.anisotropy = 4;
	if ( document.fonts && document.fonts.ready ) document.fonts.ready.then( () => { draw(); t.needsUpdate = true; } );
	return t;

}

export function createTruckModel( spec, name = 'Ruta Sur' ) {

	const tr = spec.tractor, tl = spec.trailer, R = spec.engine.wheelRadius;
	const root = new THREE.Group();
	root.name = 'Camión';

	const steel = mat( 'steel', { color: C.steel } );
	const cabMat = mat( 'cab', { color: C.cab } );
	const glass = mat( 'glass', { color: C.glass } );
	const shadowMat = new THREE.MeshBasicMaterial( { map: shadowTexture(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 2, fog: true } );

	const wheels = [];      // { spinner, radius }
	const steer = [];       // grupos que giran con la dirección
	const mirrors = [];     // { side, glass, anchor }: vidrio y cámara de cada espejo

	// ------------------------------------------------------------------ tracto
	const tractor = new THREE.Group();
	tractor.rotation.order = 'YXZ';
	root.add( tractor );

	const L = tr.wheelbase, zFront = - ( L + tr.frontOverhang ), W = tr.width;
	const chassisLen = L + tr.frontOverhang + tr.rearOverhang - 0.6;
	tractor.add( box( 0.9, 0.3, chassisLen, steel, 0, 0.82, zFront + 0.6 + chassisLen / 2 ) );

	// todo lo que se balancea con la suspensión de la cabina
	const cab = new THREE.Group();
	cab.position.set( 0, 0.95, - L * 0.6 );
	tractor.add( cab );
	const cabZ = z => z - cab.position.z, cabY = y => y - cab.position.y;

	const exterior = new THREE.Group();
	cab.add( exterior );
	// haz de los focos sobre la calzada, delante del camión: se suma a la luz y de día no se ve
	const beamTex = ( () => {

		const c = document.createElement( 'canvas' ); c.width = 64; c.height = 128;
		const g = c.getContext( '2d' );
		const grad = g.createLinearGradient( 0, 0, 0, 128 );
		grad.addColorStop( 0, 'rgba(255,240,200,0.0)' ); grad.addColorStop( 0.18, 'rgba(255,240,200,0.9)' ); grad.addColorStop( 1, 'rgba(255,240,200,0.0)' );
		g.fillStyle = grad; g.fillRect( 0, 0, 64, 128 );
		// más angosto hacia el camión
		g.globalCompositeOperation = 'destination-in';
		g.beginPath(); g.moveTo( 26, 128 ); g.lineTo( 38, 128 ); g.lineTo( 64, 0 ); g.lineTo( 0, 0 ); g.closePath(); g.fill();
		const t = new THREE.CanvasTexture( c ); t.colorSpace = THREE.SRGBColorSpace;
		return t;

	} )();
	const beamMat = new THREE.MeshBasicMaterial( { map: beamTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false } );
	const beam = new THREE.Mesh( new THREE.PlaneGeometry( 9, 26 ), beamMat );
	beam.rotation.x = - Math.PI / 2;
	beam.position.set( 0, 0.06, zFront - 13.5 );
	beam.renderOrder = 2;
	tractor.add( beam );
	// la cabina de un tracto sube a 3,5 m; un camión chico trae sus medidas en spec.cab
	const cabSpec = spec.cab || {}, cabTop = cabSpec.top || 3.5, dy = cabTop - 3.5, cabLen = cabSpec.len || ( cabTop < 3 ? 1.9 : 2.25 );
	exterior.add( box( W - 0.04, cabTop - 0.95, cabLen, cabMat, 0, cabY( ( cabTop + 0.95 ) / 2 ), cabZ( zFront + cabLen / 2 ) ) );
	// parabrisas, ventanas, parrilla y parachoques
	exterior.add( box( W - 0.34, 0.95, 0.04, glass, 0, cabY( 2.72 + dy ), cabZ( zFront - 0.01 ) ) );
	exterior.add( box( 0.04, 0.72, 0.95, glass, - W / 2 + 0.01, cabY( 2.72 + dy ), cabZ( zFront + 0.75 ) ) );
	exterior.add( box( 0.04, 0.72, 0.95, glass, W / 2 - 0.01, cabY( 2.72 + dy ), cabZ( zFront + 0.75 ) ) );
	exterior.add( box( W - 0.7, Math.min( 0.75, 0.75 + dy * 0.5 ), 0.05, steel, 0, cabY( 1.62 + dy * 0.5 ), cabZ( zFront - 0.015 ) ) );
	exterior.add( box( W, 0.42, 0.3, mat( 'cabDark', { color: C.cabDark } ), 0, cabY( 0.72 ), cabZ( zFront + 0.12 ) ) );
	const lamp = mat( 'lampWhite', { color: C.lampWhite, emissive: C.lampWhite, emissiveIntensity: 0.6 } );
	exterior.add( box( 0.36, 0.16, 0.05, lamp, - W / 2 + 0.3, cabY( 0.92 ), cabZ( zFront - 0.02 ) ) );
	exterior.add( box( 0.36, 0.16, 0.05, lamp, W / 2 - 0.3, cabY( 0.92 ), cabZ( zFront - 0.02 ) ) );
	// deflector de techo
	if ( cabSpec.deflector !== false ) {

		const defl = box( W - 0.3, 0.6, 1.5, cabMat, 0, cabY( cabTop + 0.22 ), cabZ( zFront + 1.35 ) );
		defl.rotation.x = 0.28;
		exterior.add( defl );

	}

	// espejos
	for ( const s of [ - 1, 1 ] ) {

		exterior.add( box( 0.1, 0.62, 0.22, steel, s * ( W / 2 + 0.22 ), cabY( 2.75 + dy ), cabZ( zFront + 0.2 ) ) );
		exterior.add( box( 0.3, 0.05, 0.05, steel, s * ( W / 2 + 0.1 ), cabY( 2.95 + dy ), cabZ( zFront + 0.2 ) ) );

	}

	// tubo de escape y estanques
	if ( cabSpec.stack !== false ) {

		const stack = new THREE.Mesh( new THREE.CylinderGeometry( 0.09, 0.09, 2.3, 10 ), mat( 'chrome', { color: C.chrome } ) );
		stack.position.set( W / 2 - 0.25, 2.3, zFront + cabLen + 0.18 );
		tractor.add( stack );

	}

	if ( tl ) for ( const s of [ - 1, 1 ] ) {

		const tank = new THREE.Mesh( new THREE.CylinderGeometry( 0.33, 0.33, 1.25, 14 ), mat( 'chrome', { color: C.chrome } ) );
		tank.rotation.x = Math.PI / 2;
		tank.position.set( s * ( W / 2 - 0.36 ), 0.78, - L * 0.5 );
		tractor.add( tank );

	}

	// ruedas del tracto
	for ( const s of [ - 1, 1 ] ) {

		const f = wheel( R, 0.3 );
		f.holder.position.set( s * tr.track / 2, R, - L );
		tractor.add( f.holder ); wheels.push( { spinner: f.spinner, radius: R } ); steer.push( f.holder );
		const r = wheel( R, 0.28, true );
		r.holder.position.set( s * ( tr.track / 2 - 0.14 ), R, 0 );
		tractor.add( r.holder ); wheels.push( { spinner: r.spinner, radius: R } );
		// guardabarros
		tractor.add( box( 0.7, 0.06, 1.3, steel, s * ( tr.track / 2 - 0.14 ), 2 * R + 0.1, 0 ) );

	}

	if ( tl ) {

		// quinta rueda
		const fifth = new THREE.Mesh( new THREE.CylinderGeometry( 0.48, 0.48, 0.1, 16 ), steel );
		fifth.position.set( 0, 1.1, - tr.hitch );
		tractor.add( fifth );

	} else {

		// carrocería del camión rígido
		const z0 = zFront + cabLen + 0.2, z1 = tr.rearOverhang, bh = cabSpec.bodyHeight || 2.75;
		const tex = sideTexture( name );
		const side = new THREE.MeshLambertMaterial( { map: tex } );
		const plain = mat( 'body', { color: C.body } );
		const b = new THREE.Mesh( new THREE.BoxGeometry( W, bh, z1 - z0 ), [ side, side, plain, mat( 'bodyShade', { color: C.bodyShade } ), plain, plain ] );
		b.position.set( 0, 1.1 + bh / 2, ( z0 + z1 ) / 2 );
		tractor.add( b );
		const red = mat( 'lampRed', { color: C.lampRed, emissive: C.lampRed, emissiveIntensity: 0.35 } );
		tractor.add( box( 0.3, 0.12, 0.05, red, - W / 2 + 0.3, 1.0, z1 + 0.01 ), box( 0.3, 0.12, 0.05, red, W / 2 - 0.3, 1.0, z1 + 0.01 ) );

	}

	const shadowT = new THREE.Mesh( new THREE.PlaneGeometry( W + 0.9, L + tr.frontOverhang + tr.rearOverhang + 1.0 ), shadowMat );
	shadowT.rotation.x = - Math.PI / 2;
	shadowT.position.set( 0, 0.07, ( zFront + tr.rearOverhang ) / 2 );
	shadowT.renderOrder = 1;
	tractor.add( shadowT );

	// ------------------------------------------------------- interior de cabina
	const interior = new THREE.Group();
	interior.visible = false;
	cab.add( interior );
	const dash = mat( 'dash', { color: C.dash } ), dashL = mat( 'dashLight', { color: C.dashLight } );
	const eyeX = - 0.55, eyeY = 2.55 + dy, eyeZ = zFront + 1.3;
	// tablero
	interior.add( box( W - 0.1, 0.55, 0.7, dash, 0, cabY( 1.78 + dy ), cabZ( zFront + 0.48 ) ) );
	interior.add( box( 0.62, 0.2, 0.3, dashL, eyeX, cabY( 2.1 + dy ), cabZ( zFront + 0.6 ) ) );
	// pilares, techo y marcos de puerta
	for ( const s of [ - 1, 1 ] ) {

		const pillar = box( 0.075, 1.5, 0.09, dashL, s * ( W / 2 - 0.06 ), cabY( 2.72 + dy ), cabZ( zFront + 0.08 ) );
		pillar.rotation.x = - 0.08;
		interior.add( pillar );
		interior.add( box( 0.06, 1.1, 2.0, dash, s * ( W / 2 - 0.05 ), cabY( 1.5 + dy ), cabZ( zFront + 1.1 ) ) );
		interior.add( box( 0.1, 1.5, 0.14, dash, s * ( W / 2 - 0.07 ), cabY( 2.72 + dy ), cabZ( zFront + 1.35 ) ) );
		// Espejos vistos desde adentro. La carcasa mira hacia atrás y gira 21° hacia el
		// conductor; el vidrio lleva la imagen que dibuja la cámara del espejo.
		const housing = new THREE.Group();
		housing.position.set( s * ( W / 2 + 0.3 ), cabY( 2.62 + dy ), cabZ( zFront + 0.22 ) );
		housing.rotation.y = - s * 0.37;
		housing.add( box( 0.3, 0.58, 0.06, steel ) );
		const glass = new THREE.Mesh( new THREE.PlaneGeometry( 0.24, 0.48 ), new THREE.MeshBasicMaterial( { color: 0x8d9aa4, toneMapped: false } ) );
		glass.position.z = 0.032;
		housing.add( glass );
		interior.add( housing );
		interior.add( box( 0.34, 0.04, 0.04, steel, s * ( W / 2 + 0.14 ), cabY( 2.86 + dy ), cabZ( zFront + 0.2 ) ) );
		// anclaje de la cámara del espejo: mira hacia atrás, 7° hacia afuera y 4° hacia abajo
		const anchor = new THREE.Object3D();
		anchor.position.copy( housing.position );
		anchor.rotation.order = 'YXZ';
		anchor.rotation.y = Math.PI + s * 0.12;
		anchor.rotation.x = - 0.07;
		cab.add( anchor );
		mirrors.push( { side: s, glass, anchor } );

	}

	interior.add( box( W, 0.12, 2.2, dash, 0, cabY( 3.42 + dy ), cabZ( zFront + 1.1 ) ) );
	interior.add( box( W - 0.3, 0.14, 0.05, dashL, 0, cabY( 3.3 + dy ), cabZ( zFront + 0.06 ) ) );
	// volante
	const sw = new THREE.Group();
	sw.position.set( eyeX, cabY( 2.02 + dy ), cabZ( zFront + 0.92 ) );
	sw.rotation.x = - 1.0; // columna inclinada hacia el conductor
	const swSpin = new THREE.Group();
	sw.add( swSpin );
	const ring = new THREE.Mesh( new THREE.TorusGeometry( 0.23, 0.022, 8, 28 ), mat( 'rubber', { color: C.rubber } ) );
	swSpin.add( ring, box( 0.44, 0.035, 0.03, dashL ), box( 0.035, 0.22, 0.03, dashL, 0, - 0.11, 0 ) );
	interior.add( sw );

	// punto de vista del conductor
	const eye = new THREE.Object3D();
	eye.position.set( eyeX, cabY( eyeY ), cabZ( eyeZ ) );
	cab.add( eye );

	// ---------------------------------------------------------- semirremolque
	let trailer = null;
	if ( tl ) {

		trailer = new THREE.Group();
		trailer.rotation.order = 'YXZ';
		root.add( trailer );
		const zF = - ( tl.wheelbase + tl.kingpinFromFront ), zR = tl.length - tl.kingpinFromFront - tl.wheelbase;
		const tex = sideTexture( name );
		const side = new THREE.MeshLambertMaterial( { map: tex } );
		const plain = mat( 'body', { color: C.body } );
		const shade = mat( 'bodyShade', { color: C.bodyShade } );
		const body = new THREE.Mesh( new THREE.BoxGeometry( tl.width, 2.8, tl.length ), [ side, side, plain, shade, plain, plain ] );
		body.position.set( 0, 1.2 + 1.4, ( zF + zR ) / 2 );
		trailer.add( body );
		trailer.add( box( 1.0, 0.25, tl.length - 1.2, steel, 0, 1.05, ( zF + zR ) / 2 ) );
		for ( const z of [ - 1.31, 0, 1.31 ] ) for ( const s of [ - 1, 1 ] ) {

			const w = wheel( 0.5, 0.38 );
			w.holder.position.set( s * tl.track / 2, 0.5, z );
			trailer.add( w.holder ); wheels.push( { spinner: w.spinner, radius: 0.5 } );

		}

		trailer.add( box( 2.2, 0.1, 4.3, steel, 0, 1.08, 0 ) );
		// patas de apoyo, barra antiempotramiento y luces
		for ( const s of [ - 1, 1 ] ) trailer.add( box( 0.12, 0.75, 0.12, steel, s * 0.85, 0.72, zF + 2.5 ) );
		trailer.add( box( tl.width - 0.2, 0.12, 0.12, steel, 0, 0.55, zR - 0.1 ) );
		const red = mat( 'lampRed', { color: C.lampRed, emissive: C.lampRed, emissiveIntensity: 0.35 } );
		trailer.add( box( 0.34, 0.12, 0.05, red, - tl.width / 2 + 0.3, 1.05, zR + 0.01 ), box( 0.34, 0.12, 0.05, red, tl.width / 2 - 0.3, 1.05, zR + 0.01 ) );
		const shadowL = new THREE.Mesh( new THREE.PlaneGeometry( tl.width + 0.9, tl.length + 1.0 ), shadowMat );
		shadowL.rotation.x = - Math.PI / 2;
		shadowL.position.set( 0, 0.07, ( zF + zR ) / 2 );
		shadowL.renderOrder = 1;
		trailer.add( shadowL );

	}

	const ax = {};
	let lean = 0, nod = 0;

	return {
		root, tractor, trailer, cab, eye, interior, exterior, mirrors,

		// Vista de cabina: se oculta la cabina exterior y se muestra el interior
		setCabinView( on ) { interior.visible = on; exterior.visible = ! on; },

		// De noche se encienden los focos: el haz sobre la calzada aparece según cuánta oscuridad haya
		setNight( darkness ) { beamMat.opacity = Math.max( 0, Math.min( 1, darkness ) ) * 0.85; beam.visible = beamMat.opacity > 0.02; },

		update( t, dt, travel ) {

			tractor.position.set( t.x, t.y, t.z );
			tractor.rotation.set( t.pitch, t.yaw, t.roll );
			if ( trailer ) {

				trailerAxleXZ( t, ax );
				trailer.position.set( ax.x, t.trailerY, ax.z );
				trailer.rotation.set( t.trailerPitch, t.trailerYaw, t.trailerRoll );

			}

			// la cabina cabecea al frenar y se inclina en las curvas
			const k = Math.min( 1, dt * 6 );
			nod += ( THREE.MathUtils.clamp( t.aLong * 0.004, - 0.025, 0.02 ) - nod ) * k;
			lean += ( THREE.MathUtils.clamp( - t.aLat * 0.012, - 0.035, 0.035 ) - lean ) * k;
			cab.rotation.set( nod, 0, lean );

			for ( const w of wheels ) w.spinner.rotation.x -= travel / w.radius;
			for ( const s of steer ) s.rotation.y = t.steer;
			swSpin.rotation.z = t.steer * 14;

		},

		dispose() {

			root.traverse( o => { if ( o.geometry ) o.geometry.dispose(); } );
			shadowMat.map.dispose(); shadowMat.dispose();
			beamTex.dispose(); beamMat.dispose();
			for ( const m of mirrors ) m.glass.material.dispose();

		},
	};

}
