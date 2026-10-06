// Prueba de extremo a extremo del mapa abierto: calles y edificios de OpenStreetMap.
// Overpass se simula con la muestra real del centro de Temuco y
// edificios sintéticos en sus manzanas. Ejecutar: node tests/e2e-open.mjs
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { launch, state, waitFor, sleep, Report, ROOT, SHOTS, GAME } from './harness.mjs';
import { overpassAnswer } from './overpass-mock.mjs';
import { syntheticBuildings } from './open-fixture.mjs';
import { Geo } from '../src/geo.js';

const R = new Report();
const ORIGIN = { lat: - 38.739141, lon: - 72.590355 };
const roads = JSON.parse( readFileSync( resolve( ROOT, 'tests/fixtures/temuco-centro.json' ), 'utf8' ) );
const buildings = syntheticBuildings( roads, new Geo( ORIGIN.lat, ORIGIN.lon, 0 ) );
const pilot = readFileSync( resolve( ROOT, 'tests/pilot.js' ), 'utf8' );
const CORS = { 'access-control-allow-origin': '*' };

// Overpass simulado: responde calles o edificios según la consulta
async function mockOverpass( page, net, fail = false ) {

	await page.route( /https:\/\/overpass[^/]*\/api\/interpreter.*/, route => {

		const query = decodeURIComponent( ( route.request().postData() || '' ).replace( /^data=/, '' ).replace( /\+/g, ' ' ) );
		const kind = /\["building"\]/.test( query ) ? 'buildings' : 'roads';
		net.push( { kind, query } );
		if ( fail ) return route.fulfill( { status: 504, body: 'timeout', headers: CORS } );
		const answer = overpassAnswer( query, kind === 'buildings' ? buildings : roads );
		route.fulfill( { status: 200, contentType: 'application/json', body: JSON.stringify( answer ), headers: CORS } ).catch( () => {} );

	} );

}

