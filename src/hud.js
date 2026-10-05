// Ruta Sur · tablero y avisos en pantalla
// --------------------------------------------------------------------------
import { forSegmentsIn } from './osm.js';

const $ = id => document.getElementById( id );
const nf = new Intl.NumberFormat( 'es-CL' );

export function fmtDist( m ) {

	if ( m < 950 ) return `${ Math.max( 10, Math.round( m / 10 ) * 10 ) } m`;
	return `${ ( m / 1000 ).toLocaleString( 'es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 } ) } km`;

}

export const fmtPesos = v => `$ ${ nf.format( Math.round( v ) ) }`;

export class Hud {

	constructor() {

		this.el = $( 'hud' );
		this.vel = $( 'velocidad' ); this.marcha = $( 'marcha' ); this.rpmBar = document.querySelector( '#rpm .barra' ); this.rpmFill = this.rpmBar.firstElementChild;
		this.limite = $( 'limite' );
		this.aviso = $( 'aviso' );
		this.maniobra = $( 'maniobra' );
		this.canvas = $( 'minimapa' );
		this.ctx = this.canvas.getContext( '2d' );
		this.depura = $( 'depura' );
		this._toastT = 0;
		this._last = {};

	}

	show( on ) { this.el.hidden = ! on; }

	// Escribe solo cuando el texto cambia, para no tocar el DOM en cada cuadro
	text( id, value ) {

		if ( this._last[ id ] === value ) return;
		this._last[ id ] = value;
		$( id ).textContent = value;

	}

	setDrive( kmh, gear, rpm, limit ) {

		this.text( 'velocidad', String( Math.round( kmh ) ) );
		this.text( 'marcha', gear );
		const f = Math.max( 0, Math.min( 1, ( rpm - 500 ) / 2000 ) );
		this.rpmFill.style.width = ( f * 100 ).toFixed( 1 ) + '%';
		this.limite.hidden = ! limit;
		if ( limit ) {

			this.text( 'limite', String( limit ) );
			this.limite.classList.toggle( 'excede', kmh > limit + 4 );

		}

	}

	setRpmHigh( on ) { this.rpmBar.classList.toggle( 'alto', on ); }

	setJob( j ) {

		// j: { folio, carga, destino, faltan, pago, dano, timbre, ok, pista, caja }
		this.text( 'g-folio', j.folio );
		this.text( 'g-carga', j.carga );
		this.text( 'g-destino', j.destino );
		this.row( 'g-faltan', j.faltan );
		this.row( 'g-pago', j.pago );
		this.text( 'g-dano', j.dano );
		this.text( 'g-timbre', j.timbre );
		$( 'g-timbre' ).classList.toggle( 'ok', !! j.ok );
		this.text( 'g-pista', j.pista );
		this.text( 'caja', j.caja );

	}

	// renglón de la guía: sin dato, se oculta junto con su rótulo
	row( id, value ) {

		const dd = $( id ), empty = value === '' || value === null || value === undefined;
		this.text( id, empty ? '' : value );
		if ( dd.hidden !== empty ) { dd.hidden = empty; if ( dd.previousElementSibling ) dd.previousElementSibling.hidden = empty; }

	}

	setManeuver( m ) {

		// m: { dist, texto, lado } o null
		this.maniobra.hidden = ! m;
		if ( ! m ) return;
		this.text( 'm-dist', m.dist );
		this.text( 'm-texto', m.texto );
		if ( this.maniobra.dataset.lado !== m.lado ) this.maniobra.dataset.lado = m.lado;

	}

	toast( text, kind = '', seconds = 3.5 ) {

		this.aviso.textContent = text;
		this.aviso.className = 'panel' + ( kind ? ' ' + kind : '' );
		this.aviso.hidden = false;
		this._toastT = seconds;

	}

	// hay un aviso en pantalla
	get busy() { return this._toastT > 0; }

	setAttribution( provider, sources, via ) {

		this.text( 'a-logo', provider );
		this.text( 'a-fuentes', sources );
		this.text( 'a-via', via );

	}

	setDebug( text ) {

		this.depura.hidden = text === null;
		if ( text !== null ) this.depura.textContent = text;

	}

