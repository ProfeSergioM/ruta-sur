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
await page.goto( `${ GAME }?auto=open&q=baja&seed=3` );
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
R.check( 'Sin errores en la consola', log.errors.length === 0, log.errors.slice( 0, 5 ).join( ' | ' ) );
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
