// Ruta Sur · Fiat 600 D
// --------------------------------------------------------------------------
// Un Fiat 600 D (1960-1964) a escala, en tres niveles de detalle:
//   L0  para manejarlo: carrocería, interior, cuatro ruedas que giran y volante
//   L1  autos cercanos (estacionados o en tráfico), de una sola pieza
//   L2  autos lejanos, liviano, sin interior y apto para dibujar por instancias
//
// Convención de ejes, la misma de la física del juego: +Y arriba, el auto mira
// a -Z y el origen queda en el suelo, bajo el centro del eje trasero.
//
// Uso típico:
//   const assets = await loadFiat600( { renderer } );            // una vez, al cargar
//   const model = createFiat600Model( FIAT600_SPEC, assets );    // mismo contrato que createTruckModel
//   scene.add( model.root ); ... model.update( t, dt, travel );
//
// Medidas del modelo que el módulo necesita y los datos no traen (marco del juego):
//   espejo de puerta (izquierdo): cabeza de x -0,728 a -0,641, y 0,93 a 1,064, z -1,316 a -1,269; el vidrio mira a +Z
//   espejo interior: x ±0,117, y 1,196 a 1,280, z -1,449 a -1,377; el vidrio mira a +Z
//
// La geometría viaja comprimida en fiat600-data.js y se decodifica al cargar.

import * as THREE from 'three';
import { VEHICLES } from './physics.js';
import { FIAT600_DATA } from './fiat600-data.js';
import { decodeArrays, base64ToBytes, gunzip } from './fiat600-pack.js';

// La ficha para la física (medidas, motor, caja) está en physics.js, con los
// demás vehículos; las fuentes de cada valor están en el README.
export const FIAT600_SPEC = VEHICLES.fiat600;

// Tonos de época aproximados; no son códigos de fábrica.
export const FIAT600_PAINTS = [
	{ id: 'celeste', name: 'Celeste', hex: '#92b1ba' },
	{ id: 'marfil', name: 'Marfil', hex: '#e6dcc0' },
	{ id: 'verde', name: 'Verde claro', hex: '#a4c2a0' },
	{ id: 'gris', name: 'Gris perla', hex: '#9aa0a0' },
	{ id: 'coral', name: 'Rojo coral', hex: '#b93a2e' },
	{ id: 'azul', name: 'Azul oscuro', hex: '#22364f' },
	{ id: 'blanco', name: 'Blanco', hex: '#eeede6' },
	{ id: 'negro', name: 'Negro', hex: '#131416' },
];

// Punto de vista del conductor en el marco del auto [m]
const EYE = [ - 0.33, 1.09, - 0.94 ];
// Centro del balanceo de la carrocería sobre la suspensión
const ROLL_PIVOT = [ 0, 0.30, - 1.0 ];
// Vueltas de volante por radián de rueda (solo visual)
const STEERING_RATIO = 16;
// Espejos: centro del vidrio, tamaño y orientación de la cámara que dibuja en él. El lado -1 es el espejo de la puerta
// (el único exterior del auto, a la izquierda); el lado +1 es el espejo interior, que mira por la luneta.
const MIRRORS = [
	{ side: - 1, pos: [ - 0.684, 0.997, - 1.266 ], size: [ 0.095, 0.095 ], yaw: Math.PI - 0.12, pitch: - 0.07 },
	{ side: 1, pos: [ 0, 1.238, - 1.376 ], size: [ 0.20, 0.06 ], yaw: Math.PI, pitch: - 0.09 },
];
// Haz de los focos sobre la calzada, delante del auto: ancho, largo y centro en z
const BEAM = [ 6, 18, - 2.545 - 9.2 ];

// --------------------------------------------------------------------------
// Decodificación de la geometría (fiat600-pack.js) a mallas de Three.js
// --------------------------------------------------------------------------
export function decodePack( buffer ) {

	const { meshes, meta } = decodeArrays( buffer );
	const out = {};
	for ( const id in meshes ) {

		const m = meshes[ id ], g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( m.position, 3 ) );
		g.setAttribute( 'normal', new THREE.BufferAttribute( m.normal, 3 ) );
		if ( m.color ) g.setAttribute( 'color', new THREE.BufferAttribute( m.color, 3 ) );
		g.setIndex( new THREE.BufferAttribute( m.index, 1 ) );
		g.computeBoundingSphere();
		g.computeBoundingBox();
		out[ id ] = g;

	}

	return { geometries: out, meta };

}

// --------------------------------------------------------------------------
// Entorno para los reflejos: el cielo del juego, un suelo gris y el sol
// --------------------------------------------------------------------------
const SKY_DEFAULT = { top: 0x3f7fc4, horizon: 0xc9dbe6, ground: 0x77756f, sun: [ - 0.5, 1, 0.35 ] };

