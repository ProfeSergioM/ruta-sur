// Pruebas del módulo del Fiat 600 sin navegador. Ejecutar: node tests/fiat600.test.mjs
// Comprueban los datos empaquetados, el marco de referencia que espera la física del juego
// y el contrato del modelo ( el mismo de createTruckModel ).
import * as THREE from 'three';
import { loadFiat600, createFiat600Model, createFiat600Prop, createFiat600Crowd, FIAT600_SPEC, FIAT600_PAINTS } from '../src/fiat600.js';

let fail = 0;
const fmt = v => ( typeof v === 'number' ? ( Math.round( v * 1000 ) / 1000 ).toString() : String( v ) );
function check( name, value, expected, tol = 0, unit = '' ) { const ok = Math.abs( value - expected ) <= tol; if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }: ${ fmt( value ) }${ unit } (esperado ${ fmt( expected ) }${ tol ? ' ± ' + fmt( tol ) : '' })` ); }
function within( name, value, lo, hi, unit = '' ) { const ok = value >= lo && value <= hi; if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }: ${ fmt( value ) }${ unit } (entre ${ fmt( lo ) } y ${ fmt( hi ) })` ); }
function truthy( name, ok, detail = '' ) { if ( ! ok ) fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ detail ? ': ' + detail : '' }` ); }
function info( name, value ) { console.log( `info  ${ name }: ${ value }` ); }

const t0 = performance.now();
const assets = await loadFiat600();
info( 'Decodificación de los tres niveles', ( performance.now() - t0 ).toFixed( 0 ) + ' ms' );
const G = assets.geometries, meta = assets.meta;

// === 1. Datos ================================================================
{

	const ids = Object.keys( G );
	truthy( 'Hay mallas para los tres niveles', [ 'L0.body.paint', 'L0.wheel.matte', 'L0.steer.gloss', 'L1.car.paint', 'L2.car.paint', 'L2.car.rest', 'L2.car.shine' ].every( id => ids.includes( id ) ), ids.length + ' mallas' );
	let bad = 0, tris = { L0: 0, L1: 0, L2: 0 };
	for ( const id of ids ) {

		const g = G[ id ], p = g.attributes.position, n = g.attributes.normal, idx = g.index;
		for ( let i = 0; i < p.array.length; i ++ ) if ( ! Number.isFinite( p.array[ i ] ) ) bad ++;
		for ( let i = 0; i < n.count; i ++ ) { const l = Math.hypot( n.getX( i ), n.getY( i ), n.getZ( i ) ); if ( Math.abs( l - 1 ) > 1e-3 ) bad ++; }
		for ( let i = 0; i < idx.count; i ++ ) if ( idx.array[ i ] >= p.count ) bad ++;
		if ( g.attributes.color ) for ( let i = 0; i < g.attributes.color.array.length; i ++ ) { const c = g.attributes.color.array[ i ]; if ( ! ( c >= 0 && c <= 1 ) ) bad ++; }
		tris[ id.slice( 0, 2 ) ] += idx.count / 3;

	}

	check( 'Posiciones finitas, normales unitarias, índices y colores en rango', bad, 0 );
	const wheelTris = ids.filter( id => id.startsWith( 'L0.wheel.' ) ).reduce( ( a, id ) => a + G[ id ].index.count / 3, 0 );
	check( 'Triángulos del nivel 0 (con las cuatro ruedas)', tris.L0 + 3 * wheelTris, meta.triangles.L0 );
	check( 'Triángulos del nivel 1', tris.L1, meta.triangles.L1 );
	check( 'Triángulos del nivel 2', tris.L2, meta.triangles.L2 );
	within( 'Nivel 0: presupuesto de triángulos', meta.triangles.L0, 60000, 110000 );
	within( 'Nivel 1: presupuesto de triángulos', meta.triangles.L1, 10000, 25000 );
	within( 'Nivel 2: presupuesto de triángulos', meta.triangles.L2, 2000, 6000 );

}

// === 2. Marco de referencia ==================================================
// +Y arriba, el auto mira a -Z, origen en el suelo bajo el centro del eje trasero.
function boxOf( object ) {

	const box = new THREE.Box3(), v = new THREE.Vector3();
	object.updateMatrixWorld( true );
	object.traverse( o => { if ( o.isMesh && o.name !== 'sombra' && o.name !== 'haz' ) { const p = o.geometry.attributes.position; for ( let i = 0; i < p.count; i ++ ) box.expandByPoint( v.fromBufferAttribute( p, i ).applyMatrix4( o.matrixWorld ) ); } } );
	return box;

}

const still = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0, steer: 0, v: 0, aLong: 0, aLat: 0 };
const model = createFiat600Model( FIAT600_SPEC, assets );

// === 2b. Lo que el juego pide además del contrato del camión =================
{

	truthy( 'Dos espejos, uno por lado, con vidrio y anclaje de cámara', model.mirrors.length === 2 && [ - 1, 1 ].every( s => { const m = model.mirrors.find( x => x.side === s ); return m && m.glass.isMesh && m.anchor.isObject3D; } ) );
	const left = model.mirrors.find( m => m.side === - 1 ), inner = model.mirrors.find( m => m.side === 1 );
	within( 'El espejo de la puerta queda fuera de la carrocería, a la izquierda', left.glass.position.x, - 0.75, - 0.62, ' m' );
	within( 'El espejo interior va centrado, bajo el techo', inner.glass.position.y, 1.15, 1.30, ' m' );
	const dir = new THREE.Vector3( 0, 0, - 1 ).applyEuler( left.anchor.rotation );
	truthy( 'La cámara del espejo mira hacia atrás y un poco hacia afuera', dir.z > 0.95 && dir.x < - 0.05, `(${ dir.x.toFixed( 2 ) }, ${ dir.z.toFixed( 2 ) })` );
	const lens = model.body.children.find( o => o.name === 'L0.body.lensglass' ).material;
	model.setNight( 0 );
	check( 'De día los focos están apagados', lens.emissiveIntensity, 0 );
	model.setNight( 1 );
	truthy( 'De noche los focos se encienden y aparece el haz sobre la calzada', lens.emissiveIntensity > 1 && model.tractor.children.some( o => o.material && o.material.blending === THREE.AdditiveBlending && o.visible ) );
	model.setNight( 0 );

}
model.update( still, 1, 0 );
{

	const b = boxOf( model.tractor );
	check( 'Frente del auto (parachoques delantero)', b.min.z, - ( FIAT600_SPEC.tractor.wheelbase + FIAT600_SPEC.tractor.frontOverhang ), 0.006, ' m' );
	check( 'Cola del auto (parachoques trasero)', b.max.z, FIAT600_SPEC.tractor.rearOverhang, 0.006, ' m' );
	check( 'Largo total', b.max.z - b.min.z, 3.295, 0.006, ' m' );
	check( 'Alto', b.max.y, 1.405, 0.006, ' m' );
	within( 'Los neumáticos tocan el suelo', b.min.y, - 0.006, 0.002, ' m' );
	within( 'Ancho de carrocería, lado derecho', b.max.x, 0.685, 0.70, ' m' );
	for ( const level of [ 'L1', 'L2' ] ) {

		const prop = createFiat600Prop( assets, { switchDistance: level === 'L1' ? 1e9 : 1e-3, shadow: false } );
		const group = prop.object.levels[ level === 'L1' ? 0 : 1 ].object, bb = boxOf( group );
		// el nivel lejano no lleva los topes de los parachoques, que suman 43 mm en cada extremo
		const tips = level === 'L2' ? 0.043 : 0;
		check( `Nivel ${ level[ 1 ] }: largo total`, bb.max.z - bb.min.z, 3.295 - 2 * tips, 0.012, ' m' );
		check( `Nivel ${ level[ 1 ] }: frente en -Z`, bb.min.z, - 2.545 + tips, 0.012, ' m' );
		check( `Nivel ${ level[ 1 ] }: alto`, bb.max.y, 1.405, 0.012, ' m' );
		within( `Nivel ${ level[ 1 ] }: apoyado en el suelo`, bb.min.y, - 0.012, 0.004, ' m' );
		prop.dispose();

	}

}

// === 3. Contrato del modelo ==================================================
{

	const keys = [ 'root', 'tractor', 'trailer', 'cab', 'eye', 'interior', 'exterior', 'setCabinView', 'update', 'dispose' ];
	truthy( 'Mismos campos que createTruckModel', keys.every( k => k in model ), keys.filter( k => ! ( k in model ) ).join( ', ' ) );
	truthy( 'Sin semirremolque y con orden de giro YXZ', model.trailer === null && model.tractor.rotation.order === 'YXZ' );
	const p = new THREE.Vector3();
	const want = [ [ 0.575, 0.27, - 2 ], [ - 0.575, 0.27, - 2 ], [ 0.58, 0.27, 0 ], [ - 0.58, 0.27, 0 ] ];
	let worst = 0;
	model.wheels.forEach( ( w, i ) => { w.spinner.getWorldPosition( p ); worst = Math.max( worst, p.distanceTo( new THREE.Vector3( ...want[ i ] ) ) ); } );
	check( 'Centros de rueda según trochas y distancia entre ejes', worst, 0, 1e-6, ' m' );
	check( 'Distancia entre ejes igual a la de la ficha', Math.abs( want[ 0 ][ 2 ] - want[ 2 ][ 2 ] ), FIAT600_SPEC.tractor.wheelbase );
	check( 'Trocha delantera igual a la de la ficha', want[ 0 ][ 0 ] * 2, FIAT600_SPEC.tractor.track, 1e-9 );

	// giro de ruedas: avance positivo hace rodar hacia adelante
	const r0 = model.wheels[ 0 ].spinner.rotation.x;
	model.update( still, 1 / 60, 0.5 );
	check( 'Las ruedas giran travel / radio, con el radio de la ficha', model.wheels[ 0 ].spinner.rotation.x - r0, - 0.5 / FIAT600_SPEC.engine.wheelRadius, 1e-9, ' rad' );
	within( 'El radio de la ficha difiere poco del radio del neumático dibujado', Math.abs( FIAT600_SPEC.engine.wheelRadius - meta.tyreRadius ), 0, 0.006, ' m' );
	const sp = model.wheels[ 2 ].spinner;
	sp.rotation.x = 0; model.root.updateMatrixWorld( true );
	const a = sp.localToWorld( new THREE.Vector3( 0, 0.1, 0 ) );
	model.update( still, 1 / 60, 0.05 ); model.root.updateMatrixWorld( true );
	const b = sp.localToWorld( new THREE.Vector3( 0, 0.1, 0 ) );
	within( 'Al avanzar, la parte alta de la rueda se mueve hacia -Z', b.z - a.z, - 0.03, - 0.01, ' m' );

	// dirección
	model.update( { ...still, steer: 0.3 }, 1 / 60, 0 );
	const sy = model.wheels.map( w => w.spinner.parent.rotation.y );
	truthy( 'Solo las ruedas delanteras siguen a t.steer', sy[ 0 ] === 0.3 && sy[ 1 ] === 0.3 && sy[ 2 ] === 0 && sy[ 3 ] === 0, sy.join( ', ' ) );
	// con steer > 0 (izquierda) el frente de la rueda apunta a -X
	model.root.updateMatrixWorld( true );
	const f0 = model.wheels[ 0 ].spinner.parent.localToWorld( new THREE.Vector3( 0, 0, - 1 ) ).sub( model.wheels[ 0 ].spinner.parent.getWorldPosition( new THREE.Vector3() ) );
	within( 'Con t.steer > 0 las ruedas apuntan a la izquierda (-X)', f0.x, - 0.31, - 0.28 );

	// volante: gira con la dirección y, visto por el conductor, en sentido antihorario al doblar a la izquierda
	check( 'El volante sigue a t.steer', model.steeringWheel.rotation.z, 0.3 * 16, 1e-9, ' rad' );
	{

		const sw = model.steeringWheel;
		const hub = sw.getWorldPosition( new THREE.Vector3() );
		const axis = sw.localToWorld( new THREE.Vector3( 0, 0, 1 ) ).sub( hub );            // del volante hacia el conductor
		truthy( 'El eje del volante apunta al conductor (atrás y arriba)', axis.z > 0.7 && axis.y > 0.4 && Math.abs( axis.x ) < 1e-6, axis.toArray().map( fmt ).join( ', ' ) );
		model.update( { ...still, steer: 0.05 }, 1 / 60, 0 ); model.root.updateMatrixWorld( true );
		const top = sw.localToWorld( new THREE.Vector3( 0, 0.2, 0 ) );                     // punto que con las ruedas rectas queda arriba
		within( 'Al doblar a la izquierda, la parte alta del volante va a la izquierda (-X)', top.x - hub.x, - 0.2, - 0.1, ' m' );
		model.update( { ...still, steer: 0.3 }, 1 / 60, 0 ); model.root.updateMatrixWorld( true );

	}

	// rumbo y cabeceo con la convención del camión
	model.update( { ...still, yaw: Math.PI / 2 }, 1 / 60, 0 ); model.root.updateMatrixWorld( true );
	const nose = model.tractor.localToWorld( new THREE.Vector3( 0, 0.5, - 2.5 ) );
	check( 'Con yaw = 90° el frente apunta a -X', nose.x, - 2.5, 1e-9, ' m' );
	model.update( { ...still, pitch: 0.1 }, 1 / 60, 0 ); model.root.updateMatrixWorld( true );
	within( 'Cabeceo positivo levanta la trompa', model.tractor.localToWorld( new THREE.Vector3( 0, 0, - 2 ) ).y, 0.19, 0.21, ' m' );
	model.update( { ...still, x: 12, y: 3, z: - 7 }, 1 / 60, 0 );
	truthy( 'La posición sigue a t.x, t.y, t.z', model.tractor.position.equals( new THREE.Vector3( 12, 3, - 7 ) ) );

	// ojo del conductor: a la izquierda, a la altura del parabrisas
	model.update( still, 1, 0 ); model.root.updateMatrixWorld( true );
	const eye = model.eye.getWorldPosition( new THREE.Vector3() );
	within( 'Ojo del conductor: lado izquierdo', eye.x, - 0.40, - 0.25, ' m' );
	within( 'Ojo del conductor: altura', eye.y, 1.0, 1.15, ' m' );
	const ahead = model.eye.localToWorld( new THREE.Vector3( 0, 0, - 1 ) ).sub( eye );
	check( 'Ojo del conductor: mira hacia -Z', ahead.z, - 1, 1e-6 );

	// balanceo de la carrocería: acotado, y las ruedas no lo siguen
	for ( let i = 0; i < 200; i ++ ) model.update( { ...still, aLat: 9, aLong: - 9 }, 1 / 60, 0 );
	within( 'Inclinación máxima de la carrocería en curva', Math.abs( model.cab.rotation.z ), 0.02, 0.035, ' rad' );
	within( 'Cabeceo máximo al frenar', Math.abs( model.cab.rotation.x ), 0.015, 0.025, ' rad' );
	check( 'Las ruedas siguen al terreno, no a la carrocería', model.wheels[ 0 ].spinner.parent.parent === model.tractor ? 1 : 0, 1 );

	// pintura, luces y banda blanca
	model.setPaint( '#b93a2e' );
	let paintMat = null, tailMat = null, ww = null;
	model.root.traverse( o => { if ( o.isMesh ) { if ( o.material.name === 'fiat-paint' ) paintMat = o.material; if ( o.material.name === 'fiat-tail' ) tailMat = o.material; if ( o.material.name === 'fiat-whitewall' ) ww = o.material; } } );
	truthy( 'setPaint cambia el color de la carrocería', paintMat.color.getHexString() === new THREE.Color( '#b93a2e' ).getHexString() );
	model.setLights( false ); model.update( { ...still, v: 10, aLong: - 3, brake: 1 }, 1 / 60, 0 );
	const braking = tailMat.emissiveIntensity;
	model.update( { ...still, v: 10, aLong: 0, brake: 0 }, 1 / 60, 0 );
	truthy( 'La luz de freno se enciende al frenar y se apaga al soltar', braking > 1 && tailMat.emissiveIntensity === 0, `${ braking } y ${ tailMat.emissiveIntensity }` );
	// sin t.brake la luz se estima con la desaceleración en el sentido de marcha
	const lit = st => { model.update( { ...still, ...st }, 1 / 60, 0 ); return tailMat.emissiveIntensity > 1; };
	truthy( 'Sin t.brake: frenada fuerte hacia adelante la enciende', lit( { v: 10, aLong: - 3 } ) );
	truthy( 'Sin t.brake: la retención del motor (1,1 m/s²) la deja apagada', ! lit( { v: 10, aLong: - 1.1 } ) );
	truthy( 'Sin t.brake: acelerar en reversa la deja apagada', ! lit( { v: - 3, aLong: - 2.5 } ) );
	truthy( 'Sin t.brake: frenar en reversa la enciende', lit( { v: - 3, aLong: 2.5 } ) );
	truthy( 'Sin t.brake ni t.v: responde a la desaceleración', lit( { v: undefined, aLong: - 3 } ) && ! lit( { v: undefined, aLong: 0 } ) );
	// valores no finitos: el modelo queda utilizable
	const rBefore = model.wheels[ 0 ].spinner.rotation.x;
	model.update( { ...still, aLong: NaN, aLat: undefined }, NaN, NaN );
	model.update( { ...still }, 0, undefined );
	truthy( 'dt, travel o aceleraciones no finitas dejan el modelo en estado válido', model.wheels[ 0 ].spinner.rotation.x === rBefore && Number.isFinite( model.cab.rotation.x ) && Number.isFinite( model.cab.rotation.z ) );
	const black = createFiat600Model( FIAT600_SPEC, assets, { paint: 0x000000, shadow: false } );
	let blackPaint = null; black.root.traverse( o => { if ( o.isMesh && o.material.name === 'fiat-paint' ) blackPaint = o.material; } );
	check( 'El color 0x000000 se respeta', blackPaint.color.getHex(), 0 );
	black.dispose();
	model.setWhitewall( false );
	truthy( 'setWhitewall( false ) deja el neumático negro', ww.color.r < 0.01 );

}

// === 4. Autos de ambientación ===============================================
{

	const crowd = createFiat600Crowd( assets, { capacity: 50, near: 3, nearDistance: 40, shadow: false } );
	const ids = [];
	for ( let i = 0; i < 40; i ++ ) ids.push( crowd.add( { x: i * 10, y: 0, z: 0, yaw: 0.3, paint: FIAT600_PAINTS[ i % FIAT600_PAINTS.length ].hex } ) );
	check( 'Autos agregados', crowd.count, 40 );
	const camera = new THREE.PerspectiveCamera();
	camera.position.set( 52, 2, 6 );
	crowd.update( camera );
	const nearCars = () => crowd.object.children.filter( o => o.isGroup && o.visible );
	check( 'Los tres más cercanos pasan al nivel medio', nearCars().length, 3 );
	const xs = nearCars().map( o => o.position.x ).sort( ( a, b ) => a - b );
	truthy( 'Son los que rodean a la cámara', xs.join() === '40,50,60', xs.join( ', ' ) );
	const inst = crowd.object.children.find( o => o.isInstancedMesh );
	const m = new THREE.Matrix4(); inst.getMatrixAt( 5, m );
	check( 'Un auto cercano deja de dibujarse en la malla instanciada', m.elements[ 0 ], 0 );
	inst.getMatrixAt( 20, m );
	const pos = new THREE.Vector3().setFromMatrixPosition( m );
	check( 'Un auto lejano queda en su posición', pos.x, 200, 1e-9, ' m' );
	camera.position.set( 302, 2, 6 );
	crowd.update( camera );
	const xs2 = nearCars().map( o => o.position.x ).sort( ( a, b ) => a - b );
	truthy( 'Al mover la cámara cambian los autos cercanos', xs2.join() === '290,300,310', xs2.join( ', ' ) );
	inst.getMatrixAt( 5, m );
	check( 'El que quedó lejos vuelve a la malla instanciada', m.elements[ 0 ] !== 0 ? 1 : 0, 1 );
	crowd.set( ids[ 30 ], { x: 301, z: 2 } );
	truthy( 'set() mueve un auto que está en nivel medio', nearCars().some( o => o.position.x === 301 && o.position.z === 2 ) );
	crowd.remove( ids[ 30 ] ); crowd.remove( ids[ 0 ] );
	crowd.update( camera );
	check( 'Tras quitar dos autos', crowd.count, 38 );
	check( 'Se reponen los cercanos', nearCars().length, 3 );
	const again = crowd.add( { x: 5, z: 5 } );
	truthy( 'Un identificador liberado se reutiliza', again === ids[ 0 ] || again === ids[ 30 ] );
	for ( let i = 0; i < 20; i ++ ) crowd.add( { x: - 100 - i } );
	check( 'La capacidad se respeta', crowd.count, 50 );
	check( 'Agregar sobre la capacidad devuelve -1', crowd.add( {} ), - 1 );
	crowd.dispose();

	// los autos que pasan al nivel medio se ocultan en su lugar: la esfera envolvente sigue ajustada
	const far = createFiat600Crowd( assets, { capacity: 20, near: 2, nearDistance: 40, shadow: false } );
	for ( let i = 0; i < 10; i ++ ) far.add( { x: 5000 + i * 4, z: 5000 } );
	camera.position.set( 5010, 2, 5004 ); camera.updateMatrixWorld( true );
	far.update( camera );
	const sphere = far.object.children.find( o => o.isInstancedMesh ).boundingSphere;
	within( 'Esfera envolvente de autos lejos del origen, con dos en nivel medio', sphere.radius, 15, 30, ' m' );
	far.dispose();

	// el grupo puede estar desplazado: las distancias se miden en su propio marco
	const moved = createFiat600Crowd( assets, { capacity: 8, near: 1, nearDistance: 40, shadow: false } );
	moved.object.position.set( 1000, 0, 0 ); moved.object.updateMatrixWorld( true );
	moved.add( { x: 3, z: 0 } ); moved.add( { x: 30, z: 0 } );
	camera.position.set( 1001, 2, 4 ); camera.updateMatrixWorld( true );
	moved.update( camera );
	const shown = moved.object.children.filter( o => o.isGroup && o.visible );
	truthy( 'Con el grupo desplazado, el auto cercano pasa al nivel medio', shown.length === 1 && shown[ 0 ].position.x === 3 );
	moved.dispose();

	// dos autos a distancias casi iguales y un solo lugar en nivel medio: el elegido se mantiene
	const pair = createFiat600Crowd( assets, { capacity: 4, near: 1, nearDistance: 40, shadow: false } );
	pair.add( { x: - 10, z: 0 } ); pair.add( { x: 10, z: 0 } );
	let swaps = 0, last = null;
	for ( let f = 0; f < 200; f ++ ) {

		camera.position.set( 0.03 * Math.sin( f * 1.7 ), 2, 0 ); camera.updateMatrixWorld( true );
		pair.update( camera );
		const cur = pair.object.children.find( o => o.isGroup && o.visible ).position.x;
		if ( last !== null && cur !== last ) swaps ++;
		last = cur;

	}

	check( 'Dos autos equidistantes no alternan de nivel con el vaivén de la cámara', swaps, 0 );
	pair.dispose();

}

// === 4b. Carga y liberación ==================================================
{

	const again = await loadFiat600();
	truthy( 'Una segunda llamada devuelve el mismo objeto', again === assets );
	truthy( 'Sin renderer ni envMap no hay entorno de reflejos', assets.envMap === null && assets.shared.chrome.metalness < 0.5 );
	const env = new THREE.Texture();
	const withEnv = await loadFiat600( { envMap: env } );
	truthy( 'Una llamada posterior con envMap agrega el entorno a lo ya cargado', withEnv === assets && assets.envMap === env && assets.shared.chrome.envMap === env && assets.shared.chrome.metalness === 1 );
	const car = createFiat600Prop( assets, { shadow: false } );
	let paint = null; car.object.traverse( o => { if ( o.isMesh && o.material.name === 'fiat-paint' ) paint = o.material; } );
	truthy( 'Las pinturas nuevas usan el entorno', paint.envMap === env );
	assets.setEnvironment( {} );
	truthy( 'setEnvironment( {} ) quita el entorno, también de las pinturas vivas', assets.envMap === null && paint.envMap === null );
	car.dispose();
	check( 'Las pinturas liberadas salen del registro', [ ...assets.paints ].filter( m => m === paint ).length, 0 );

}

// === 5. Ficha para la física ================================================
{

	const s = FIAT600_SPEC, e = s.engine;
	truthy( 'La ficha tiene el formato de VEHICLES', s.id === 'fiat600' && s.trailer === null && Array.isArray( e.gears ) && e.gears.length === 4 && s.tractor.hitch === 0 );
	check( 'Largo según la ficha', s.tractor.frontOverhang + s.tractor.wheelbase + s.tractor.rearOverhang, 3.295, 1e-9, ' m' );
	// velocidad en cuarta al régimen de potencia máxima: debe coincidir con la velocidad máxima publicada
	const vAt = ( rpm, gear ) => rpm * 2 * Math.PI / 60 / ( gear * e.final ) * e.wheelRadius * 3.6;
	within( 'Velocidad en 4.ª al régimen de potencia máxima', vAt( e.powerEnd, e.gears[ 3 ] ), 105, 116, ' km/h' );
	// la caja no puede oscilar: tras subir una marcha el régimen queda sobre el umbral de reducción
	let worstDrop = Infinity;
	for ( let i = 0; i < e.gears.length - 1; i ++ ) worstDrop = Math.min( worstDrop, e.upLo * e.gears[ i + 1 ] / e.gears[ i ] );
	within( 'Régimen tras el cambio más largo, subiendo en upLo', worstDrop, e.down + 100, e.upLo, ' rpm' );
	within( 'Par por potencia: el régimen donde se alcanza la potencia máxima', e.power / e.torque * 60 / ( 2 * Math.PI ), 2800, e.powerEnd, ' rpm' );
	// diámetro de giro entre aceras, del ángulo máximo de rueda (modelo de bicicleta)
	const Rr = s.tractor.wheelbase / Math.tan( s.tractor.maxSteer );
	check( 'Radio de giro de la rueda delantera exterior', Math.hypot( Rr + s.tractor.track / 2, s.tractor.wheelbase ), 4.6, 0.05, ' m' );

}

model.dispose();
check( 'No quedan pinturas vivas tras liberar los autos', assets.paints.size, 0 );
assets.dispose();
{

	// tras liberar se puede volver a cargar, y liberar dos veces el objeto antiguo no afecta a la carga nueva
	const fresh = await loadFiat600();
	truthy( 'Tras dispose(), loadFiat600() carga de nuevo', fresh !== assets && Object.keys( fresh.geometries ).length > 0 );
	assets.dispose();
	truthy( 'Liberar otra vez el objeto antiguo no invalida la carga nueva', ( await loadFiat600() ) === fresh );
	fresh.dispose();

}
console.log( fail ? `\n${ fail } pruebas fallaron` : '\nTodas las pruebas pasaron' );
process.exit( fail ? 1 : 0 );