const { browser, page, log } = await launch( { width: 960, height: 540 } );
const net = [];
await mockOverpass( page, net );
const t0 = Date.now();
await page.goto( `${ GAME }?auto=open&q=baja&seed=3&trafico=0` ); // el piloto automático no esquiva autos: el tráfico se activa después
await page.addScriptTag( { content: pilot } );
let s = await waitFor( page, s => s.state === 'driving', 240000, 'conducción en el mapa abierto' );
R.info( 'Tiempo hasta poder conducir', ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) + ' s' );
R.check( 'Se pidieron a Overpass las calles y los edificios, y nada más salió a la red', net.length === 2 && net.some( n => n.kind === 'roads' ) && net.some( n => n.kind === 'buildings' ) && log.external.every( u => /overpass/.test( u ) ), `${ net.length } consultas, ${ log.external.length } pedidos` );
const bq = net.find( n => n.kind === 'buildings' );
R.check( 'La consulta de edificios pide etiquetas y geometría en 1,5 km', bq && /around:1500,/.test( bq.query ) && /out tags geom/.test( bq.query ), bq && ( bq.query.match( /^out[^;]*;/m ) || [ '' ] )[ 0 ] );
R.check( 'El camión aparece sobre el suelo plano, en una calle', s.truck.grounded && Math.abs( s.truck.y ) < 0.1 && s.truck.samples >= 20, `y = ${ s.truck.y.toFixed( 2 ) } m, ${ s.truck.samples } muestras` );
R.check( 'Hay red vial y un encargo ofrecido', s.graph > 50 && s.jobs && s.jobs.state === 'offer', `${ s.graph } nodos` );
const st = await page.evaluate( () => { const w = window.__rutaSur.world; return { ...w.stats(), kind: w.kind, provider: w.provider, credit: document.getElementById( 'a-logo' ).textContent }; } );
R.check( 'La ciudad trae los edificios y las vías de OpenStreetMap', st.kind === 'open' && st.edificios > 100 && st.vias > 40, `${ st.edificios } edificios, ${ st.vias } vías, ${ st.visibles } trozos` );
R.check( 'Y la ambientación: plazas, árboles mapeados y de vereda, faroles', st.manchas > 10 && st.arbolesOSM > 10 && st.arboles > 50 && st.faroles > 0, `${ st.manchas } manchas, ${ st.arbolesOSM } árboles mapeados, ${ st.arboles } árboles dibujados, ${ st.faroles } faroles` );
R.check( 'Y el mobiliario urbano: postes, autos estacionados, paraderos, señales, semáforos y bancas', st.postes > 5 && st.estacionados > 10 && st.paraderos > 0 && st.senales > 2 && st.semaforos > 0 && st.bancas > 0 && st.cruces > 10, `${ st.postes } postes, ${ st.estacionados } estacionados, ${ st.paraderos } paraderos, ${ st.senales } señales, ${ st.semaforos } semáforos, ${ st.bancas } bancas, ${ st.cruces } cruces` );
R.check( 'La atribución nombra a OpenStreetMap', /OpenStreetMap/.test( st.provider ) && /OpenStreetMap/.test( st.credit ), st.credit );
await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/abierto-01-cabina.png` } );

// --- manejar por la ciudad con el piloto automático
await page.keyboard.press( 'Enter' );
await sleep( page, 300 );
const drive = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck, x0 = t.x, z0 = t.z;
	g.lastImpact = 0; g.lastSide = 0;
	let impacts = 0, sides = 0, noGround = 0, maxY = 0, minSamples = 99;
	for ( let i = 0; i < 90; i ++ ) {

		g.advance( 0.5, window.__pilot );
		if ( g.lastImpact > 0.85 ) { impacts ++; g.lastImpact = 0; }
		if ( g.lastSide ) { sides ++; g.lastSide = 0; }
		if ( ! t.grounded ) noGround ++;
		maxY = Math.max( maxY, Math.abs( t.y ) );
		minSamples = Math.min( minSamples, t.gTr.samples );

	}

	return { moved: Math.hypot( t.x - x0, t.z - z0 ), odo: t.odo, impacts, sides, noGround, maxY, minSamples, jobs: g.jobs.state, remaining: g.jobs.tracker ? g.jobs.tracker.remaining : null, chunks: g.world.chunks.size, built: g.world.built, ms: g.world.buildMs };

} );
R.check( 'El piloto recorre las calles reales durante 45 s simulados', drive.odo > 80, `${ drive.odo.toFixed( 0 ) } m recorridos, encargo ${ drive.jobs }, faltan ${ drive.remaining === null ? '-' : drive.remaining.toFixed( 0 ) + ' m' }` );
R.check( 'Sin choques ni roces en la ruta', drive.impacts === 0 && drive.sides === 0, `${ drive.impacts } choques, ${ drive.sides } roces` );
// --- tráfico sobre las calles de OpenStreetMap
const traffic = await page.evaluate( () => {

	const g = window.__rutaSur, T = g.traffic, t = g.truck;
	g.trafficOn = true; T.enabled = true; T.count = 12;
	g.advance( 3, { decel: 1 } );
	const first = T.vehicles.map( v => ( { id: v.id, x: v.x, z: v.z } ) );
	g.advance( 8, { decel: 1 } );
	const moved = T.vehicles.filter( v => { const f = first.find( p => p.id === v.id ); return f && Math.hypot( v.x - f.x, v.z - f.z ) > 10; } ).length;
	return { n: T.vehicles.length, first: first.length, moved, hits: T.hits, minDist: Math.min( ...T.vehicles.map( v => Math.hypot( v.x - t.x, v.z - t.z ) ) ) };

} );
R.check( 'Al activar el tráfico, los vehículos circulan por las calles reales', traffic.n >= 8 && traffic.moved >= 4 && traffic.hits === 0, `${ traffic.n } vehículos, ${ traffic.moved } de ${ traffic.first } se movieron, el más cercano a ${ traffic.minDist.toFixed( 0 ) } m` );
R.check( 'Siempre con suelo bajo las ruedas, plano', drive.noGround === 0 && drive.maxY < 0.1 && drive.minSamples >= 20, `altura máxima ${ drive.maxY.toFixed( 2 ) } m, mínimo ${ drive.minSamples } muestras` );
R.info( 'Trozos', `${ drive.chunks } en memoria, ${ drive.built } construidos en ${ drive.ms.toFixed( 0 ) } ms` );
await page.keyboard.press( 'KeyC' );
await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/abierto-02-exterior.png` } );
await page.keyboard.press( 'KeyC' );
await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/abierto-03-cenital.png` } );

// --- un edificio de OpenStreetMap detiene al camión
const crash = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck, city = g.world.city;
	const inside = ( x, z, poly ) => { let c = false; for ( let i = 0, j = poly.length - 1; i < poly.length; j = i ++ ) { const a = poly[ i ], b = poly[ j ]; if ( ( a.z > z ) !== ( b.z > z ) && x < ( b.x - a.x ) * ( z - a.z ) / ( b.z - a.z ) + a.x ) c = ! c; } return c; };
	// un edificio cercano con un punto de partida libre 30 m al sur, sobre el suelo y fuera de todo edificio
	const near = city.buildings.filter( b => Math.hypot( b.cx - t.x, b.cz - t.z ) < 250 && b.poly.length === 4 ).sort( ( a, b ) => Math.hypot( a.cx - t.x, a.cz - t.z ) - Math.hypot( b.cx - t.x, b.cz - t.z ) );
	for ( const b of near ) {

		const half = Math.max( ...b.poly.map( p => Math.abs( p.z - b.cz ) ) );
		const sx = b.cx, sz = b.cz - half - 28;
		if ( city.buildings.some( o => inside( sx, sz, o.poly ) ) ) continue;
		const ground = g.world.groundAt( sx, sz );
		if ( ! ground || Math.abs( ground.y ) > 0.1 ) continue;
		if ( ! g.teleport( sx, sz, 0 ) ) continue; // mirando al norte, hacia el edificio
		g.lastImpact = 0;
		let time = 0, hit = 0;
		while ( time < 20 && ! hit ) { g.advance( 0.1, { accel: 1 } ); time += 0.1; hit = g.lastImpact; }
		// distancia del parachoques a la fachada más cercana, sea la del edificio elegido o la de un vecino
		const d = t.spec.tractor.wheelbase + t.spec.tractor.frontOverhang;
		const fx = t.x - Math.sin( t.yaw ) * d, fz = t.z - Math.cos( t.yaw ) * d;
		let gap = Infinity, which = b;
		for ( const o of city.buildings ) {

			if ( Math.hypot( o.cx - fx, o.cz - fz ) > 60 ) continue;
			const P = o.poly;
			for ( let i = 0, j = P.length - 1; i < P.length; j = i ++ ) {

				const ax = P[ j ].x, az = P[ j ].z, bx = P[ i ].x, bz = P[ i ].z, ex = bx - ax, ez = bz - az, l2 = ex * ex + ez * ez;
				const u = l2 > 0 ? Math.max( 0, Math.min( 1, ( ( fx - ax ) * ex + ( fz - az ) * ez ) / l2 ) ) : 0;
				const dist = Math.hypot( fx - ( ax + ex * u ), fz - ( az + ez * u ) );
				if ( dist < gap ) { gap = dist; which = o; }

			}

		}

		return { found: true, hit, time, gap, h: which.h, tags: which.tags };

	}

	return { found: false };

} );
R.check( 'Hay un edificio con un punto de partida libre delante', crash.found );
if ( crash.found ) {

	R.check( 'El edificio de OpenStreetMap detiene al camión', crash.hit > 0.85, `impacto a ${ ( crash.hit * 3.6 ).toFixed( 0 ) } km/h tras ${ crash.time.toFixed( 1 ) } s, edificio de ${ crash.h.toFixed( 1 ) } m (${ crash.tags.building })` );
	R.check( 'El parachoques queda delante de la fachada', crash.gap > 0.2 && crash.gap < 0.8, `${ crash.gap.toFixed( 2 ) } m` );

}

await page.keyboard.press( 'KeyC' );
await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/abierto-04-choque.png` } );

