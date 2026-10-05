// Ruta Sur · entradas: teclado, pantalla táctil y mando
// --------------------------------------------------------------------------

const KEYS = {
	accel: [ 'KeyW', 'ArrowUp' ], decel: [ 'KeyS', 'ArrowDown' ],
	left: [ 'KeyA', 'ArrowLeft' ], right: [ 'KeyD', 'ArrowRight' ],
	hand: [ 'Space' ], lookL: [ 'KeyQ' ], lookR: [ 'KeyE' ],
};

const ACTIONS = {
	KeyC: 'camera', KeyR: 'reset', KeyG: 'ghost', KeyM: 'mute', KeyH: 'help', Escape: 'pause',
	Enter: 'accept', NumpadEnter: 'accept', KeyN: 'skip', F3: 'debug', KeyP: 'pause',
};

export class Input {

	constructor( canvas, onAction ) {

		this.down = new Set();
		this.touch = { left: false, right: false, gas: false, brake: false };
		this.onAction = onAction;
		this.enabled = false;
		this.drag = { active: false, x: 0, y: 0, dx: 0, dy: 0 };
		this.state = { accel: 0, decel: 0, steer: 0, analog: false, handbrake: false, look: 0 };
		this._padButtons = [];

		window.addEventListener( 'keydown', e => {

			if ( ! this.enabled ) return;
			if ( e.target && /INPUT|TEXTAREA/.test( e.target.tagName ) ) return;
			const act = ACTIONS[ e.code ];
			if ( act ) { if ( ! e.repeat ) this.onAction( act ); e.preventDefault(); return; }
			for ( const k in KEYS ) if ( KEYS[ k ].includes( e.code ) ) { this.down.add( e.code ); e.preventDefault(); }

		} );
		window.addEventListener( 'keyup', e => this.down.delete( e.code ) );
		window.addEventListener( 'blur', () => { this.down.clear(); for ( const k in this.touch ) this.touch[ k ] = false; } );

		// arrastrar sobre la vista mueve la mirada o la cámara
		canvas.addEventListener( 'pointerdown', e => {

			this.drag.active = true; this.drag.x = e.clientX; this.drag.y = e.clientY;
			// la captura puede fallar si el puntero ya se soltó: el arrastre funciona igual mientras siga sobre la vista
			try { canvas.setPointerCapture( e.pointerId ); } catch ( err ) { /* sin captura */ }

		} );
		canvas.addEventListener( 'pointermove', e => {

			if ( ! this.drag.active ) return;
			this.drag.dx += e.clientX - this.drag.x; this.drag.dy += e.clientY - this.drag.y;
			this.drag.x = e.clientX; this.drag.y = e.clientY;

		} );
		const end = () => { this.drag.active = false; };
		canvas.addEventListener( 'pointerup', end ); canvas.addEventListener( 'pointercancel', end );

		// botones táctiles
		const bind = ( id, key ) => {

			const b = document.getElementById( id );
			if ( ! b ) return;
			const set = v => e => { e.preventDefault(); this.touch[ key ] = v; b.classList.toggle( 'activo', v ); };
			b.addEventListener( 'pointerdown', set( true ) );
			b.addEventListener( 'pointerup', set( false ) ); b.addEventListener( 'pointercancel', set( false ) ); b.addEventListener( 'pointerleave', set( false ) );

		};

		bind( 't-izq', 'left' ); bind( 't-der', 'right' ); bind( 't-gas', 'gas' ); bind( 't-freno', 'brake' );
		const tap = ( id, action ) => { const b = document.getElementById( id ); if ( b ) b.addEventListener( 'click', () => this.enabled && this.onAction( action ) ); };
		tap( 't-cam', 'camera' ); tap( 't-pausa', 'pause' );
		tap( 'guia', 'accept' ); // con pantalla táctil, tocar la guía de despacho acepta el encargo

	}

	any( name ) { for ( const c of KEYS[ name ] ) if ( this.down.has( c ) ) return true; return false; }

	// Mandos conectados. Dentro de un marco de otra página el navegador puede negar el
	// acceso a los mandos, y lo hace con una excepción: se pregunta una vez y no se insiste.
	pads() {

		if ( this._noPads || typeof navigator.getGamepads !== 'function' ) return [];
		try { return navigator.getGamepads() || []; } catch ( e ) { this._noPads = true; return []; }

	}

	// Devuelve y consume el arrastre acumulado
	takeDrag() { const d = this.drag; const out = { dx: d.dx, dy: d.dy, active: d.active }; d.dx = 0; d.dy = 0; return out; }

	read() {

		const s = this.state;
		s.accel = this.any( 'accel' ) || this.touch.gas ? 1 : 0;
		s.decel = this.any( 'decel' ) || this.touch.brake ? 1 : 0;
		s.steer = ( this.any( 'left' ) || this.touch.left ? 1 : 0 ) - ( this.any( 'right' ) || this.touch.right ? 1 : 0 );
		s.analog = false;
		s.handbrake = this.any( 'hand' );
		s.look = ( this.any( 'lookL' ) ? 1 : 0 ) - ( this.any( 'lookR' ) ? 1 : 0 );

		// mando con disposición estándar: palanca izquierda, gatillos y botones
		for ( const p of this.pads() ) {

			if ( ! p || ! p.connected || p.mapping !== 'standard' ) continue;
			const ax = p.axes[ 0 ] || 0;
			if ( Math.abs( ax ) > 0.08 ) { s.steer = - Math.sign( ax ) * Math.pow( Math.abs( ax ), 1.6 ); s.analog = true; }
			const rt = p.buttons[ 7 ] ? p.buttons[ 7 ].value : 0, lt = p.buttons[ 6 ] ? p.buttons[ 6 ].value : 0;
			if ( rt > 0.03 ) s.accel = Math.max( s.accel, rt );
			if ( lt > 0.03 ) s.decel = Math.max( s.decel, lt );
			if ( p.buttons[ 0 ] && p.buttons[ 0 ].pressed ) s.handbrake = true;
			const rx = p.axes[ 2 ] || 0;
			if ( Math.abs( rx ) > 0.15 ) s.look = - rx;
			// botones de acción, al presionar
			const map = { 3: 'camera', 1: 'accept', 2: 'reset', 9: 'pause' };
			for ( const b in map ) {

				const pressed = p.buttons[ b ] && p.buttons[ b ].pressed;
				if ( pressed && ! this._padButtons[ b ] && this.enabled ) this.onAction( map[ b ] );
				this._padButtons[ b ] = pressed;

			}

			break;

		}

		return s;

	}

}
