// Genera un tileset 3D Tiles de la ciudad de pruebas, con la misma estructura
// que entrega Google: tileset raíz en coordenadas ECEF, tileset externo anidado,
// teselas glTF con compresión Draco, material sin iluminación, niveles de
// detalle con refinamiento por reemplazo y un parámetro de sesión en las rutas.
// Sirve para probar el camino de carga de teselas sin credenciales.
//
// Uso: node tools/make-tileset.mjs [carpeta de salida]
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRDracoMeshCompression, KHRMaterialsUnlit } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Geo } from '../src/geo.js';
import { generateCity, buildRegion, CITY } from '../src/testcity.js';

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
const out = resolve( process.argv[ 2 ] || resolve( root, 'tests/tileset' ) );
export const TILESET_ORIGIN = { lat: - 38.739141, lon: - 72.590355, h: 110 };
const SESSION = 'S1';

mkdirSync( resolve( out, 'datasets/files' ), { recursive: true } );

const io = new NodeIO()
	.registerExtensions( [ KHRDracoMeshCompression, KHRMaterialsUnlit ] )
	.registerDependencies( { 'draco3d.encoder': await draco3d.createEncoderModule(), 'draco3d.decoder': await draco3d.createDecoderModule() } );

const city = generateCity( 7 );

// El contenido glTF usa Y hacia arriba. El visor lo gira a Z arriba, y la
// transformación de la tesela lo lleva del marco este-norte-arriba a ECEF.
// Mundo del juego: +X oeste, +Y arriba, +Z norte  ->  glTF: ( -x, y, -z )
async function writeGlb( file, mesh, copyright ) {

	const doc = new Document();
	doc.getRoot().getAsset().copyright = copyright;
	const buffer = doc.createBuffer();
	const n = mesh.positions.length / 3;
	const pos = new Float32Array( n * 3 );
	let minY = Infinity, maxY = - Infinity;
	for ( let i = 0; i < n; i ++ ) {

		pos[ i * 3 ] = - mesh.positions[ i * 3 ];
		pos[ i * 3 + 1 ] = mesh.positions[ i * 3 + 1 ];
		pos[ i * 3 + 2 ] = - mesh.positions[ i * 3 + 2 ];
		minY = Math.min( minY, pos[ i * 3 + 1 ] ); maxY = Math.max( maxY, pos[ i * 3 + 1 ] );

	}

	const position = doc.createAccessor().setType( 'VEC3' ).setArray( pos ).setBuffer( buffer );
	const color = doc.createAccessor().setType( 'VEC3' ).setArray( mesh.colors ).setBuffer( buffer );
	const indices = doc.createAccessor().setType( 'SCALAR' ).setArray( mesh.indices ).setBuffer( buffer );
	const material = doc.createMaterial( 'malla' ).setExtension( 'KHR_materials_unlit', doc.createExtension( KHRMaterialsUnlit ).createUnlit() );
	const prim = doc.createPrimitive().setAttribute( 'POSITION', position ).setAttribute( 'COLOR_0', color ).setIndices( indices ).setMaterial( material );
	doc.createScene().addChild( doc.createNode().setMesh( doc.createMesh().addPrimitive( prim ) ) );
	doc.createExtension( KHRDracoMeshCompression ).setRequired( true ).setEncoderOptions( { method: KHRDracoMeshCompression.EncoderMethod.EDGEBREAKER, quantizePosition: 14, quantizeColor: 8 } );
	const glb = await io.writeBinary( doc );
	writeFileSync( resolve( out, file ), glb );
	return { minY, maxY, bytes: glb.byteLength, triangles: mesh.indices.length / 3 };

}

// caja envolvente en el marco de la tesela (este, norte, arriba)
function boxOf( x0, z0, x1, z1, minY, maxY ) {

	const e0 = - x1, e1 = - x0; // este = -x
	return [ ( e0 + e1 ) / 2, ( z0 + z1 ) / 2, ( minY + maxY ) / 2, ( e1 - e0 ) / 2, 0, 0, 0, ( z1 - z0 ) / 2, 0, 0, 0, Math.max( 1, ( maxY - minY ) / 2 ) ];

}