// --- lo sólido de la calle también detiene al camión: se embiste un auto estacionado por detrás
const solid = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck, W = g.world;
	let car = null, bd = Infinity;
	for ( const c of W.chunks.values() ) for ( const o of c.objects || [] ) { if ( o.kind !== 'estacionado' ) continue; const d = Math.hypot( o.x - t.x, o.z - t.z ); if ( d < bd ) { bd = d; car = o; } }
	if ( ! car ) return { found: false };
	// el camión 16 m detrás del auto, en su mismo sentido, y avanza despacio hasta tocarlo
	const fx = - Math.sin( car.yaw ), fz = - Math.cos( car.yaw );
	const compass = ( Math.PI - car.yaw ) * 180 / Math.PI;
	if ( ! g.teleport( car.x - fx * 16, car.z - fz * 16, compass ) ) return { found: true, placed: false };
	g.lastImpact = 0; g.ghost = false;
	const damage0 = t.damage;
	let time = 0;
	while ( time < 12 && t.blocked <= 0 && g.lastImpact === 0 ) { g.advance( 0.2, { accel: 0.45 } ); time += 0.2; }
	g.advance( 1.5, { accel: 0.45 } ); // insistir no lo atraviesa
	const front = t.spec.tractor.wheelbase + t.spec.tractor.frontOverhang;
	const px = t.x - Math.sin( t.yaw ) * front, pz = t.z - Math.cos( t.yaw ) * front;
	const ahead = ( car.x - px ) * fx + ( car.z - pz ) * fz; // del parachoques al centro del auto, en el sentido de marcha
	return { found: true, placed: true, time, blocked: t.blocked, impact: g.lastImpact, ahead, v: t.v, damage: t.damage - damage0 };

} );
R.check( 'Hay un auto estacionado cerca y el camión se deja detrás', solid.found && solid.placed );
if ( solid.found && solid.placed ) {

R.check( 'El auto estacionado detiene al camión: no lo atraviesa', ( solid.blocked > 0 || solid.impact > 0 ) && solid.ahead > 1.6 && solid.ahead < 4.5 && Math.abs( solid.v ) < 0.3, `tras ${ solid.time.toFixed( 1 ) } s, el parachoques queda a ${ solid.ahead.toFixed( 2 ) } m del centro del auto, impacto ${ ( solid.impact * 3.6 ).toFixed( 1 ) } km/h, daño ${ ( solid.damage * 100 ).toFixed( 1 ) } %` );

}

