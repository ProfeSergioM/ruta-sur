// Ruta Sur · sonido sintetizado
// --------------------------------------------------------------------------
// Un motor diésel de seis cilindros hecho con osciladores (la frecuencia de
// encendido es rpm / 20), ruido de rodadura, silbido del turbo, la alarma de
// retroceso y el golpe de un choque. No usa archivos de audio.

// Suspender y reanudar el audio devuelven promesas. Si el navegador las rechaza
// (audio no permitido, contexto cerrado), no hay nada que hacer ni que informar.
const quiet = p => { if ( p && typeof p.catch === 'function' ) p.catch( () => {} ); };

export class Sound {

	constructor() { this.ctx = null; this.muted = false; this._beep = 0; this._wasMoving = false; }

	start() {

		if ( this.ctx ) { quiet( this.ctx.resume() ); return; }
		const AC = window.AudioContext || window.webkitAudioContext;
		if ( ! AC ) return;
		// Si el navegador o la vista no dejan abrir el audio, el juego sigue sin sonido.
		let ctx;
		try { ctx = new AC(); } catch ( e ) { return; }
		this.ctx = ctx;
		const master = this.master = ctx.createGain();
		master.gain.value = this.muted ? 0 : 0.6;
		master.connect( ctx.destination );

		// motor
		const mk = ( type, gain ) => { const o = ctx.createOscillator(); o.type = type; const g = ctx.createGain(); g.gain.value = gain; o.connect( g ); o.start(); return [ o, g ]; };
		this.osc = [ mk( 'sawtooth', 0.5 ), mk( 'square', 0.35 ), mk( 'sawtooth', 0.3 ) ];
		this.engineFilter = ctx.createBiquadFilter(); this.engineFilter.type = 'lowpass'; this.engineFilter.Q.value = 1.2;
		this.engineGain = ctx.createGain(); this.engineGain.gain.value = 0;
		for ( const [ , g ] of this.osc ) g.connect( this.engineFilter );
		this.engineFilter.connect( this.engineGain ); this.engineGain.connect( master );

		// ruido blanco en bucle, para la rodadura, el turbo y los golpes
		const len = ctx.sampleRate * 2, buf = ctx.createBuffer( 1, len, ctx.sampleRate ), data = buf.getChannelData( 0 );
		for ( let i = 0; i < len; i ++ ) data[ i ] = Math.random() * 2 - 1;
		this.noiseBuffer = buf;
		const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true; noise.start();
		const road = ctx.createBiquadFilter(); road.type = 'lowpass'; road.frequency.value = 320;
		this.roadGain = ctx.createGain(); this.roadGain.gain.value = 0;
		noise.connect( road ); road.connect( this.roadGain ); this.roadGain.connect( master );
		const turbo = ctx.createBiquadFilter(); turbo.type = 'bandpass'; turbo.frequency.value = 2600; turbo.Q.value = 9;
		this.turbo = turbo;
		this.turboGain = ctx.createGain(); this.turboGain.gain.value = 0;
		noise.connect( turbo ); turbo.connect( this.turboGain ); this.turboGain.connect( master );

		// alarma de retroceso
		const beep = ctx.createOscillator(); beep.type = 'square'; beep.frequency.value = 1250; beep.start();
		this.beepGain = ctx.createGain(); this.beepGain.gain.value = 0;
		beep.connect( this.beepGain ); this.beepGain.connect( master );

	}

	// Deja en cero todo lo que suena de forma continua. Al volver al inicio el contexto
	// de audio se suspende con las ganancias como estaban; sin esto, la partida
	// siguiente empezaría con el motor de la anterior sonando durante la carga.
	silence() {

		if ( ! this.ctx ) return;
		for ( const g of [ this.engineGain, this.roadGain, this.turboGain, this.beepGain ] ) if ( g ) { g.gain.cancelScheduledValues( this.ctx.currentTime ); g.gain.value = 0; }
		this._beep = 0; this._wasMoving = false;

	}

	setMuted( m ) {

		this.muted = m;
		if ( this.master ) this.master.gain.setTargetAtTime( m ? 0 : 0.6, this.ctx.currentTime, 0.05 );

	}

	// Ráfaga de ruido filtrado: golpe (grave) o descarga de aire (agudo)
	burst( freq, type, gain, seconds ) {

		const ctx = this.ctx;
		if ( ! ctx ) return;
		const src = ctx.createBufferSource(); src.buffer = this.noiseBuffer;
		const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq;
		const g = ctx.createGain();
		const now = ctx.currentTime;
		g.gain.setValueAtTime( gain, now ); g.gain.exponentialRampToValueAtTime( 0.0001, now + seconds );
		src.connect( f ); f.connect( g ); g.connect( this.master );
		src.start( now, Math.random() ); src.stop( now + seconds + 0.05 );

	}

	thud( strength ) { this.burst( 160, 'lowpass', Math.min( 1.2, 0.25 + strength * 0.12 ), 0.35 ); }
	hiss() { this.burst( 3500, 'highpass', 0.12, 0.45 ); }
	bump() { this.burst( 90, 'lowpass', 0.5, 0.18 ); }

	update( t, dt ) {

		const ctx = this.ctx;
		if ( ! ctx ) return;
		const now = ctx.currentTime, k = 0.05;
		const f = Math.max( 20, t.rpm / 20 );
		this.osc[ 0 ][ 0 ].frequency.setTargetAtTime( f, now, k );
		this.osc[ 1 ][ 0 ].frequency.setTargetAtTime( f / 2, now, k );
		this.osc[ 2 ][ 0 ].frequency.setTargetAtTime( f * 1.012, now, k );
		this.engineFilter.frequency.setTargetAtTime( 170 + t.throttle * 520 + t.rpm * 0.14, now, k );
		this.engineGain.gain.setTargetAtTime( 0.07 + t.throttle * 0.11, now, k );

		const v = Math.abs( t.v );
		this.roadGain.gain.setTargetAtTime( Math.min( 0.22, v / 25 * 0.22 ), now, 0.2 );
		const boost = t.throttle * Math.max( 0, ( t.rpm - 900 ) / 1100 );
		this.turbo.frequency.setTargetAtTime( 1800 + t.rpm * 0.9, now, 0.1 );
		this.turboGain.gain.setTargetAtTime( boost * 0.035, now, 0.15 );

		// alarma de retroceso: medio segundo sí, medio segundo no
		let beep = 0;
		if ( t.dir < 0 && ( v > 0.15 || t.throttle > 0.05 ) ) { this._beep += dt; beep = this._beep % 0.9 < 0.45 ? 0.035 : 0; } else this._beep = 0;
		this.beepGain.gain.setTargetAtTime( beep, now, 0.01 );

		// descarga de aire al detenerse con el freno
		const moving = v > 0.8;
		if ( this._wasMoving && v < 0.05 && t.brake > 0.2 ) { this.hiss(); this._wasMoving = false; }
		if ( moving ) this._wasMoving = true;

	}

	stop() { if ( this.ctx ) quiet( this.ctx.suspend() ); }

}
