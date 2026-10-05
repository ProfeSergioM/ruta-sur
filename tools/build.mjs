// Arma el juego en un solo archivo HTML que no depende de ningún otro.
//
// Dentro del archivo quedan: los módulos de src/, las bibliotecas (Three.js y
// three-mesh-bvh) y las dos tipografías. Al abrirlo, el navegador no pide nada a
// internet. La red se usa recién al conducir por el mapa abierto: las calles y los
// edificios (Overpass).
//
// La razón: un archivo que pide sus bibliotecas a una CDN deja de funcionar donde
// esos pedidos están bloqueados, como la vista previa de una aplicación.
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve( dirname( fileURLToPath( import.meta.url ) ), '..' );
// docs/ es la carpeta que GitHub Pages publica; index.html queda en la raíz del sitio
const out = resolve( root, 'docs/index.html' );
const mod = ( ...p ) => resolve( root, 'node_modules', ...p );
const pkg = name => JSON.parse( readFileSync( mod( name, 'package.json' ), 'utf8' ) );
const KB = n => `${ ( n / 1024 ).toFixed( 0 ) } KB`;

const three = pkg( 'three' );
const VERSION = JSON.parse( readFileSync( resolve( root, 'package.json' ), 'utf8' ) ).version;
// Lo que este script afirma sobre un paquete se comprueba contra los archivos del paquete.
const expect = ( file, text ) => { if ( ! readFileSync( file, 'utf8' ).includes( text ) ) throw new Error( `${ file } ya no contiene "${ text }": revisa tools/build.mjs` ); };

// --- programa -------------------------------------------------------------------
const result = await build( {
	entryPoints: [ resolve( root, 'src/main.js' ) ],
	absWorkingDir: root,
	bundle: true,
	format: 'esm',
	write: false,
	target: 'es2022',
	charset: 'utf8',
	minify: true,
	legalComments: 'none', // los avisos de las bibliotecas van aparte, completos (ver más abajo)
	define: { __RS_VERSION__: JSON.stringify( VERSION ) },
} );

const code = result.outputFiles[ 0 ].text;
// Dentro de un <script>, estas dos secuencias cortan o confunden el programa.
if ( /<\/script/i.test( code ) ) throw new Error( 'El código contiene "</script": no se puede insertar en el HTML' );
if ( code.includes( '<!--' ) ) throw new Error( 'El código contiene "<!--": no se puede insertar en el HTML' );

// --- tipografías ----------------------------------------------------------------
// Variables y solo con el juego de caracteres latino: dos archivos cubren todos los pesos.
// El rango es el que Fontsource declara para ese juego de caracteres.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
for ( const name of [ 'overpass', 'overpass-mono' ] ) expect( mod( `@fontsource-variable/${ name }/wght.css` ), `unicode-range: ${ LATIN };` );
// Overpass clasifica el punto medio (U+00B7) como marca de acento y el navegador lo dibuja
// sin ancho, pegado a la letra siguiente. El juego lo usa como separador, así que ese
// carácter se deja fuera del rango y lo dibuja la tipografía de respaldo.
const fonts = [
	{ familia: 'Overpass', peso: '100 900', rango: LATIN.replace( 'U+0000-00FF', 'U+0000-00B6,U+00B8-00FF' ), file: mod( '@fontsource-variable/overpass/files/overpass-latin-wght-normal.woff2' ) },
	{ familia: 'Overpass Mono', peso: '300 700', rango: LATIN, file: mod( '@fontsource-variable/overpass-mono/files/overpass-mono-latin-wght-normal.woff2' ) },
].map( f => ( { familia: f.familia, peso: f.peso, rango: f.rango, datos: readFileSync( f.file ).toString( 'base64' ) } ) );

