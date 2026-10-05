// Prueba de extremo a extremo en la ciudad de pruebas. Ejecutar: node tests/e2e-test-city.mjs
// El navegador de pruebas dibuja por software y va lento, así que los tiempos
// se miden en tiempo simulado, no en tiempo de reloj.
import { launch, state, waitFor, sleep, Report, ROOT, SHOTS, GAME } from './harness.mjs';

const R = new Report();
const veh = process.argv[ 2 ] || 'articulado';
const { browser, page, log } = await launch( { width: 960, height: 540 } );
const url = `${ GAME }?auto=test&q=baja&veh=${ veh }&seed=${ process.argv[ 3 ] || 11 }`;
const t0 = Date.now();
await page.goto( url );

const sim = () => page.evaluate( () => window.__rutaSur.simTime );
const advance = ( seconds, inp ) => page.evaluate( ( [ s, i ] ) => window.__rutaSur.advance( s, i ), [ seconds, inp ] );
const settle = () => sleep( page, 2500 ); // deja pasar unos cuadros para que la imagen refleje el estado
const waitSim = async seconds => { const s0 = await sim(); for ( let i = 0; i < 600; i ++ ) { if ( await sim() - s0 >= seconds ) return; await sleep( page, 100 ); } throw new Error( 'la simulación no avanza' ); };

let s = await waitFor( page, s => s.state === 'driving', 240000, 'inicio de la conducción' );
R.info( 'Vehículo', veh );
R.info( 'Tiempo hasta poder conducir (dibujando por software)', ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + ' s' );
R.check( 'El archivo abre y carga la ciudad sin pedir nada a la red', log.external.length === 0, log.external.length ? log.external.slice( 0, 3 ).join( ' ' ) : '0 pedidos' );
R.check( 'El camión aparece apoyado en el suelo', s.truck.grounded && s.truck.samples >= 20, `${ s.truck.samples } muestras, y = ${ s.truck.y.toFixed( 2 ) } m` );
R.check( 'Red vial disponible', s.graph === 301, s.graph + ' nodos' );
R.check( 'Hay un encargo ofrecido', s.jobs && s.jobs.state === 'offer', s.jobs && `${ s.jobs.length.toFixed( 0 ) } m` );
await settle();
await page.screenshot( { path: `${ SHOTS }/${ veh }-01-cabina.png` } );

// --- teclado: Enter acepta, W acelera
await page.keyboard.press( 'Enter' );
await sleep( page, 400 );
s = await state( page );
R.check( 'Enter acepta el encargo y carga el camión', s.jobs.state === 'active' && s.truck.cargo > 0, `${ s.truck.cargo / 1000 } t` );
const start = s.truck;
await page.keyboard.down( 'KeyW' );
await waitSim( 2.5 );
await page.keyboard.up( 'KeyW' );
s = await state( page );
R.check( 'La tecla W acelera el camión', s.truck.v > 1.0, `${ ( s.truck.v * 3.6 ).toFixed( 1 ) } km/h tras 2,5 s simulados` );

// --- aceleración en recta (avance rápido de la simulación)
await advance( 6, { accel: 1 } );
s = await state( page );
R.check( 'Avanza hacia el este por la avenida, sin desviarse', s.truck.x < start.x - 20 && Math.abs( s.truck.z - start.z ) < 0.5, `Δx = ${ ( s.truck.x - start.x ).toFixed( 1 ) } m, Δz = ${ ( s.truck.z - start.z ).toFixed( 2 ) } m, ${ ( s.truck.v * 3.6 ).toFixed( 0 ) } km/h, marcha ${ s.truck.gear }` );
await settle();
await page.screenshot( { path: `${ SHOTS }/${ veh }-02-cabina-en-marcha.png` } );

// --- cámaras
await page.keyboard.press( 'KeyC' );
await settle();
await page.screenshot( { path: `${ SHOTS }/${ veh }-03-exterior.png` } );
s = await state( page );
R.check( 'C cambia a la cámara exterior', s.cam === 1 );
await page.keyboard.press( 'KeyC' );
await settle();
await page.screenshot( { path: `${ SHOTS }/${ veh }-04-cenital.png` } );