export function makeSkyEnvironment( renderer, sky = {} ) {

	const s = { ...SKY_DEFAULT, ...sky };
	const scene = new THREE.Scene();
	const dome = new THREE.Mesh( new THREE.SphereGeometry( 50, 32, 16 ), new THREE.ShaderMaterial( {
		side: THREE.BackSide, depthWrite: false,
		uniforms: { top: { value: new THREE.Color( s.top ) }, horizon: { value: new THREE.Color( s.horizon ) }, ground: { value: new THREE.Color( s.ground ) } },
		vertexShader: 'varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }',
		fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; varying vec3 vDir; void main() { float h = normalize( vDir ).y; vec3 c = h >= 0.0 ? mix( horizon, top, pow( h, 0.55 ) ) : mix( horizon, ground, smoothstep( 0.0, 0.12, - h ) ); gl_FragColor = vec4( c, 1.0 ); }',
	} ) );
	scene.add( dome );
	const sun = new THREE.Mesh( new THREE.SphereGeometry( 1.3, 16, 8 ), new THREE.MeshBasicMaterial( { color: new THREE.Color( 1, 0.95, 0.84 ).multiplyScalar( 24 ) } ) );
	sun.position.set( s.sun[ 0 ], s.sun[ 1 ], s.sun[ 2 ] ).normalize().multiplyScalar( 40 );
	scene.add( sun );
	const pmrem = new THREE.PMREMGenerator( renderer );
	const target = pmrem.fromScene( scene, 0.02, 0.1, 100 );
	pmrem.dispose();
	dome.geometry.dispose(); dome.material.dispose(); sun.geometry.dispose(); sun.material.dispose();
	return target;

}

function shadowTexture() {

	// mancha de sombra bajo el auto: rectángulo de bordes suaves
	if ( typeof document === 'undefined' ) return null;     // fuera del navegador (pruebas) no hay textura
	const c = document.createElement( 'canvas' );
	c.width = 64; c.height = 128;
	const g = c.getContext( '2d' );
	g.clearRect( 0, 0, 64, 128 );
	for ( let i = 0; i < 12; i ++ ) {

		g.fillStyle = 'rgba(0,0,0,0.065)';
		const p = i * 1.7;
		if ( g.roundRect ) { g.beginPath(); g.roundRect( p, p * 1.4, 64 - 2 * p, 128 - 2.8 * p, 14 ); g.fill(); }
		else g.fillRect( p, p * 1.4, 64 - 2 * p, 128 - 2.8 * p );

	}

	const t = new THREE.CanvasTexture( c );
	t.colorSpace = THREE.SRGBColorSpace;
	return t;

}

function beamTexture() {

	if ( typeof document === 'undefined' ) return null;
	const c = document.createElement( 'canvas' ); c.width = 64; c.height = 128;
	const g = c.getContext( '2d' );
	const grad = g.createLinearGradient( 0, 0, 0, 128 );
	grad.addColorStop( 0, 'rgba(255,240,200,0.0)' ); grad.addColorStop( 0.18, 'rgba(255,240,200,0.9)' ); grad.addColorStop( 1, 'rgba(255,240,200,0.0)' );
	g.fillStyle = grad; g.fillRect( 0, 0, 64, 128 );
	// más angosto hacia el auto
	g.globalCompositeOperation = 'destination-in';
	g.beginPath(); g.moveTo( 24, 128 ); g.lineTo( 40, 128 ); g.lineTo( 64, 0 ); g.lineTo( 0, 0 ); g.closePath(); g.fill();
	const t = new THREE.CanvasTexture( c ); t.colorSpace = THREE.SRGBColorSpace;
	return t;

}

// --------------------------------------------------------------------------
// Carga: decodifica una sola vez y prepara los materiales compartidos
// --------------------------------------------------------------------------
let pending = null;

// Fuerza de los reflejos de cada material compartido, de día. La pintura lleva la suya en paintMaterial.
const ENV_INTENSITY = { chrome: 1.1, metal: 0.9, gloss: 0.45, tail: 0.45, glass: 0.55, lensglass: 0.9, shine: 1.0 };
const PAINT_ENV = 0.5;
const envScale = assets => 0.2 + 0.8 * assets.lightLevel;

