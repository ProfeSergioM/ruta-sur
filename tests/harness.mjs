// Utilidades para probar el juego en un navegador sin interfaz.
// El archivo del juego trae adentro sus bibliotecas, así que al abrirlo no debe pedir
// nada a la red: `log.external` anota cada pedido que sale, y las pruebas lo revisan.
// Los servicios de mapas no están al alcance del entorno de pruebas y se simulan.
// La ruta de la CDN queda para probar versiones anteriores del archivo (RUTA_SUR_HTML),
// que pedían ahí sus bibliotecas.
// Playwright: el del proyecto (npm i -D playwright) o, si no está, el del entorno donde se desarrolló
let chromium;
try { ( { chromium } = await import( 'playwright' ) ); } catch ( e ) { ( { chromium } = await import( '/opt/npm-tools/node_modules/playwright/index.mjs' ) ); }
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
// El archivo bajo prueba. Se puede apuntar a otra versión con RUTA_SUR_HTML, por
// ejemplo para comprobar que una prueba nueva falla contra el código anterior.
export const GAME = `file://${ process.env.RUTA_SUR_HTML ? resolve( process.env.RUTA_SUR_HTML ) : resolve( ROOT, 'docs/index.html' ) }`;
export const SHOTS = resolve( ROOT, 'tests/shots' );
mkdirSync( SHOTS, { recursive: true } );

const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.html': 'text/html', '.css': 'text/css' };

export async function launch( { width = 1280, height = 720, mobile = false } = {} ) {

	const browser = await chromium.launch( {
		headless: true,
		// Sin "--allow-file-access-from-files": la página se abre como la abrirá el jugador, con doble clic sobre el archivo.
		args: [ '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required' ],
	} );
	const context = await browser.newContext( { viewport: { width, height }, deviceScaleFactor: 1, ...( mobile ? { hasTouch: true, isMobile: true } : {} ) } );
	const page = await context.newPage();
	const log = { errors: [], warnings: [], requests: [], blocked: [], external: [] };
	// todo pedido que sale del navegador hacia la red (los simulados también pasan por aquí)
	page.on( 'request', r => { const u = r.url(); if ( /^(https?|wss?):/i.test( u ) ) log.external.push( u ); } );
	page.on( 'console', m => {

		const t = m.type(), text = m.text();
		if ( t === 'error' ) log.errors.push( text ); else if ( t === 'warning' ) log.warnings.push( text );

	} );
	page.on( 'pageerror', e => log.errors.push( 'pageerror: ' + ( e.stack || e.message ) ) );

	// bibliotecas de las versiones anteriores: la misma ruta de la CDN, desde node_modules
	await page.route( 'https://cdn.jsdelivr.net/npm/**', route => {

		const url = new URL( route.request().url() );
		const m = url.pathname.match( /^\/npm\/((?:@[^/]+\/)?[^@/]+)@([^/]+)\/(.+)$/ );
		if ( ! m ) return route.abort();
		const [ , pkg, version, path ] = m;
		const base = resolve( ROOT, 'node_modules', pkg );
		const real = JSON.parse( readFileSync( resolve( base, 'package.json' ), 'utf8' ) ).version;
		if ( real !== version ) { log.errors.push( `La página pide ${ pkg }@${ version } y la versión instalada es ${ real }` ); return route.abort(); }
		const file = resolve( base, path );
		if ( ! existsSync( file ) ) { log.errors.push( `No existe en el paquete: ${ pkg }/${ path }` ); return route.fulfill( { status: 404, body: 'not found' } ); }
		log.requests.push( `${ pkg }/${ path }` );
		route.fulfill( { status: 200, body: readFileSync( file ), contentType: MIME[ extname( file ) ] || 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } } );

	} );
	// tipografías: sin red, la página usa las de respaldo
	await page.route( /https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/, route => route.fulfill( { status: 200, contentType: 'text/css', body: '' } ) );

	return { browser, context, page, log };

}

// Estado del juego visto desde la página
export const state = page => page.evaluate( () => {

	const g = window.__rutaSur;
	if ( ! g ) return null;
	const t = g.truck;
	return {
		state: g.state,
		load: g.load ? { phase: g.load.phase, roads: g.load.roads, ground: g.load.ground } : null,
		error: g.world ? g.world.error : null,
		truck: t ? { x: t.x, y: t.y, z: t.z, yaw: t.yaw, v: t.v, gear: t.gear, dir: t.dir, rpm: t.rpm, pitch: t.pitch, roll: t.roll, grounded: t.grounded, damage: t.damage, blocked: t.blocked, trailerYaw: t.trailerYaw, cargo: t.cargoMass, samples: t.gTr.samples, rejected: t.gTr.rejected } : null,
		jobs: g.jobs ? { state: g.jobs.state, total: g.jobs.total, entregas: g.jobs.entregas, dest: g.jobs.job ? g.jobs.job.dest : null, length: g.jobs.job ? g.jobs.job.length : 0, remaining: g.jobs.tracker ? g.jobs.tracker.remaining : null } : null,
		graph: g.graph ? g.graph.count : 0,
		perf: g.perf, cam: g.cam.mode,
		stats: g.world ? g.world.stats() : null,
		ghost: g.ghost,
	};

} );

export async function waitFor( page, predicate, timeoutMs, label ) {

	const t0 = Date.now();
	for ( ;; ) {

		const s = await state( page );
		if ( s && predicate( s ) ) return s;
		if ( s && s.error ) throw new Error( `El juego informó un error mientras se esperaba "${ label }": ${ s.error }` );
		if ( Date.now() - t0 > timeoutMs ) throw new Error( `Tiempo agotado (${ timeoutMs } ms) esperando "${ label }". Estado: ${ JSON.stringify( s && { state: s.state, load: s.load } ) }` );
		await page.waitForTimeout( 200 );

	}

}

export const sleep = ( page, ms ) => page.waitForTimeout( ms );

export class Report {

	constructor() { this.fail = 0; this.rows = []; }
	check( name, ok, value = '' ) { if ( ! ok ) this.fail ++; console.log( `${ ok ? 'ok   ' : 'FALLA' } ${ name }${ value !== '' ? ': ' + value : '' }` ); }
	info( name, value ) { console.log( `info  ${ name }: ${ value }` ); }

}
