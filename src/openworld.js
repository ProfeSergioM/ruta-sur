// Ruta Sur · mundo del mapa abierto
// --------------------------------------------------------------------------
// La misma interfaz que TilesWorld y TestWorld, con la ciudad levantada desde
// OpenStreetMap (ver openmap.js). Pide calles y edificios a Overpass, arma los
// trozos de malla alrededor del camión a medida que se mueve y responde los
// rayos de la física con un BVH por trozo.

import * as THREE from 'three';
import { Geo } from './geo.js';
import { RayField, makeTerrain, longRay, nearRay, fetchRoads, fetchBuildings, viewBlocks, BLOCKED_ADVICE } from './world.js';
import { openCity, chunkIndex, buildOpenChunk, groundPlane, chunkOf, OPEN, LAYERS } from './openmap.js';

export class OpenWorld {

	constructor( { scene, lat, lon } ) {

		this.kind = 'open';
		this.scene = scene;
		this.geo = new Geo( lat, lon, 0 );
		this.field = new RayField();
		this.field.unlimited = true;
		this.terrain = makeTerrain( this.field );
		this.group = new THREE.Group();
		this.group.name = 'Mapa abierto';
		scene.add( this.group );
		// Cada capa se acerca un poco más a la cámara en profundidad (desplazamiento de
		// polígono), así la calzada tapa la vereda y la vereda al suelo a cualquier distancia.
		const layer = k => new THREE.MeshBasicMaterial( { vertexColors: true, polygonOffset: k !== 0, polygonOffsetFactor: - k, polygonOffsetUnits: - 2 * k } );
		this.materials = { base: layer( 0 ), walk: layer( 1 ), road: layer( 2 ), line: layer( 3 ), plane: new THREE.MeshBasicMaterial( { vertexColors: true, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 4 } ) };
		this.city = null;
		this.chunks = new Map();   // "i,j" -> { mesh (la base, para la física), meshes (todas las capas), i, j, cx, cz }
		this._all = [];
		this._since = 1;
		this.error = null;
		this.roadsData = null; this.buildingsData = null;
		this.roadsError = null; this.buildingsError = null;
		this.built = 0; this.buildMs = 0;
		this.pending = 0;          // trozos por construir dentro del radio de carga
		this.pendingNear = 0;      // trozos por construir dentro del radio que la carga espera
		this.loadT = 0;
		this.ground = this._mesh( groundPlane(), this.materials.plane );
		this._roads = fetchRoads( lat, lon, OPEN.roadsRadius ).then( r => { this.roadsData = r; return r; }, e => { this.roadsError = e; throw e; } );
		const buildings = fetchBuildings( lat, lon, OPEN.buildingsRadius ).then( b => { this.buildingsData = b; }, e => { this.buildingsError = e; } );
		Promise.allSettled( [ this._roads, buildings ] ).then( () => this._assemble() );

	}

	// La red vial, compartida con la carga de la partida (una sola consulta)
	roads() { return this._roads; }

	_assemble() {

		if ( this.disposed ) return;
		if ( ! this.roadsData && ! this.buildingsData ) {

			const blocked = viewBlocks( 'overpass-api.de', 'private.coffee' );
			this.error = blocked
				? `La vista donde está abierto el juego bloquea la conexión con OpenStreetMap. ${ BLOCKED_ADVICE } La ciudad de pruebas funciona en esta vista.`
				: `No se pudo leer OpenStreetMap: ${ ( this.roadsError && this.roadsError.message ) || 'el servicio no respondió' }. Revisa la conexión a internet y vuelve a intentar.`;
			return;

		}

		this.city = openCity( this.roadsData || { elements: [] }, this.buildingsData || { elements: [] }, this.geo );
		chunkIndex( this.city, OPEN.chunk );

	}

	_mesh( m, material, rays = true ) {

		if ( m.indices.length === 0 ) return null;
		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
		g.setAttribute( 'color', new THREE.BufferAttribute( m.colors, 3 ) );
		g.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
		const mesh = new THREE.Mesh( g, material );
		mesh.matrixAutoUpdate = false;
		this.group.add( mesh );
		mesh.updateWorldMatrix( true );
		if ( rays ) RayField.prepare( mesh );
		return mesh;

	}