// Valores de cada material con y sin entorno de reflejos
function applyEnvironment( assets, envMap ) {

	const S = assets.shared, has = !! envMap;
	assets.envMap = envMap || null;
	const set = ( m, values ) => { Object.assign( m, values ); m.envMap = assets.envMap; m.needsUpdate = true; };
	set( S.chrome, has ? { metalness: 1, roughness: 0.07 } : { metalness: 0.2, roughness: 0.25 } );
	S.chrome.color.set( has ? 0xf2f3f4 : 0xc9ccd0 );
	set( S.metal, { metalness: has ? 0.55 : 0.1 } );
	set( S.gloss, {} ); set( S.tail, {} ); set( S.glass, {} ); set( S.lensglass, {} );
	// sin entorno, un espejo se vería negro: el nivel lejano pasa a un material mate
	set( S.shine, has ? { metalness: 1, roughness: 0.1 } : { metalness: 0, roughness: 0.6 } );
	for ( const p of assets.paints ) { p.envMap = assets.envMap; p.needsUpdate = true; }
	applyLightLevel( assets );

}

// El entorno se genera una vez, con el cielo de día; con la luz del momento (0 noche, 1 día) los reflejos se atenúan
function applyLightLevel( assets ) {

	const k = envScale( assets );
	for ( const name in ENV_INTENSITY ) assets.shared[ name ].envMapIntensity = ENV_INTENSITY[ name ] * k;
	for ( const p of assets.paints ) p.envMapIntensity = PAINT_ENV * k;

}

// opts.renderer  permite generar el entorno de reflejos (recomendado: sin él, los cromados se ven grises)
// opts.envMap    entorno propio, en lugar del generado
// opts.sky       colores { top, horizon, ground, sun } si el cielo del juego cambia
// La geometría se decodifica una sola vez. Si una llamada posterior trae `renderer` o `envMap` y aún no hay entorno,
// el entorno se agrega a lo ya cargado.
export function loadFiat600( opts = {} ) {

	if ( ! pending ) {

		const mine = pending = gunzip( base64ToBytes( FIAT600_DATA ) ).then( buffer => {

			const { geometries, meta } = decodePack( buffer );
			const shadowMap = shadowTexture();
			const blend = { transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor };
			// materiales que comparten todos los autos
			const shared = {
				chrome: new THREE.MeshStandardMaterial( { name: 'fiat-chrome' } ),
				metal: new THREE.MeshStandardMaterial( { name: 'fiat-metal', vertexColors: true, roughness: 0.42 } ),
				gloss: new THREE.MeshStandardMaterial( { name: 'fiat-gloss', vertexColors: true, metalness: 0, roughness: 0.22 } ),
				matte: new THREE.MeshLambertMaterial( { name: 'fiat-matte', vertexColors: true } ),
				tail: new THREE.MeshStandardMaterial( { name: 'fiat-tail', color: 0x8c0a08, emissive: 0xff1a05, emissiveIntensity: 0, metalness: 0, roughness: 0.22 } ),
				// vidrio: los reflejos se suman completos y lo que queda detrás se atenúa con la opacidad
				glass: new THREE.MeshStandardMaterial( { name: 'fiat-glass', color: 0x0a1010, metalness: 0, roughness: 0, opacity: 0.22, ...blend } ),
				lensglass: new THREE.MeshStandardMaterial( { name: 'fiat-lens', color: 0x1a1d1f, emissive: 0xffedc4, emissiveIntensity: 0, metalness: 0, roughness: 0.05, opacity: 0.18, ...blend } ),
				// nivel lejano: partes mate, y cromados y vidrios opacos como espejo teñido por el color del vértice
				rest: new THREE.MeshLambertMaterial( { name: 'fiat-rest', vertexColors: true } ),
				shine: new THREE.MeshStandardMaterial( { name: 'fiat-shine', vertexColors: true } ),
				shadow: new THREE.MeshBasicMaterial( { name: 'fiat-shadow', map: shadowMap, color: shadowMap ? 0xffffff : 0x000000, opacity: shadowMap ? 1 : 0.25, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: - 2, polygonOffsetUnits: - 2, fog: true } ),
			};
			const shadowGeometry = new THREE.PlaneGeometry( 1, 1 );
			shadowGeometry.rotateX( - Math.PI / 2 );
			const b = meta.bounds;
			let envTarget = null, disposed = false;
			const assets = {
				geometries, meta, shared, shadowGeometry,
				envMap: null,
				lightLevel: 1,             // luz del día (1) a noche (0): atenúa los reflejos
				paints: new Set(),         // pinturas vivas, para actualizarlas si cambia el entorno
				// huella de la sombra: [ancho, largo, centro en z]
				footprint: [ b.max[ 0 ] - b.min[ 0 ] + 0.45, b.max[ 2 ] - b.min[ 2 ] + 0.5, ( b.max[ 2 ] + b.min[ 2 ] ) / 2 ],

				// Cambia o agrega el entorno de reflejos. Acepta { envMap } o { renderer, sky }.
				setEnvironment( o = {} ) {

					if ( disposed ) return;
					let map = o.envMap || null, target = null;
					if ( ! map && o.renderer ) { target = makeSkyEnvironment( o.renderer, o.sky ); map = target.texture; }
					applyEnvironment( assets, map );
					if ( envTarget ) envTarget.dispose();
					envTarget = target;

				},

				// Luz del momento, de 0 (noche) a 1 (día): los reflejos del cielo se apagan con ella
				setLightLevel( level ) { assets.lightLevel = Math.max( 0, Math.min( 1, level ) ); applyLightLevel( assets ); },

				// Libera todo lo compartido. Llamar solo cuando ya no quede ningún Fiat en escena.
				dispose() {

					if ( disposed ) return;
					disposed = true;
					for ( const g of Object.values( geometries ) ) g.dispose();
					for ( const m of Object.values( shared ) ) m.dispose();
					if ( shadowMap ) shadowMap.dispose();
					shadowGeometry.dispose();
					if ( envTarget ) envTarget.dispose();
					if ( pending === mine ) pending = null;     // una carga posterior no se ve afectada por este objeto

				},
			};
			assets.setEnvironment( opts );
			return assets;

		} );
		mine.catch( () => { if ( pending === mine ) pending = null; } );
		return mine;

	}

	return pending.then( assets => {

		if ( ! assets.envMap && ( opts.envMap || opts.renderer ) ) assets.setEnvironment( opts );
		return assets;

	} );

}