// una foto de un cruce con semáforo, desde la cámara exterior
const corner = await page.evaluate( () => {

	const g = window.__rutaSur, t = g.truck, W = g.world;
	let best = null, bd = Infinity;
	for ( const c of W.chunks.values() ) for ( const o of c.objects || [] ) { if ( o.kind !== 'semaforo' ) continue; const d = Math.hypot( o.x - t.x, o.z - t.z ); if ( d < bd ) { bd = d; best = o; } }
	if ( ! best ) return false;
	const dx = best.x - t.x, dz = best.z - t.z, d = Math.hypot( dx, dz ) || 1, yaw = Math.atan2( - dx, - dz );
	return g.teleport( best.x - dx / d * 18, best.z - dz / d * 18, ( Math.PI - yaw ) * 180 / Math.PI );

} );
if ( corner ) { await page.keyboard.press( 'KeyC' ); await sleep( page, 2500 ); await page.screenshot( { path: `${ SHOTS }/abierto-10-semaforo.png` } ); await page.keyboard.press( 'KeyC' ); await page.keyboard.press( 'KeyC' ); await sleep( page, 300 ); }

// --- semáforos: ciclan, el tráfico los respeta y el camión paga multa si pasa en rojo
const sig = await page.evaluate( () => {

	const g = window.__rutaSur, S = g.signals, W = g.world;
	if ( ! S ) return { signals: false };
	// lámparas pintadas en algún trozo cargado, y que cambian con el reloj
	const lamps = () => { const out = []; for ( const c of W.chunks.values() ) if ( c.lamps ) for ( const l of c.lamps.list ) out.push( l.key + ':' + l.group + ':' + l.lamp + ':' + ( l.lit ? 1 : 0 ) ); return out; };
	g.advance( 0.5, {} );
	const a = lamps();
	g.advance( 20, {} ); // sin entrada: detenido (frenar detenido engancharía la reversa)
	const b = lamps();
	let changed = 0; for ( let i = 0; i < a.length; i ++ ) if ( a[ i ] !== b[ i ] ) changed ++;
	const litNow = b.filter( s => s.endsWith( ':1' ) ).length;
	return { signals: true, lights: S.lights, stops: S.stops, lamps: a.length, changed, litNow };

} );
R.check( 'El mapa abierto tiene semáforos y discos Pare en sus cruces', sig.signals && sig.lights > 0 && sig.stops > 0, JSON.stringify( sig ) );
R.check( 'Las lámparas de los semáforos cargados se pintan y cambian con el ciclo', sig.lamps > 0 && sig.litNow > 0 && sig.changed > 0, `${ sig.lamps } lámparas, ${ sig.litNow } encendidas, ${ sig.changed } cambiaron en 20 s` );
const redLight = await page.evaluate( () => {

	const g = window.__rutaSur, S = g.signals, G = g.graph, t = g.truck;
	// un semáforo y una arista de una vía principal que entra a él: el camión parte 28 m antes
	let pick = null;
	for ( const [ n, cr ] of S.byNode ) {

		if ( cr.kind !== 'light' ) continue;
		for ( let e = 0; e < G.from.length; e ++ ) if ( G.to[ e ] === n && G.len[ e ] > 30 && cr.majorIds.includes( G.ways[ G.wayOf[ e ] ].id ) ) { pick = { cr, e, wayId: G.ways[ G.wayOf[ e ] ].id }; break; }
		if ( pick ) break;

	}

	if ( ! pick ) return { found: false };
	const { cr, e, wayId } = pick, ux = G.ux[ e ], uz = G.uz[ e ], yaw = Math.atan2( - ux, - uz );
	if ( ! g.teleport( cr.x - ux * 26, cr.z - uz * 26, ( Math.PI - yaw ) * 180 / Math.PI ) ) return { found: true, placed: false };
	if ( g.traffic ) g.traffic.clearNear( cr.x, cr.z, 80 );
	// espera detenido hasta que la luz esté en rojo con tiempo por delante
	let waited = 0;
	while ( waited < 60 && ! ( S.state( cr, wayId, g.simTime ) === 'red' && S.state( cr, wayId, g.simTime + 8 ) === 'red' ) ) { g.advance( 0.5, {} ); waited += 0.5; }
	const before = g.redLights || 0, total0 = g.jobs.total;
	g.advance( 7, { accel: 1 } );
	const toast = document.getElementById( 'aviso' );
	return { found: true, placed: true, waited, fines: ( g.redLights || 0 ) - before, toast: toast && ! toast.hidden ? toast.textContent : '', fine: total0 - g.jobs.total, passed: ( cr.x - t.x ) * ( - Math.sin( yaw ) ) + ( cr.z - t.z ) * ( - Math.cos( yaw ) ) };

} );
R.check( 'Hay un semáforo con una avenida que entra, y el camión se deja antes de la línea', redLight.found && redLight.placed );
if ( redLight.found && redLight.placed ) R.check( 'Pasar con luz roja cuesta una multa, una sola vez', redLight.fines === 1 && /luz roja/.test( redLight.toast ) && redLight.passed < 0, `${ redLight.toast || 'sin aviso' }; esperó ${ redLight.waited } s el rojo; cruce ${ ( - redLight.passed ).toFixed( 0 ) } m atrás` );