// --- frenado y reversa
await advance( 8, { decel: 1 } );
s = await state( page );
R.check( 'El freno detiene el camión y luego engancha la reversa', s.truck.dir === - 1 && s.truck.v < - 0.3, `${ ( s.truck.v * 3.6 ).toFixed( 1 ) } km/h` );
await advance( 4, { accel: 1 } );
s = await state( page );
R.check( 'Acelerar vuelve a la directa', s.truck.dir === 1 && s.truck.v > 0.3, `${ ( s.truck.v * 3.6 ).toFixed( 1 ) } km/h` );
await advance( 3, { decel: 0.6 } );

// --- pausa
await page.keyboard.press( 'Escape' );
await sleep( page, 400 );
s = await state( page );
R.check( 'Esc pausa el juego', s.state === 'paused' );
const s1 = await sim();
await sleep( page, 1500 );
R.check( 'En pausa la simulación no avanza', await sim() === s1 );
await page.screenshot( { path: `${ SHOTS }/${ veh }-05-pausa.png` } );
await page.keyboard.press( 'Escape' );
await sleep( page, 400 );
R.check( 'Esc reanuda', ( await state( page ) ).state === 'driving' );

// --- entrega completa con un piloto automático que sigue la ruta
// La ruta del encargo se calculó desde el punto de partida, así que el piloto parte de ahí.
R.check( 'El camión vuelve al punto de partida para seguir la ruta', await page.evaluate( p => window.__rutaSur.teleport( p.x, p.z, 90 ), { x: start.x, z: start.z } ) );
const result = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck, jobs = g.jobs;
	const log = { trace: [], impacts: 0, maxSpeed: 0, maxOffset: 0, maxArt: 0, time: 0, delivered: false, reroutes: 0, maxRoll: 0, maxPitch: 0, minSamples: 99, rejected: 0, stuck: 0 };
	const pilot = () => {

		const tr = jobs.tracker;
		if ( ! tr ) return { decel: 1 };
		const rt = tr.route, v = Math.abs( t.v );
		// punto de la ruta a cierta distancia por delante
		const look = tr.along + 7 + v * 1.1;
		let i = tr.seg;
		while ( i < rt.cum.length - 2 && rt.cum[ i + 1 ] < look ) i ++;
		const a = rt.points[ i ], b = rt.points[ i + 1 ], f = Math.max( 0, Math.min( 1, ( look - rt.cum[ i ] ) / ( rt.cum[ i + 1 ] - rt.cum[ i ] || 1 ) ) );
		const tx = a.x + ( b.x - a.x ) * f, tz = a.z + ( b.z - a.z ) * f;
		// el punto de guía es el eje delantero
		const L = t.spec.tractor.wheelbase;
		const fx = - Math.sin( t.yaw ), fz = - Math.cos( t.yaw );
		const px = t.x + fx * L, pz = t.z + fz * L;
		const want = Math.atan2( - ( tx - px ), - ( tz - pz ) );
		let err = want - t.yaw; err = Math.atan2( Math.sin( err ), Math.cos( err ) );
		const steer = Math.max( - 1, Math.min( 1, err * 2.2 ) );
		// velocidad: lenta cerca de un giro y al llegar
		const next = tr.next(), rem = tr.remaining;
		let target = 9;
		if ( next && next.at - tr.along < 30 ) target = 3.2;
		if ( Math.abs( err ) > 0.25 ) target = Math.min( target, 3.2 );
		if ( rem < 40 ) target = Math.min( target, 3 );
		if ( rem < 9 ) target = 0;
		const accel = v < target ? Math.min( 1, ( target - v ) * 0.8 + 0.15 ) : 0;
		const decel = v > target + 0.5 || target === 0 ? Math.min( 1, ( v - target ) * 0.6 + ( target === 0 ? 0.5 : 0 ) ) : 0;
		return { accel, decel, steer };

	};

	const t0 = g.simTime;
	let lastOdo = t.odo, stuckT = 0;
	while ( g.simTime - t0 < 400 && jobs.state === 'active' ) {

		const before = g.lastImpact; g.lastImpact = 0;
		g.advance( 0.5, pilot );
		if ( g.lastImpact > 0.85 ) log.impacts ++;
		log.maxSpeed = Math.max( log.maxSpeed, Math.abs( t.v ) * 3.6 );
		if ( jobs.tracker ) log.maxOffset = Math.max( log.maxOffset, jobs.tracker.offset );
		log.maxArt = Math.max( log.maxArt, Math.abs( Math.atan2( Math.sin( t.yaw - t.trailerYaw ), Math.cos( t.yaw - t.trailerYaw ) ) ) * 180 / Math.PI );
		log.maxRoll = Math.max( log.maxRoll, Math.abs( t.roll ) * 180 / Math.PI );
		log.maxPitch = Math.max( log.maxPitch, Math.abs( t.pitch ) * 180 / Math.PI );
		log.minSamples = Math.min( log.minSamples, t.gTr.samples );
		if ( t.gTr.rejected ) log.rejected ++;
		if ( Math.round( ( g.simTime - t0 ) * 2 ) % 20 === 0 ) log.trace.push( `t=${ ( g.simTime - t0 ).toFixed( 0 ) } pos=(${ t.x.toFixed( 1 ) },${ t.z.toFixed( 1 ) }) yaw=${ t.yaw.toFixed( 2 ) } v=${ ( t.v * 3.6 ).toFixed( 0 ) } dir=${ t.dir } along=${ jobs.tracker ? jobs.tracker.along.toFixed( 0 ) : '-' } off=${ jobs.tracker ? jobs.tracker.offset.toFixed( 1 ) : '-' } art=${ ( ( t.yaw - t.trailerYaw ) * 57.3 ).toFixed( 0 ) } jack=${ t.jackknife } blk=${ t.blocked.toFixed( 1 ) } thr=${ t.throttle.toFixed( 2 ) } brk=${ t.brake.toFixed( 2 ) }` );
		if ( t.odo - lastOdo < 0.05 ) stuckT += 0.5; else stuckT = 0;
		lastOdo = t.odo;
		log.stuck = Math.max( log.stuck, stuckT );
		if ( stuckT > 20 ) break;

	}

	log.time = g.simTime - t0;
	log.delivered = jobs.state === 'done';
	log.paid = jobs.last ? jobs.last.paid : 0;
	log.length = jobs.last ? jobs.last.length : 0;
	log.damage = jobs.last ? jobs.last.damage : t.damage;
	log.pos = { x: t.x, z: t.z, v: t.v, blocked: t.blocked };
	log.total = jobs.total;
	return log;

} );
R.check( 'Entrega completada siguiendo la ruta', result.delivered, `${ result.length.toFixed( 0 ) } m en ${ result.time.toFixed( 0 ) } s simulados, pago $ ${ result.paid }` );
R.check( 'Sin choques en el trayecto', result.impacts === 0, `${ result.impacts } impactos, daño ${ ( result.damage * 100 ).toFixed( 0 ) } %` );
console.log( '      ' + result.trace.join( '\n      ' ) );
R.check( 'Postura estable sobre la malla ruidosa', result.maxRoll < 6 && result.maxPitch < 9, `alabeo máximo ${ result.maxRoll.toFixed( 1 ) }°, cabeceo máximo ${ result.maxPitch.toFixed( 1 ) }°` );
R.info( 'Trayecto', `velocidad máxima ${ result.maxSpeed.toFixed( 0 ) } km/h, articulación máxima ${ result.maxArt.toFixed( 0 ) }°, mínimo de muestras de suelo ${ result.minSamples }, pasos con bultos descartados ${ result.rejected }` );
await settle();
await page.screenshot( { path: `${ SHOTS }/${ veh }-06-entrega.png` } );

