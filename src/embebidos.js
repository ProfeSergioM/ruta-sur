// Ruta Sur · recursos que viajan dentro del archivo del juego
// --------------------------------------------------------------------------
// Al armar el juego, tools/build.mjs reemplaza este módulo por otro con el mismo
// contrato y los datos adentro. Con eso el archivo final abre sin pedir nada a
// internet: solo el mapa y las calles salen a la red, y recién al conducir.
//
// Usados como módulos sueltos (las pruebas numéricas, por ejemplo), no hay nada
// incluido y el código que los usa recurre a su alternativa en la red.

/**
 * Decodificador Draco de las teselas (variante glTF de la biblioteca de Google):
 * { wrapper: texto del envoltorio de JavaScript, wasm: binario WebAssembly en base64 }
 */
export const DRACO = null;

// Bytes de un texto en base64
export function bytesFromBase64( text ) {

	const bin = atob( text ), out = new Uint8Array( bin.length );
	for ( let i = 0; i < bin.length; i ++ ) out[ i ] = bin.charCodeAt( i );
	return out;

}