// Pintura con barniz. Cada auto (o grupo de autos) tiene la suya, para poder cambiarle el color.
function paintMaterial( assets, hex ) {

	const m = new THREE.MeshPhysicalMaterial( { name: 'fiat-paint', color: hex, metalness: 0, roughness: 0.5, clearcoat: 1, clearcoatRoughness: 0.06, envMap: assets.envMap, envMapIntensity: PAINT_ENV * envScale( assets ) } );
	assets.paints.add( m );
	const dispose = m.dispose.bind( m );
	m.dispose = () => { assets.paints.delete( m ); dispose(); };
	return m;

}

function shadowMesh( assets ) {

	const m = new THREE.Mesh( assets.shadowGeometry, assets.shared.shadow );
	m.scale.set( assets.footprint[ 0 ], 1, assets.footprint[ 1 ] );
	m.position.set( 0, 0.04, assets.footprint[ 2 ] );
	m.renderOrder = 1;
	m.name = 'sombra';
	return m;

}

// Añade a `parent` las mallas de un grupo de geometrías ('L0.body', 'L1.car', ...)
function addMeshes( parent, assets, prefix, materials ) {

	for ( const id in assets.geometries ) {

		if ( ! id.startsWith( prefix + '.' ) ) continue;
		const group = id.slice( prefix.length + 1 );
		const material = materials[ group ] || assets.shared[ group ];
		if ( ! material ) throw new Error( `Fiat 600: falta el material "${ group }"` );
		const mesh = new THREE.Mesh( assets.geometries[ id ], material );
		mesh.name = id;
		if ( group === 'glass' || group === 'lensglass' ) mesh.renderOrder = 2;
		parent.add( mesh );

	}

}