// --- choque: de frente contra un edificio de la vereda norte de la avenida
const crash = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck, city = g.world.city;
	// un edificio frente a la avenida (z0 entre 12 y 18 m) sin árboles ni pasarela en el camino
	const b = city.buildings.find( b => b.z0 > 12 && b.z0 < 18 && Math.abs( ( b.x0 + b.x1 ) / 2 ) < 300 && b.x1 - b.x0 > 8
		&& ! city.trees.some( tr => Math.abs( tr.x - ( b.x0 + b.x1 ) / 2 ) < 4 && tr.z > 0 && tr.z < 20 )
		&& Math.abs( ( b.x0 + b.x1 ) / 2 - city.bridge.x ) > 15 );
	const cx = ( b.x0 + b.x1 ) / 2;
	g.teleport( cx, - 6, 0 ); // en la avenida, mirando al norte, hacia el edificio
	g.lastImpact = 0;
	let hit = 0, time = 0;
	while ( time < 20 && ! hit ) { g.advance( 0.1, { accel: 1 } ); time += 0.1; hit = g.lastImpact; }
	const L = t.spec.tractor.wheelbase + t.spec.tractor.frontOverhang;
	const gap = b.z0 - ( t.z + L );
	const z0 = t.z;
	g.advance( 3, { accel: 1 } ); // seguir acelerando no atraviesa el muro
	return { hit, time, gap, creep: t.z - z0, damage: t.damage, wall: b.z0, x: cx };

} );
R.check( 'Un edificio detiene al camión', crash.hit > 0.85 && Math.abs( crash.creep ) < 0.05, `impacto a ${ ( crash.hit * 3.6 ).toFixed( 0 ) } km/h, avance posterior ${ crash.creep.toFixed( 2 ) } m, daño ${ ( crash.damage * 100 ).toFixed( 0 ) } %` );
R.check( 'El parachoques queda delante del muro', crash.gap > 0.2 && crash.gap < 0.6, `${ crash.gap.toFixed( 2 ) } m de separación` );
await page.keyboard.press( 'KeyC' ); await page.keyboard.press( 'KeyC' );
await settle();
await page.screenshot( { path: `${ SHOTS }/${ veh }-07-choque.png` } );