// --- avisos de las obras incluidas ----------------------------------------------
const bvh = pkg( 'three-mesh-bvh' ), overpass = pkg( '@fontsource-variable/overpass' ), mono = pkg( '@fontsource-variable/overpass-mono' );
const works = [
	`Three.js ${ three.version } (MIT). Copyright © 2010-2026 three.js authors. https://threejs.org`,
	`three-mesh-bvh ${ bvh.version } (MIT). Copyright (c) 2018 Garrett Johnson. https://github.com/gkjohnson/three-mesh-bvh`,
	`Overpass y Overpass Mono, vía Fontsource ${ overpass.version } y ${ mono.version } (SIL OFL 1.1). Copyright 2021 The Overpass Project Authors. https://github.com/RedHatOfficial/Overpass`,
];
// las líneas de derechos citadas arriba se comprueban contra los archivos de cada paquete
expect( mod( 'three/LICENSE' ), 'Copyright © 2010-2026 three.js authors' );
expect( mod( 'three-mesh-bvh/LICENSE' ), 'Copyright (c) 2018 Garrett Johnson' );
expect( mod( '@fontsource-variable/overpass/LICENSE' ), 'Copyright 2021 The Overpass Project Authors' );

const notice = `<!--
Ruta Sur ${ VERSION }. Este archivo contiene el juego completo y estas obras de terceros:
${ works.map( w => '  - ' + w ).join( '\n' ) }
Los textos de las licencias están al final del archivo.
-->`;
const licenses = [
	[ 'Three.js · licencia MIT', mod( 'three/LICENSE' ) ],
	[ 'three-mesh-bvh · licencia MIT', mod( 'three-mesh-bvh/LICENSE' ) ],
	[ 'Overpass y Overpass Mono · SIL Open Font License 1.1', mod( '@fontsource-variable/overpass/LICENSE' ) ],
].map( ( [ title, file ] ) => `${ '='.repeat( 78 ) }\n${ title }\n${ '='.repeat( 78 ) }\n${ readFileSync( file, 'utf8' ).trim() }` ).join( '\n\n' );
if ( /<\/script/i.test( licenses ) ) throw new Error( 'Un texto de licencia contiene "</script"' );
const licenseBlock = `<!-- Licencias de las obras incluidas. Es un bloque de texto: el navegador no lo ejecuta. -->\n<script type="text/plain" id="licencias">\n${ licenses }\n</script>\n`;

// --- plantilla ------------------------------------------------------------------
let html = readFileSync( resolve( root, 'src/index.template.html' ), 'utf8' );
const fill = ( mark, value ) => {

	if ( html.split( mark ).length !== 2 ) throw new Error( `La plantilla debe tener el marcador ${ mark } exactamente una vez` );
	html = html.replace( mark, () => value );

};

fill( '<!--__AVISOS__-->', notice );
fill( "'__RS_VERSION__'", JSON.stringify( VERSION ) );
fill( '/*__FUENTES__*/', `var FUENTES = ${ JSON.stringify( fonts ) };` );
fill( '/*__APP__*/', code );
fill( '</body>', `${ licenseBlock }</body>` );

// Nada debe pedirse a internet al abrir: ni hojas de estilo, ni scripts, ni mapas de importación.
const external = html.match( /<(?:link|script|img|iframe)\b[^>]*\b(?:href|src)\s*=\s*["']?https?:[^>]*>/gi ) || [];
if ( external.length || /type\s*=\s*["']?importmap/i.test( html ) ) throw new Error( `El HTML pide recursos externos al abrir: ${ external.join( ' ' ) || 'mapa de importación' }` );

mkdirSync( dirname( out ), { recursive: true } );
writeFileSync( out, html );
writeFileSync( resolve( dirname( out ), '.nojekyll' ), '' ); // GitHub Pages: servir los archivos tal cual, sin pasar por Jekyll
// la versión publicada, para que otras páginas del sitio (la portada) la muestren
writeFileSync( resolve( dirname( out ), 'version.json' ), JSON.stringify( { version: VERSION } ) + '\n' );
console.log( `docs/index.html · ${ KB( Buffer.byteLength( html ) ) } en total: programa ${ KB( Buffer.byteLength( code ) ) }, tipografías ${ KB( fonts.reduce( ( a, f ) => a + f.datos.length, 0 ) ) }, licencias ${ KB( licenses.length ) }` );