const E = CITY.extent; // la ciudad cubre [-E, E]
const uri = f => `${ f }?session=${ SESSION }`;
let bytes = 0, tris = 0, files = 0;
const note = r => { bytes += r.bytes; tris += r.triangles; files ++; };

// nivel 0: toda la ciudad, muy gruesa y 1 m más arriba
const l0 = await writeGlb( 'datasets/files/L0.glb', buildRegion( city, - E, - E, E, E, { step: 26, detail: false, lift: 1.0, rough: false } ), 'Ciudad de pruebas;Ruta Sur' );
note( l0 );

// nivel 1: 4 x 4 teselas de 260 m; nivel 2: 8 x 8 de 130 m con todo el detalle
const S1 = 2 * E / 4, S2 = 2 * E / 8;
const children = [];
for ( let i = 0; i < 4; i ++ ) for ( let j = 0; j < 4; j ++ ) {

	const x0 = - E + i * S1, z0 = - E + j * S1;
	const r1 = await writeGlb( `datasets/files/L1_${ i }_${ j }.glb`, buildRegion( city, x0, z0, x0 + S1, z0 + S1, { step: 6.5, detail: false, lift: 0.25, rough: false } ), 'Ciudad de pruebas;Ruta Sur' );
	note( r1 );
	const kids = [];
	let minY = r1.minY, maxY = r1.maxY;
	for ( let a = 0; a < 2; a ++ ) for ( let b = 0; b < 2; b ++ ) {

		const xx = x0 + a * S2, zz = z0 + b * S2;
		const r2 = await writeGlb( `datasets/files/L2_${ i * 2 + a }_${ j * 2 + b }.glb`, buildRegion( city, xx, zz, xx + S2, zz + S2, { step: 1 } ), 'Ciudad de pruebas;Ruta Sur;Malla fina' );
		note( r2 );
		minY = Math.min( minY, r2.minY ); maxY = Math.max( maxY, r2.maxY );
		kids.push( { boundingVolume: { box: boxOf( xx, zz, xx + S2, zz + S2, r2.minY, r2.maxY ) }, geometricError: 0, content: { uri: uri( `files/L2_${ i * 2 + a }_${ j * 2 + b }.glb` ) } } );

	}

	children.push( { boundingVolume: { box: boxOf( x0, z0, x0 + S1, z0 + S1, minY, maxY ) }, geometricError: 10, refine: 'REPLACE', content: { uri: uri( `files/L1_${ i }_${ j }.glb` ) }, children: kids } );

}

const allBox = boxOf( - E, - E, E, E, - 20, 80 );
const cityTileset = {
	asset: { version: '1.0' },
	geometricError: 40,
	root: { boundingVolume: { box: allBox }, geometricError: 40, refine: 'REPLACE', content: { uri: uri( 'files/L0.glb' ) }, children },
};
writeFileSync( resolve( out, 'datasets/city.json' ), JSON.stringify( cityTileset ) );

// tileset raíz: fija la ciudad en el planeta y apunta al tileset anidado
const geo = new Geo( TILESET_ORIGIN.lat, TILESET_ORIGIN.lon, TILESET_ORIGIN.h );
const transform = [ ...geo.e, 0, ...geo.n, 0, ...geo.u, 0, ...geo.origin, 1 ];
const rootTileset = {
	asset: { version: '1.0' },
	geometricError: 200,
	root: {
		boundingVolume: { box: allBox }, transform, geometricError: 200, refine: 'REPLACE',
		children: [ { boundingVolume: { box: allBox }, geometricError: 80, content: { uri: uri( 'datasets/city.json' ) } } ],
	},
};
writeFileSync( resolve( out, 'root.json' ), JSON.stringify( rootTileset ) );
console.log( `Tileset de prueba en ${ out }: ${ files } teselas, ${ ( tris / 1e6 ).toFixed( 2 ) } M de triángulos, ${ ( bytes / 2 ** 20 ).toFixed( 1 ) } MB (Draco)` );
