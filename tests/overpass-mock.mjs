// Respuesta que daría Overpass a una consulta, según los niveles de detalle de
// Overpass QL (wiki de OpenStreetMap, sentencia "out"):
//   ids   solo identificadores
//   skel  identificadores y miembros (los nodos de cada vía)
//   body  lo anterior más las etiquetas (es el nivel por omisión)
//   tags  identificadores y etiquetas, sin coordenadas ni miembros
//   meta  body más versión, fecha y autor
// El modificador "geom" agrega la geometría completa a cada objeto.
// `full` es la red completa, con nodos, geometría y etiquetas en cada vía.
export function overpassAnswer( query, full ) {

	const out = ( ( query.match( /out\s+([^;]*);/ ) || [ '', '' ] )[ 1 ] ).trim().split( /\s+/ );
	const level = [ 'ids', 'skel', 'body', 'tags', 'meta' ].find( l => out.includes( l ) ) || 'body';
	const geom = out.includes( 'geom' );
	return {
		elements: full.elements.map( e => {

			const o = { type: e.type, id: e.id };
			if ( level === 'skel' || level === 'body' || level === 'meta' ) o.nodes = e.nodes;
			if ( geom ) o.geometry = e.geometry;
			if ( level === 'body' || level === 'tags' || level === 'meta' ) o.tags = e.tags;
			return o;

		} ),
	};

}