// --------------------------------------------------------------------------
// Vehículo manejable. Devuelve lo mismo que createTruckModel:
//   { root, tractor, trailer, cab, eye, interior, exterior, setCabinView, update, dispose }
// y además setPaint( hex ), setWhitewall( on ) y setLights( on ).
// opts: { paint: '#92b1ba', whitewall: true, shadow: true }
// --------------------------------------------------------------------------
export function createFiat600Model( spec, assets, opts = {} ) {

	const meta = assets.meta, S = assets.shared;
	const root = new THREE.Group();
	root.name = 'Fiat 600';

	// materiales propios de este auto
	const paint = paintMaterial( assets, opts.paint ?? FIAT600_PAINTS[ 0 ].hex );
	const ipaint = new THREE.MeshLambertMaterial( { name: 'fiat-ipaint', color: paint.color } );
	const whitewall = new THREE.MeshLambertMaterial( { name: 'fiat-whitewall' } );
	const tail = S.tail.clone(), lens = S.lensglass.clone();
	const own = { paint, ipaint, whitewall, tail, lensglass: lens };

	// todo lo que sigue al terreno: orden de giro YXZ como en el camión
	const tractor = new THREE.Group();
	tractor.rotation.order = 'YXZ';
	root.add( tractor );

	// carrocería: se balancea sobre la suspensión respecto de las ruedas
	const cab = new THREE.Group();
	cab.position.set( ROLL_PIVOT[ 0 ], ROLL_PIVOT[ 1 ], ROLL_PIVOT[ 2 ] );
	tractor.add( cab );
	const body = new THREE.Group();          // marco del auto dentro de la carrocería
	body.position.copy( cab.position ).negate();
	cab.add( body );
	addMeshes( body, assets, 'L0.body', own );

	// El camión muestra un interior simplificado en la vista de cabina y oculta el exterior.
	// Aquí el interior es parte del modelo y se ve siempre: los dos grupos existen por compatibilidad.
	const interior = new THREE.Group(), exterior = new THREE.Group();
	body.add( interior, exterior );

	// volante
	const sw = new THREE.Group();
	sw.position.fromArray( meta.steering.pos );
	sw.rotation.x = meta.steering.tilt;       // columna inclinada hacia el conductor
	const swSpin = new THREE.Group();
	sw.add( swSpin );
	addMeshes( swSpin, assets, 'L0.steer', own );
	body.add( sw );

	// punto de vista del conductor
	const eye = new THREE.Object3D();
	eye.position.fromArray( EYE );
	body.add( eye );

	// ruedas: no se balancean con la carrocería
	// el giro visual usa el mismo radio que la física, para que rueda y avance coincidan
	const wheels = [], steer = [];
	const R = ( spec && spec.engine && spec.engine.wheelRadius ) || meta.tyreRadius;
	for ( const w of meta.wheels ) {

		const holder = new THREE.Group();
		holder.position.set( w.x, meta.wheelY, w.z );
		if ( w.mirror ) holder.scale.x = - 1;   // la rueda izquierda es el espejo de la derecha
		const spinner = new THREE.Group();
		holder.add( spinner );
		addMeshes( spinner, assets, 'L0.wheel', own );
		tractor.add( holder );
		wheels.push( { spinner, radius: R } );
		if ( w.steer ) steer.push( holder );

	}

	let shadow = null;
	if ( opts.shadow !== false ) { shadow = shadowMesh( assets ); tractor.add( shadow ); }

	// Espejos: un vidrio donde el juego pega la imagen de su cámara, y el anclaje de esa cámara.
	// La textura del juego es vertical (ancho : alto = 1 : 2); cada vidrio muestra la franja central que le corresponde.
	const mirrors = [];
	for ( const M of MIRRORS ) {

		const g = new THREE.PlaneGeometry( M.size[ 0 ], M.size[ 1 ] );
		const span = M.size[ 1 ] / M.size[ 0 ] / 2, uv = g.getAttribute( 'uv' );   // alto relativo del recorte, sobre la textura 1 : 2
		for ( let i = 0; i < uv.count; i ++ ) uv.setY( i, 0.5 + ( uv.getY( i ) - 0.5 ) * span );
		const glass = new THREE.Mesh( g, new THREE.MeshBasicMaterial( { color: 0x8d9aa4, toneMapped: false } ) );
		glass.position.fromArray( M.pos );
		glass.name = 'espejo';
		body.add( glass );
		const anchor = new THREE.Object3D();
		anchor.position.fromArray( M.pos );
		anchor.rotation.order = 'YXZ';
		anchor.rotation.y = M.yaw; anchor.rotation.x = M.pitch;
		body.add( anchor );
		mirrors.push( { side: M.side, glass, anchor } );

	}

	// haz de los focos sobre la calzada: se suma a la luz y de día no se ve
	const beamTex = beamTexture();
	const beamMat = new THREE.MeshBasicMaterial( { map: beamTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, color: beamTex ? 0xffffff : 0x000000 } );
	const beam = new THREE.Mesh( new THREE.PlaneGeometry( BEAM[ 0 ], BEAM[ 1 ] ), beamMat );
	beam.name = 'haz';
	beam.rotation.x = - Math.PI / 2;
	beam.position.set( 0, 0.06, BEAM[ 2 ] );
	beam.renderOrder = 2;
	beam.visible = false;
	tractor.add( beam );

	let lean = 0, nod = 0, lightsOn = false, brake = 0;

	function applyLights() {

		tail.emissiveIntensity = Math.max( lightsOn ? 0.45 : 0, brake * 1.3 );
		lens.emissiveIntensity = lightsOn ? 1.4 : 0;
		lens.opacity = lightsOn ? 0.5 : S.lensglass.opacity;

	}

	const model = {
		root, tractor, trailer: null, cab, eye, interior, exterior, mirrors, body, wheels, steeringWheel: swSpin,

		setCabinView() { /* el interior está siempre presente */ },

		// De noche se encienden los focos y aparece el haz sobre la calzada, según cuánta oscuridad haya (0 a 1)
		setNight( darkness ) {

			const d = Math.max( 0, Math.min( 1, darkness ) );
			beamMat.opacity = d * 0.8; beam.visible = beamMat.opacity > 0.02;
			const on = d > 0.35;
			if ( on !== lightsOn ) { lightsOn = on; applyLights(); }

		},

		setPaint( hex ) { paint.color.set( hex ); ipaint.color.copy( paint.color ); },

		// neumáticos con banda blanca, opcional de época
		setWhitewall( on ) { whitewall.color.set( on ? 0xe8e5dc : 0x050505 ); },

		setLights( on ) { lightsOn = !! on; applyLights(); },

		// t: estado de la física ( x, y, z, yaw, pitch, roll, steer y, si existen, aLong, aLat, v, brake )
		update( t, dt, travel ) {

			tractor.position.set( t.x, t.y, t.z );
			tractor.rotation.set( t.pitch, t.yaw, t.roll );
			if ( ! ( dt > 0 ) ) dt = 0;
			if ( ! Number.isFinite( travel ) ) travel = 0;
			const aLong = Number.isFinite( t.aLong ) ? t.aLong : 0, aLat = Number.isFinite( t.aLat ) ? t.aLat : 0;

			// la carrocería cabecea al frenar y se inclina en las curvas
			const k = Math.min( 1, dt * 6 );
			nod += ( THREE.MathUtils.clamp( aLong * 0.005, - 0.022, 0.018 ) - nod ) * k;
			lean += ( THREE.MathUtils.clamp( - aLat * 0.011, - 0.032, 0.032 ) - lean ) * k;
			cab.rotation.set( nod, 0, lean );

			for ( const w of wheels ) w.spinner.rotation.x -= travel / w.radius;
			for ( const s of steer ) s.rotation.y = t.steer;
			swSpin.rotation.z = t.steer * STEERING_RATIO;

			// Luz de freno. Lo exacto es el pedal ( t.brake, de 0 a 1 ). Si la física no lo informa se estima con la
			// desaceleración en el sentido de marcha; el umbral queda sobre la retención del motor, para que no la encienda.
			let braking;
			if ( t.brake !== undefined ) braking = t.brake > 0.05;
			else if ( Number.isFinite( t.v ) ) braking = Math.abs( t.v ) > 0.3 && - aLong * Math.sign( t.v ) > 1.5;
			else braking = aLong < - 1.5;
			const b = braking ? 1 : 0;
			if ( b !== brake ) { brake = b; applyLights(); }

		},

		// Libera lo propio de este auto. La geometría es compartida y la libera assets.dispose().
		dispose() {

			for ( const m of Object.values( own ) ) m.dispose();
			for ( const m of mirrors ) { m.glass.geometry.dispose(); m.glass.material.dispose(); }
			beam.geometry.dispose(); beamMat.dispose(); if ( beamTex ) beamTex.dispose();
			root.removeFromParent();

		},
	};

	model.setWhitewall( opts.whitewall !== false );
	applyLights();
	return model;

}

