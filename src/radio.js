// Ruta Sur · radio
// --------------------------------------------------------------------------
// Radios chilenas con transmisión gratuita por internet, para escuchar mientras
// se maneja. El juego solo reproduce la transmisión pública de cada emisora, con
// el elemento de audio del navegador; no la guarda ni la retransmite. Las
// direcciones las publican las emisoras y pueden cambiar sin aviso: si una deja
// de sonar, se puede pegar otra dirección en la pausa.

export const STATIONS = [
	{ id: 'adn', name: 'ADN Radio', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/ADNAAC.aac', home: 'https://www.adnradio.cl/' },
	{ id: 'cooperativa', name: 'Cooperativa', url: 'https://unlimited3-cl.dps.live/cooperativafm/mp3/icecast.audio', home: 'https://www.cooperativa.cl/' },
	{ id: 'futuro', name: 'Futuro', url: 'https://playerservices.streamtheworld.com/api/livestream-redirect/FUTUROAAC.aac', home: 'https://www.futuro.cl/' },
];

export class Radio {

	/**
	 * onState( radio ) se llama en cada cambio: apagada, conectando, sonando o error.
	 */
	constructor( { onState = null, volume = 0.7 } = {} ) {

		this.audio = null;
		this.current = null;      // emisora en curso, o null
		this.state = 'off';       // off | connecting | playing | error
		this.error = null;
		this.muted = false;
		this.volume = volume;
		this.custom = '';         // dirección pegada por la persona
		this.onState = onState;

	}

	// Las emisoras disponibles, con la dirección propia al final si hay una
	get stations() {

		return this.custom ? STATIONS.concat( [ { id: 'propia', name: 'Dirección propia', url: this.custom, home: '' } ] ) : STATIONS;

	}

	_ensure() {

		if ( this.audio || typeof Audio === 'undefined' ) return this.audio;
		const a = this.audio = new Audio();
		a.preload = 'none';
		a.volume = this.volume;
		a.muted = this.muted;
		a.addEventListener( 'playing', () => this._set( 'playing' ) );
		a.addEventListener( 'error', () => this._set( 'error', 'la emisora no respondió' ) );
		a.addEventListener( 'stalled', () => { if ( this.state === 'playing' ) this._set( 'connecting' ); } );
		return a;

	}

	_set( state, error = null ) {

		if ( state === this.state && error === this.error ) return;
		this.state = state; this.error = error;
		if ( this.onState ) this.onState( this );

	}

	play( station ) {

		const a = this._ensure();
		if ( ! a || ! station ) return false;
		this.current = station;
		a.src = station.url;
		this._set( 'connecting' );
		const p = a.play();
		// el navegador puede rechazar la reproducción (sin gesto de la persona, formato que no entiende, red)
		if ( p && typeof p.catch === 'function' ) p.catch( e => { if ( this.current === station ) this._set( 'error', e && e.name === 'NotSupportedError' ? 'el navegador no entiende la transmisión' : 'no se pudo conectar' ); } );
		return true;

	}

	stop() {

		this.current = null;
		if ( this.audio ) { this.audio.pause(); this.audio.removeAttribute( 'src' ); try { this.audio.load(); } catch ( e ) { /* sin fuente */ } }
		this._set( 'off' );

	}

	// La emisora siguiente de la lista; después de la última, apagada
	next() {

		const list = this.stations;
		const i = this.current ? list.findIndex( s => s.id === this.current.id ) : - 1;
		if ( i + 1 >= list.length ) { this.stop(); return null; }
		this.play( list[ i + 1 ] );
		return list[ i + 1 ];

	}

	setCustom( url ) {

		this.custom = String( url || '' ).trim();
		if ( this.custom && ! /^https?:\/\//i.test( this.custom ) ) this.custom = '';
		return this.custom;

	}

	setMuted( m ) { this.muted = m; if ( this.audio ) this.audio.muted = m; }

	// Texto corto para los avisos
	get label() {

		if ( ! this.current ) return 'Radio apagada';
		if ( this.state === 'connecting' ) return `Radio: ${ this.current.name } (conectando)`;
		if ( this.state === 'error' ) return `Radio: ${ this.current.name } no suena (${ this.error })`;
		return `Radio: ${ this.current.name }`;

	}

}