	update( dt ) {

		if ( this._toastT > 0 ) {

			this._toastT -= dt;
			if ( this._toastT <= 0 ) this.aviso.hidden = true;

		}

	}

	/**
	 * Minimapa con el rumbo del camión hacia arriba.
	 * g: grafo vial (o null); t: camión; tracker: seguimiento de ruta (o null); dest: { x, z } (o null)
	 */
	drawMap( g, t, tracker, dest ) {

		const ctx = this.ctx, S = this.canvas.width, cx = S / 2, cy = S * 0.6;
		const R = 240;                      // metros visibles hacia adelante
		const k = ( S * 0.6 ) / R;
		ctx.setTransform( 1, 0, 0, 1, 0, 0 );
		ctx.fillStyle = '#1b2024';
		ctx.fillRect( 0, 0, S, S );

		const fx = - Math.sin( t.yaw ), fz = - Math.cos( t.yaw ), rx = Math.cos( t.yaw ), rz = - Math.sin( t.yaw );
		const X = ( wx, wz ) => cx + ( ( wx - t.x ) * rx + ( wz - t.z ) * rz ) * k;
		const Y = ( wx, wz ) => cy - ( ( wx - t.x ) * fx + ( wz - t.z ) * fz ) * k;

		ctx.lineCap = 'round'; ctx.lineJoin = 'round';
		if ( g ) {

			const ext = R * 1.5;
			// dos pasadas: calles menores debajo, vías principales encima
			for ( let pass = 0; pass < 2; pass ++ ) {

				ctx.beginPath();
				forSegmentsIn( g, t.x - ext, t.z - ext, t.x + ext, t.z + ext, ( w, i, ax, az, bx, bz ) => {

					if ( ( w.rank <= 4 ) !== ( pass === 1 ) ) return;
					ctx.moveTo( X( ax, az ), Y( ax, az ) ); ctx.lineTo( X( bx, bz ), Y( bx, bz ) );

				} );
				ctx.strokeStyle = pass === 1 ? '#9aa5ab' : '#59646b';
				ctx.lineWidth = pass === 1 ? 9 : 5.5;
				ctx.stroke();

			}

		}

		if ( tracker ) {

			const pts = tracker.route.points;
			ctx.beginPath();
			ctx.moveTo( X( t.x, t.z ), Y( t.x, t.z ) );
			for ( let i = tracker.seg + 1; i < pts.length; i ++ ) ctx.lineTo( X( pts[ i ].x, pts[ i ].z ), Y( pts[ i ].x, pts[ i ].z ) );
			ctx.strokeStyle = '#f2a33a'; ctx.lineWidth = 6;
			ctx.stroke();

		}

		if ( dest ) {

			// si el destino queda fuera del círculo, se dibuja en el borde
			let dx = X( dest.x, dest.z ) - cx, dy = Y( dest.x, dest.z ) - S / 2;
			const lim = S / 2 - 22, d = Math.hypot( dx, dy );
			if ( d > lim ) { dx *= lim / d; dy *= lim / d; }
			ctx.beginPath(); ctx.arc( cx + dx, S / 2 + dy, 11, 0, 7 );
			ctx.fillStyle = '#12915f'; ctx.fill();
			ctx.lineWidth = 4; ctx.strokeStyle = '#f4f1e6'; ctx.stroke();

		}

		// el camión
		ctx.beginPath();
		ctx.moveTo( cx, cy - 17 ); ctx.lineTo( cx + 11, cy + 12 ); ctx.lineTo( cx, cy + 6 ); ctx.lineTo( cx - 11, cy + 12 ); ctx.closePath();
		ctx.fillStyle = '#f4f1e6'; ctx.fill();
		ctx.lineWidth = 3; ctx.strokeStyle = '#14171a'; ctx.stroke();

		// norte: +Z del mundo
		const nx = rz, ny = - fz, nl = Math.hypot( nx, ny ) || 1;
		const px = S / 2 + nx / nl * ( S / 2 - 20 ), py = S / 2 + ny / nl * ( S / 2 - 20 );
		ctx.font = '800 22px Overpass, Arial, sans-serif';
		ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
		ctx.fillStyle = '#f2a33a';
		ctx.fillText( 'N', px, py + 2 );

	}

}