// --- sin choques, el camión atraviesa el mismo muro
const ghost = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck;
	g.ghost = true;
	const z0 = t.z;
	g.advance( 6, { accel: 1 } );
	g.ghost = false;
	return { moved: t.z - z0, grounded: t.grounded, y: t.y };

} );
R.check( 'Con los choques desactivados el camión atraviesa el edificio', ghost.moved > 8, `${ ghost.moved.toFixed( 1 ) } m` );

// --- datos técnicos y volver a la calle
await page.keyboard.press( 'F3' );
await page.keyboard.press( 'KeyR' );
await settle();
s = await state( page );
R.check( 'R deja el camión sobre una calle', s.truck.grounded && Math.abs( s.truck.v ) < 0.01 );
await page.screenshot( { path: `${ SHOTS }/${ veh }-08-datos-tecnicos.png` } );
const dbg = await page.evaluate( () => document.getElementById( 'depura' ).textContent );
R.info( 'Datos técnicos', '\n      ' + dbg.split( '\n' ).join( '\n      ' ) );
const phys = await page.evaluate( () => { const g = window.__rutaSur; const r0 = g.world.field.rays, t0 = performance.now(); g.advance( 10, { accel: 0.5 } ); return { ms: ( performance.now() - t0 ) / 600, rays: ( g.world.field.rays - r0 ) / 600 }; } );
R.info( 'Costo de la física', `${ phys.ms.toFixed( 3 ) } ms por paso, ${ phys.rays.toFixed( 0 ) } rayos por paso` );
R.info( 'BVH construidos', `${ s.stats.bvh } en ${ s.stats.bvhMs.toFixed( 0 ) } ms (${ ( s.stats.bvhMs / Math.max( 1, s.stats.bvh ) ).toFixed( 1 ) } ms por malla)` );

R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 5 ).join( ' | ' ) );
R.check( 'Toda la partida transcurrió sin pedidos a la red', log.external.length === 0, log.external.length ? log.external.slice( 0, 3 ).join( ' ' ) : '0 pedidos' );
if ( log.warnings.length ) R.info( 'Advertencias', [ ...new Set( log.warnings ) ].slice( 0, 6 ).join( ' | ' ) );
await browser.close();
process.exit( R.fail ? 1 : 0 );