// --- día y noche: la hora avanza con el juego, T la adelanta y de noche se encienden las luces
await page.evaluate( () => { window.__rutaSur.hour = 17.3; } ); await sleep( page, 300 ); // la hora de partida, descontado lo que el piloto y el tráfico avanzaron
const day = await page.evaluate( () => { const g = window.__rutaSur, M = g.world.materials; return { hour: g.hour, clock: document.getElementById( 'reloj' ).textContent, lamps: g.world.lampsOn, pool: M.pool.visible, tint: M.road.color.r, windows: M.windows.visible }; } );
R.check( 'La partida empieza a las 17 y el reloj lo muestra', day.hour > 17 && day.hour < 18 && /^17:/.test( day.clock ), `${ day.clock }` );
R.check( 'De día las luces están apagadas y la ciudad sin tinte', ! day.lamps && ! day.pool && day.tint > 0.9 && ! day.windows, JSON.stringify( day ) );
for ( let i = 0; i < 4; i ++ ) { await page.keyboard.press( 'KeyT' ); await sleep( page, 150 ); }
await sleep( page, 600 );
const night = await page.evaluate( () => { const g = window.__rutaSur, M = g.world.materials; return { hour: g.hour, clock: document.getElementById( 'reloj' ).textContent, lamps: g.world.lampsOn, pool: M.pool.visible && M.pool.opacity > 0.3, glow: M.glow.color.r > 0.95, tint: M.road.color.r, windows: M.windows.visible && M.windows.opacity > 0.95, sky: g.world.scene.fog.color.r, beam: g.model.root.children[ 0 ].children.some( c => c.material && c.material.blending === 2 && c.visible && c.material.opacity > 0.5 ) }; } );
R.check( 'Cuatro veces T adelantan a las 21 y es de noche', night.hour >= 21 && night.hour < 22 && /^21:/.test( night.clock ), night.clock );
R.check( 'De noche se encienden los faroles, sus charcos, las ventanas y los focos del camión, y la ciudad se oscurece', night.lamps && night.pool && night.glow && night.windows && night.tint < 0.4 && night.sky < 0.2 && night.beam, JSON.stringify( night ) );
await page.keyboard.press( 'KeyC' ); await page.keyboard.press( 'KeyC' ); // exterior
await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/abierto-07-noche.png` } );
await page.keyboard.press( 'KeyC' ); await sleep( page, 2500 );
await page.screenshot( { path: `${ SHOTS }/abierto-08-noche-cabina.png` } );
const dusk = await page.evaluate( () => { const g = window.__rutaSur; g.hour = 19.3; return new Promise( r => setTimeout( () => r( { fog: g.world.scene.fog.color.getHex().toString( 16 ) } ), 400 ) ); } );
await page.screenshot( { path: `${ SHOTS }/abierto-09-atardecer.png` } );
R.info( 'Bruma al atardecer', '#' + dusk.fog );
await page.evaluate( () => { window.__rutaSur.hour = 12; } ); await sleep( page, 400 );

// --- radio: la tecla X recorre las emisoras; la transmisión se simula caída
const streams = [];
await page.route( /^https:\/\/(playerservices\.streamtheworld\.com|unlimited\d*-cl\.dps\.live)\//, route => { streams.push( route.request().url() ); route.fulfill( { status: 503, body: 'sin señal' } ).catch( () => {} ); } );
await page.keyboard.press( 'KeyX' );
await sleep( page, 1200 );
const r1 = await page.evaluate( () => { const r = window.__rutaSur.radio; return { name: r.current && r.current.name, src: r.audio && r.audio.src, state: r.state, label: r.label }; } );
R.check( 'X enciende la primera emisora y el navegador pide su transmisión', r1.name === 'ADN Radio' && /streamtheworld\.com\/api\/livestream-redirect\/ADNAAC\.aac$/.test( r1.src ) && streams.length >= 1, `${ r1.name }: ${ r1.src }` );
R.check( 'Si la transmisión no responde, el juego lo dice', r1.state === 'error' && /no suena/.test( r1.label ), r1.label );
await page.keyboard.press( 'KeyX' ); await sleep( page, 300 );
await page.keyboard.press( 'KeyX' ); await sleep( page, 300 );
const r3 = await page.evaluate( () => window.__rutaSur.radio.current && window.__rutaSur.radio.current.name );
R.check( 'X recorre las emisoras en orden', r3 === 'Futuro', r3 );
await page.keyboard.press( 'KeyX' ); await sleep( page, 300 );
const r4 = await page.evaluate( () => { const r = window.__rutaSur.radio; return { current: r.current, state: r.state, src: r.audio.getAttribute( 'src' ) }; } );
R.check( 'Después de la última emisora, la radio se apaga', r4.current === null && r4.state === 'off' && ! r4.src, JSON.stringify( r4 ) );
await page.keyboard.press( 'Escape' ); await sleep( page, 400 );
const menu = await page.evaluate( () => ( { botones: [ ...document.querySelectorAll( '#radios button' ) ].map( b => b.textContent ), estado: document.getElementById( 'radio-estado' ).textContent } ) );
R.check( 'La pausa lista las emisoras y el estado', menu.botones.join( ',' ) === 'Apagada,ADN Radio,Cooperativa,Futuro' && /apagada/i.test( menu.estado ), JSON.stringify( menu ) );
await page.click( '#radios button[data-radio="cooperativa"]' ); await sleep( page, 800 );
const r5 = await page.evaluate( () => { const r = window.__rutaSur.radio; return { name: r.current && r.current.name, src: r.audio.src, marcado: document.querySelector( '#radios .marcado' ).textContent }; } );
R.check( 'Desde la pausa se elige una emisora', r5.name === 'Cooperativa' && /dps\.live\/cooperativafm/.test( r5.src ) && r5.marcado === 'Cooperativa', r5.src );
await page.fill( '#radio-url', 'https://radio.ejemplo.test/stream.mp3' );
await page.route( 'https://radio.ejemplo.test/**', route => route.fulfill( { status: 503, body: '' } ).catch( () => {} ) );
await page.press( '#radio-url', 'Enter' ); await sleep( page, 800 );
const r6 = await page.evaluate( () => { const r = window.__rutaSur.radio; return { name: r.current && r.current.name, src: r.audio.src, n: document.querySelectorAll( '#radios button' ).length }; } );
R.check( 'Una dirección propia se agrega a la lista y suena', r6.name === 'Dirección propia' && r6.src === 'https://radio.ejemplo.test/stream.mp3' && r6.n === 5, JSON.stringify( r6 ) );
await page.screenshot( { path: `${ SHOTS }/abierto-06-radio.png` } );
await page.click( '#radios button[data-radio="off"]' );
await page.keyboard.press( 'Escape' ); await sleep( page, 300 );
R.check( 'M silencia también la radio', await page.evaluate( async () => { const g = window.__rutaSur; g.radio.play( g.radio.stations[ 0 ] ); await new Promise( r => setTimeout( r, 200 ) ); const before = g.radio.audio.muted; window.dispatchEvent( new KeyboardEvent( 'keydown', { code: 'KeyM' } ) ); const after = g.radio.audio.muted; window.dispatchEvent( new KeyboardEvent( 'keydown', { code: 'KeyM' } ) ); g.radio.stop(); return ! before && after && ! g.radio.audio.muted; } ) );
const own = log.errors.filter( e => ! /Failed to load resource|503/.test( e ) );
R.check( 'Sin errores en la consola (aparte de las transmisiones simuladas caídas)', own.length === 0, own.slice( 0, 5 ).join( ' | ' ) );
if ( log.warnings.length ) R.info( 'Advertencias', [ ...new Set( log.warnings ) ].slice( 0, 6 ).join( ' | ' ) );
await browser.close();

// --- sin OpenStreetMap, la carga se detiene y explica el motivo
{

	const { browser, page } = await launch( { width: 960, height: 540 } );
	const net2 = [];
	await mockOverpass( page, net2, true );
	await page.goto( `${ GAME }?auto=open&q=baja` );
	let s2 = null;
	for ( let i = 0; i < 300; i ++ ) { s2 = await state( page ); if ( s2 && ( s2.error || s2.state === 'driving' ) ) break; await sleep( page, 500 ); }
	const text = await page.evaluate( () => document.getElementById( 'carga-texto' ).textContent );
	R.check( 'Si Overpass falla, la carga se detiene y lo dice', s2 && s2.error && /OpenStreetMap/.test( text ) && s2.state === 'loading', text );
	await page.screenshot( { path: `${ SHOTS }/abierto-05-sin-osm.png` } );
	await browser.close();

}

process.exit( R.fail ? 1 : 0 );