// --------------------------------------------------------------------------
// Auto de ambientación, estático: nivel medio de cerca y nivel lejano después.
// opts: { paint, whitewall: false, switchDistance: 45, shadow: true }
// Devuelve { object, setPaint, dispose }. `object` es un THREE.LOD: basta con
// ubicarlo ( position, rotation.y = rumbo ) y agregarlo a la escena.
// --------------------------------------------------------------------------
// Desplazamiento del centro del auto respecto del origen (bajo el eje trasero), en z. Un auto de tráfico del juego
// tiene su origen en el centro de la planta: basta con mover el objeto este valor hacia adelante.
export function fiat600CenterZ( assets ) { const b = assets.meta.bounds; return ( b.min[ 2 ] + b.max[ 2 ] ) / 2; }

export function createFiat600Prop( assets, opts = {} ) {

	const paint = paintMaterial( assets, opts.paint ?? FIAT600_PAINTS[ 0 ].hex );
	const whitewall = new THREE.MeshLambertMaterial( { name: 'fiat-whitewall', color: opts.whitewall ? 0xe8e5dc : 0x050505 } );

	const near = new THREE.Group(), far = new THREE.Group();
	addMeshes( near, assets, 'L1.car', { paint, whitewall } );
	addMeshes( far, assets, 'L2.car', { paint } );

	const lod = new THREE.LOD();
	lod.name = 'Fiat 600';
	lod.addLevel( near, 0 );
	lod.addLevel( far, opts.switchDistance ?? 45, 0.1 );     // 10 % de holgura, para que no alterne en el borde
	if ( opts.shadow !== false ) lod.add( shadowMesh( assets ) );

	return {
		object: lod,
		setPaint( h ) { paint.color.set( h ); },
		dispose() { paint.dispose(); whitewall.dispose(); lod.removeFromParent(); },
	};

}

