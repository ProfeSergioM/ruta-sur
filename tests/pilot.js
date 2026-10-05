// Piloto automático para las pruebas: sigue la ruta del encargo activo.
// Se inyecta en la página; devuelve la entrada del paso ({ accel, decel, steer }).
window.__pilot = function () {

	const g = window.__rutaSur, t = g.truck, jobs = g.jobs;
	const tr = jobs && jobs.tracker;
	if ( ! tr || jobs.state !== 'active' ) return { decel: Math.abs( t.v ) > 0.2 && t.dir > 0 ? 1 : 0 };
	const rt = tr.route, v = Math.abs( t.v );
	// punto de la ruta a cierta distancia por delante
	const look = tr.along + 7 + v * 1.1;
	let i = tr.seg;
	while ( i < rt.cum.length - 2 && rt.cum[ i + 1 ] < look ) i ++;
	const a = rt.points[ i ], b = rt.points[ i + 1 ], f = Math.max( 0, Math.min( 1, ( look - rt.cum[ i ] ) / ( rt.cum[ i + 1 ] - rt.cum[ i ] || 1 ) ) );
	const tx = a.x + ( b.x - a.x ) * f, tz = a.z + ( b.z - a.z ) * f;
	// el punto de guía es el eje delantero
	const L = t.spec.tractor.wheelbase;
	const px = t.x - Math.sin( t.yaw ) * L, pz = t.z - Math.cos( t.yaw ) * L;
	const want = Math.atan2( - ( tx - px ), - ( tz - pz ) );
	let err = want - t.yaw; err = Math.atan2( Math.sin( err ), Math.cos( err ) );
	const steer = Math.max( - 1, Math.min( 1, err * 2.2 ) );
	// velocidad: lenta cerca de un giro y al llegar
	const next = tr.next(), rem = tr.remaining;
	let target = 9;
	if ( next && next.at - tr.along < 30 ) target = 3.2;
	if ( Math.abs( err ) > 0.25 ) target = Math.min( target, 3.2 );
	if ( rem < 40 ) target = Math.min( target, 3 );
	if ( rem < 9 ) target = 0;
	const accel = v < target ? Math.min( 1, ( target - v ) * 0.8 + 0.15 ) : 0;
	const decel = v > target + 0.5 || target === 0 ? Math.min( 1, ( v - target ) * 0.6 + ( target === 0 ? 0.5 : 0 ) ) : 0;
	return { accel, decel, steer };

};
