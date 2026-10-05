// Ruta Sur · espejos retrovisores
// --------------------------------------------------------------------------
// Cada espejo es una cámara que mira hacia atrás desde el vidrio y dibuja en
// una textura. La textura va en el vidrio del espejo de la cabina y, para no
// tener que girar la cabeza, también en un recuadro en lo alto de la pantalla.
// La imagen se invierte de izquierda a derecha, como en un espejo real: el
// costado del camión queda del lado de adentro.

import * as THREE from 'three';

const ASPECT = 0.5;      // ancho / alto del vidrio y de la textura
const FOV = 48;          // campo vertical [°]; horizontal ≈ 24°, como un espejo plano de camión
const _size = new THREE.Vector2();

export class Mirrors {

	/**
	 * renderer, scene: los del juego
	 * width: ancho de la textura en píxeles (el alto es el doble)
	 * both: true dibuja los dos espejos en cada cuadro; false, uno por cuadro
	 * far: alcance de la cámara [m]
	 */
	constructor( renderer, scene, { width = 192, both = false, far = 2500 } = {} ) {

		this.renderer = renderer;
		this.scene = scene;
		this.both = both;
		this.model = null;
		this.world = null;
		this.insets = true;         // recuadros en pantalla
		this.frame = 0;
		this.rendered = 0;          // espejos dibujados en total (para las pruebas)
		this.items = [ - 1, 1 ].map( side => {

			const target = new THREE.WebGLRenderTarget( width, width / ASPECT, { colorSpace: THREE.SRGBColorSpace } );
			// invertida como un espejo
			target.texture.repeat.x = - 1; target.texture.offset.x = 1;
			const camera = new THREE.PerspectiveCamera( FOV, ASPECT, 0.4, far );
			return { side, target, camera, element: null };

		} );

		// recuadros en pantalla: un cuadrado por espejo, dibujado con la misma textura
		this.quadScene = new THREE.Scene();
		this.quadCamera = new THREE.OrthographicCamera( - 1, 1, 1, - 1, 0, 1 );
		this.quadMat = new THREE.MeshBasicMaterial( { depthTest: false, depthWrite: false, toneMapped: false } );
		this.quadScene.add( new THREE.Mesh( new THREE.PlaneGeometry( 2, 2 ), this.quadMat ) );

	}

	// Engancha los espejos al modelo del camión (que trae un anclaje y un vidrio por lado)
	attach( model, world, elements, active = true ) {

		this.detach();
		this.model = model; this.world = world;
		for ( const m of this.items ) {

			const spot = model.mirrors.find( x => x.side === m.side );
			m.anchor = spot.anchor;
			spot.glass.material.map = m.target.texture;
			spot.glass.material.color.set( 0xffffff ); // el color multiplica a la textura
			spot.glass.material.needsUpdate = true;
			m.element = elements ? elements[ m.side < 0 ? 0 : 1 ] : null;

		}

		this.active = false;
		this.setActive( active );

	}

	// Con los espejos activos, el mundo de teselas carga lo que ven sus cámaras, con el
	// detalle que su tamaño pide. Fuera de la cabina no se dibujan y no piden nada.
	setActive( on ) {

		if ( ! this.world || on === this.active ) return;
		this.active = on;
		for ( const m of this.items ) {

			if ( on && this.world.addCamera ) this.world.addCamera( m.camera, m.target.width, m.target.height );
			else if ( ! on && this.world.removeCamera ) this.world.removeCamera( m.camera );

		}

	}

	detach() {

		if ( ! this.model ) return;
		this.setActive( false );
		for ( const m of this.items ) { m.anchor = null; m.element = null; }
		this.model = null; this.world = null;

	}

	// Dibuja las texturas de los espejos. Con `both` en falso alterna un espejo por cuadro.
	render() {

		if ( ! this.model ) return 0;
		this.frame ++;
		const renderer = this.renderer, model = this.model;
		// desde afuera se ve la cabina por fuera, no el tablero
		model.setCabinView( false );
		let n = 0;
		for ( let i = 0; i < this.items.length; i ++ ) {

			if ( ! this.both && ( this.frame + i ) % 2 ) continue;
			const m = this.items[ i ];
			m.anchor.updateWorldMatrix( true, false );
			m.anchor.matrixWorld.decompose( m.camera.position, m.camera.quaternion, m.camera.scale );
			renderer.setRenderTarget( m.target );
			renderer.render( this.scene, m.camera );
			n ++;

		}

		renderer.setRenderTarget( null );
		model.setCabinView( true );
		this.rendered += n;
		return n;

	}

	// Dibuja los recuadros sobre la imagen principal, dentro del rectángulo de cada elemento del HUD
	drawInsets() {

		if ( ! this.model || ! this.insets ) return;
		const renderer = this.renderer;
		renderer.getSize( _size );
		const H = window.innerHeight || _size.y;
		let drawn = false;
		for ( const m of this.items ) {

			if ( ! m.element ) continue;
			const r = m.element.getBoundingClientRect();
			if ( r.width < 8 || r.height < 8 ) continue;
			if ( ! drawn ) { renderer.setScissorTest( true ); drawn = true; }
			// el borde del elemento queda afuera del dibujo
			const b = 2, x = r.left + b, y = H - r.bottom + b, w = r.width - 2 * b, h = r.height - 2 * b;
			renderer.setViewport( x, y, w, h );
			renderer.setScissor( x, y, w, h );
			this.quadMat.map = m.target.texture;
			renderer.render( this.quadScene, this.quadCamera );

		}

		if ( drawn ) {

			renderer.setScissorTest( false );
			renderer.setViewport( 0, 0, _size.x, _size.y );

		}

	}

	// Resumen de una textura, para las pruebas: cuántos píxeles son claros y cuántos oscuros
	sample( side ) {

		const m = this.items.find( x => x.side === side );
		const w = m.target.width, h = m.target.height;
		const buf = new Uint8Array( w * h * 4 );
		this.renderer.readRenderTargetPixels( m.target, 0, 0, w, h, buf );
		const n = w * h, lum = new Float32Array( n );
		let sum = 0;
		for ( let i = 0, j = 0; i < buf.length; i += 4, j ++ ) { lum[ j ] = ( buf[ i ] + buf[ i + 1 ] + buf[ i + 2 ] ) / 3; sum += lum[ j ]; }
		const mean = sum / n;
		let bright = 0, dark = 0, spread = 0;
		for ( let j = 0; j < n; j ++ ) {

			if ( lum[ j ] > 150 ) bright ++; else if ( lum[ j ] < 90 ) dark ++;
			if ( Math.abs( lum[ j ] - mean ) > 25 ) spread ++;

		}

		return { width: w, height: h, bright: bright / n, dark: dark / n, spread: spread / n, mean };

	}

	dispose() {

		this.detach();
		for ( const m of this.items ) m.target.dispose();
		this.quadMat.dispose();
		this.quadScene.children[ 0 ].geometry.dispose();

	}

}