	update( focus, dt ) {

		this.loadT += dt;
		if ( ! this.city ) return;
		const size = this.city.chunk;
		const ci = chunkOf( focus.x, size ), cj = chunkOf( focus.z, size );
		const span = Math.ceil( OPEN.buildRadius / size );
		// trozos que faltan, del más cercano al más lejano
		const todo = [];
		let pendingNear = 0;
		for ( let i = ci - span; i <= ci + span; i ++ ) for ( let j = cj - span; j <= cj + span; j ++ ) {

			const k = `${ i },${ j }`;
			if ( this.chunks.has( k ) ) continue;
			const d = Math.hypot( ( i + 0.5 ) * size - focus.x, ( j + 0.5 ) * size - focus.z );
			if ( d > OPEN.buildRadius ) continue;
			todo.push( { i, j, d } );
			if ( d < OPEN.readyRadius ) pendingNear ++;

		}

		todo.sort( ( a, b ) => a.d - b.d );
		this.pending = todo.length;
		this.pendingNear = pendingNear;
		// se construyen trozos mientras quede presupuesto de tiempo en el cuadro
		const t0 = performance.now(), budget = this.field.unlimited ? 12 : 5;
		for ( const c of todo ) {

			if ( performance.now() - t0 > budget && c.d > OPEN.readyRadius ) break;
			const parts = buildOpenChunk( this.city, c.i, c.j );
			const meshes = [];
			let base = null;
			for ( const name of LAYERS ) {

				const mesh = this._mesh( parts[ name ], this.materials[ name ], name === 'base' );
				if ( ! mesh ) continue;
				meshes.push( mesh );
				if ( name === 'base' ) base = mesh;

			}

			this.chunks.set( `${ c.i },${ c.j }`, { mesh: base, meshes, i: c.i, j: c.j, cx: ( c.i + 0.5 ) * size, cz: ( c.j + 0.5 ) * size } );
			this.built ++;
			this.pending --;
			if ( c.d < OPEN.readyRadius ) this.pendingNear --;
			if ( performance.now() - t0 > budget ) break;

		}

		this.buildMs += performance.now() - t0;

		// visibilidad, liberación y candidatas para los rayos
		this._since += dt;
		if ( this._since > 0.2 || this.field.meshes.length === 0 ) {

			this._since = 0;
			const near = this.field.meshes, all = this._all;
			near.length = 0; all.length = 0;
			all.push( this.ground );
			for ( const [ k, c ] of this.chunks ) {

				const d = Math.hypot( c.cx - focus.x, c.cz - focus.z );
				if ( d > OPEN.dropRadius ) { for ( const m of c.meshes ) { this.group.remove( m ); m.geometry.dispose(); } this.chunks.delete( k ); continue; }
				for ( const m of c.meshes ) m.visible = d < OPEN.showRadius;
				all.push( c.mesh );
				c.mesh.userData.rs.dist = d;
				if ( d < OPEN.nearRadius + size * 0.71 ) near.push( c.mesh );

			}

			near.sort( ( a, b ) => a.userData.rs.dist - b.userData.rs.dist );
			this.ground.userData.rs.dist = 1e9;
			near.push( this.ground ); // el suelo plano responde cuando no hay trozo (al final: es el más lejano)

		}

		this.field.budget = 1;
		this.field.prewarm();

	}

	setColumn() {}
	releaseColumn() {}
	setResolution() {}
	settle() {}
	get stalled() { return 0; }
	get tileProblem() { return null; }
	get ready() { return !! this.city && this.pendingNear === 0 && this.chunks.size > 0; }

	get progress() {

		if ( ! this.city ) return { ready: false, text: this.loadT < 8 ? 'Pidiendo las calles y los edificios a OpenStreetMap' : 'Esperando a OpenStreetMap (la consulta puede tardar hasta un minuto)', pending: 1 };
		if ( ! this.ready ) return { ready: false, text: `Levantando la ciudad desde OpenStreetMap (${ this.pending } trozos)`, pending: this.pending };
		return { ready: true, text: 'Ciudad lista', pending: 0 };

	}

	groundNear( x, z, y, above = true ) { return nearRay( this.field, x, z, y, this._all, above ); }
	groundAt( x, z ) { return longRay( this.field, x, z, this._all ); }

	attribution() { return '© OpenStreetMap contributors'; }
	get provider() { return 'OpenStreetMap'; }
	get via() { return ''; }

	stats() {

		return { visibles: this.chunks.size, activas: this.chunks.size, descargando: this.pending, fallidas: this.buildingsError ? 1 : 0, rechazadas: 0, cacheMB: 0,
			cercanas: this.field.meshes.length, rayos: this.field.rays, bvh: this.field.builds, bvhMs: this.field.buildMs,
			edificios: this.city ? this.city.buildings.length : 0, vias: this.city ? this.city.ways.length : 0 };

	}

	startHint() { return { x: 0, z: 0, yaw: Math.PI }; }

	dispose() {

		this.disposed = true;
		this.scene.remove( this.group );
		for ( const c of this.chunks.values() ) for ( const m of c.meshes ) m.geometry.dispose();
		this.chunks.clear();
		this.ground.geometry.dispose();
		for ( const m of Object.values( this.materials ) ) m.dispose();

	}

}