// --------------------------------------------------------------------------
// Muchos autos a la vez: el nivel lejano se dibuja por instancias (tres
// llamadas de dibujo para todos, o cuatro con sombra) y los más cercanos a la
// cámara se cambian por el nivel medio.
// opts: { capacity: 256, near: 6, nearDistance: 40, shadow: true }
// Las posiciones son locales al grupo `crowd.object`. `add` devuelve -1 si no
// queda capacidad. Los identificadores se reutilizan: tras `remove( id )`, ese
// número puede pasar a otro auto.
//   const crowd = createFiat600Crowd( assets ); scene.add( crowd.object );
//   const id = crowd.add( { x, y, z, yaw, paint: '#e6dcc0' } );
//   crowd.set( id, { x, y, z, yaw } );      // si el auto se mueve
//   crowd.update( camera );                 // una vez por cuadro
// --------------------------------------------------------------------------
export function createFiat600Crowd( assets, opts = {} ) {

	const capacity = opts.capacity ?? 256, nearCount = opts.near ?? 6, nearDistance = opts.nearDistance ?? 40;
	const G = assets.geometries;
	const object = new THREE.Group();
	object.name = 'Fiat 600 (varios)';

	const paintMat = paintMaterial( assets, 0xffffff );       // el color de cada auto va por instancia
	const bodyMesh = new THREE.InstancedMesh( G[ 'L2.car.paint' ], paintMat, capacity );
	const restMesh = new THREE.InstancedMesh( G[ 'L2.car.rest' ], assets.shared.rest, capacity );
	const shineMesh = new THREE.InstancedMesh( G[ 'L2.car.shine' ], assets.shared.shine, capacity );
	const meshes = [ bodyMesh, restMesh, shineMesh ];
	let shadowInst = null;
	if ( opts.shadow !== false ) {

		const sg = assets.shadowGeometry.clone();
		sg.scale( assets.footprint[ 0 ], 1, assets.footprint[ 1 ] );
		sg.translate( 0, 0.04, assets.footprint[ 2 ] );
		shadowInst = new THREE.InstancedMesh( sg, assets.shared.shadow, capacity );
		shadowInst.renderOrder = 1;
		meshes.push( shadowInst );

	}

	for ( const m of meshes ) { m.count = 0; m.instanceMatrix.setUsage( THREE.DynamicDrawUsage ); object.add( m ); }
	bodyMesh.setColorAt( 0, new THREE.Color( 1, 1, 1 ) );       // crea el atributo de color por instancia

	// autos de nivel medio que se asignan a los más cercanos
	const pool = [];
	for ( let i = 0; i < nearCount; i ++ ) {

		const paint = paintMaterial( assets, 0xffffff );
		const whitewall = new THREE.MeshLambertMaterial( { name: 'fiat-whitewall', color: 0x050505 } );
		const car = new THREE.Group();
		car.rotation.order = 'YXZ';
		addMeshes( car, assets, 'L1.car', { paint, whitewall } );
		if ( opts.shadow !== false ) car.add( shadowMesh( assets ) );
		car.visible = false;
		object.add( car );
		pool.push( { car, paint, whitewall, id: - 1 } );

	}

	// estado de cada auto
	const cars = [];                       // { x, y, z, yaw, pitch, roll, color, alive, near }
	const free = [];
	const slots = [];                      // posición en las mallas instanciadas -> id
	const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler( 0, 0, 0, 'YXZ' ), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _cam = new THREE.Vector3();
	let dirty = true;

	// Un auto que se muestra con el nivel medio queda en la malla instanciada con escala cero, en su propio lugar,
	// para que la esfera envolvente del conjunto siga ajustada a los autos.
	function matrixOf( c, hidden ) {

		_e.set( c.pitch, c.yaw, c.roll );
		return _m.compose( _p.set( c.x, c.y, c.z ), _q.setFromEuler( _e ), hidden ? _s.set( 0, 0, 0 ) : _s.set( 1, 1, 1 ) );

	}

	function writeSlot( slot ) {

		const c = cars[ slots[ slot ] ];
		const m = matrixOf( c, c.near >= 0 );
		for ( const im of meshes ) im.setMatrixAt( slot, m );
		bodyMesh.setColorAt( slot, c.color );
		dirty = true;

	}

	function placeNear( c ) {

		const p = pool[ c.near ];
		p.car.position.set( c.x, c.y, c.z );
		p.car.rotation.set( c.pitch, c.yaw, c.roll );

	}

	const crowd = {
		object,
		get count() { return slots.length; },

		// Agrega un auto y devuelve su identificador. yaw: rumbo, con la misma convención del camión.
		add( { x = 0, y = 0, z = 0, yaw = 0, pitch = 0, roll = 0, paint = FIAT600_PAINTS[ 0 ].hex } = {} ) {

			if ( paint === null ) paint = FIAT600_PAINTS[ 0 ].hex;

			if ( slots.length >= capacity ) return - 1;
			const id = free.length ? free.pop() : cars.length;
			cars[ id ] = { x, y, z, yaw, pitch, roll, color: new THREE.Color( paint ), alive: true, near: - 1, slot: slots.length };
			slots.push( id );
			for ( const im of meshes ) im.count = slots.length;
			writeSlot( slots.length - 1 );
			return id;

		},

		set( id, v ) {

			const c = cars[ id ];
			if ( ! c || ! c.alive ) return;
			if ( v.x !== undefined ) c.x = v.x; if ( v.y !== undefined ) c.y = v.y; if ( v.z !== undefined ) c.z = v.z;
			if ( v.yaw !== undefined ) c.yaw = v.yaw; if ( v.pitch !== undefined ) c.pitch = v.pitch; if ( v.roll !== undefined ) c.roll = v.roll;
			if ( v.paint !== undefined ) { c.color.set( v.paint ); if ( c.near >= 0 ) pool[ c.near ].paint.color.copy( c.color ); }
			if ( c.near >= 0 ) placeNear( c ); else writeSlot( c.slot );

		},

		remove( id ) {

			const c = cars[ id ];
			if ( ! c || ! c.alive ) return;
			if ( c.near >= 0 ) { pool[ c.near ].car.visible = false; pool[ c.near ].id = - 1; }
			// el último auto ocupa el lugar del que se va
			const last = slots.length - 1, moved = slots[ last ];
			slots[ c.slot ] = moved; cars[ moved ].slot = c.slot;
			slots.pop();
			if ( c.slot < slots.length ) writeSlot( c.slot );
			for ( const im of meshes ) im.count = slots.length;
			c.alive = false; free.push( id );
			dirty = true;

		},

		// Elige qué autos se ven con el nivel medio. Llamar una vez por cuadro.
		update( camera ) {

			if ( pool.length ) {

				// posición de la cámara en el marco del grupo, por si el grupo o la cámara cuelgan de otro objeto
				camera.updateWorldMatrix( true, false );
				object.updateWorldMatrix( true, false );
				object.worldToLocal( _cam.setFromMatrixPosition( camera.matrixWorld ) );
				const cx = _cam.x, cy = _cam.y, cz = _cam.z, lim = nearDistance * nearDistance;
				// los `pool.length` más cercanos dentro del radio
				const best = [];
				for ( let s = 0; s < slots.length; s ++ ) {

					const c = cars[ slots[ s ] ];
					let d = ( c.x - cx ) ** 2 + ( c.y - cy ) ** 2 + ( c.z - cz ) ** 2;
					// Un auto que ya está en nivel medio se mantiene hasta un 10 % más lejos y solo cede su lugar a otro
					// que esté un 15 % más cerca. Así dos autos a distancias parecidas no alternan de nivel.
					if ( c.near >= 0 ) { if ( d > lim * 1.21 ) continue; d *= 0.7225; } else if ( d > lim ) continue;
					let i = best.length;
					while ( i > 0 && best[ i - 1 ].d > d ) i --;
					if ( i < pool.length ) { best.splice( i, 0, { id: slots[ s ], d } ); if ( best.length > pool.length ) best.pop(); }

				}

				const wanted = new Set( best.map( b => b.id ) );
				for ( const p of pool ) {

					if ( p.id >= 0 && ! wanted.has( p.id ) ) { const c = cars[ p.id ]; c.near = - 1; p.id = - 1; p.car.visible = false; if ( c.alive ) writeSlot( c.slot ); }

				}

				for ( const b of best ) {

					const c = cars[ b.id ];
					if ( c.near >= 0 ) continue;
					const i = pool.findIndex( p => p.id < 0 );
					if ( i < 0 ) break;
					const p = pool[ i ];
					p.id = b.id; c.near = i;
					p.paint.color.copy( c.color );
					p.car.visible = true;
					placeNear( c );
					writeSlot( c.slot );

				}

			}

			if ( dirty ) {

				for ( const im of meshes ) { im.instanceMatrix.needsUpdate = true; im.computeBoundingSphere(); }
				if ( bodyMesh.instanceColor ) bodyMesh.instanceColor.needsUpdate = true;
				dirty = false;

			}

		},

		dispose() {

			for ( const p of pool ) { p.paint.dispose(); p.whitewall.dispose(); }
			paintMat.dispose();
			if ( shadowInst ) shadowInst.geometry.dispose();
			for ( const im of meshes ) im.dispose();
			object.removeFromParent();

		},
	};

	return crowd;

}
