# Ruta Sur

Simulador de camiones que corre en el navegador sobre la malla 3D fotorrealista de Google, la misma que muestra Google Earth. El jugador conduce un tracto con semirremolque, o un camión rígido, por las calles de una ciudad real y reparte cargas entre esquinas.

Este es un prototipo. Su propósito es responder una pregunta antes de invertir más: si la malla de Google, vista desde la cabina de un camión, alcanza para un juego de conducción.

**Jugar en línea:** https://profesergiom.github.io/ruta-sur/

## Cómo jugar

1. Abre https://profesergiom.github.io/ruta-sur/ en Chrome o Edge. También puedes guardar `docs/index.html` en el computador y abrirlo con doble clic: es el mismo archivo y funciona igual. Las pruebas corren en Chromium, el motor de ambos navegadores. Firefox no se probó.
2. Elige "Ciudad de pruebas, sin credencial" para manejar de inmediato en una ciudad generada. Sirve para conocer los controles y, abierta como archivo, funciona sin conexión a internet.
3. Para manejar sobre el mapa real, pega una credencial (ver abajo), elige ciudad y presiona "Conducir". Esta parte necesita internet.

El archivo trae adentro todo lo que el juego necesita: el programa, las bibliotecas, las tipografías y el decodificador de las teselas. Al abrirse no pide nada a la red. La red se usa recién al conducir sobre el mapa real, para pedir las teselas (a Google o a Cesium ion) y las calles (a Overpass).

### Si se abre dentro de otra aplicación

La vista previa de una aplicación muestra el archivo en un marco aislado, que no deja salir pedidos a otros servidores. Ahí el juego abre y la ciudad de pruebas se puede manejar. El mapa real necesita conectarse con los servicios de mapas: cuando la vista bloquea esa conexión, el juego lo dice en pantalla y pide abrir el archivo en el navegador. La pantalla inicial lo anticipa con una nota.

En un marco aislado tampoco hay almacenamiento: la credencial y la caja de los encargos duran lo que dura la visita.

### Credencial del mapa

El juego acepta cualquiera de las dos.

**Cesium ion**, sin tarjeta y gratis para uso personal:

1. Crea una cuenta en https://ion.cesium.com.
2. En *Access Tokens*, copia el token por defecto.
3. Pégalo en el campo "Credencial del mapa".

Si el juego avisa que la cuenta no tiene el recurso "Google Photorealistic 3D Tiles", agrégalo desde *Asset Depot*.

**Google Maps Platform**, con cuenta de facturación: habilita la Map Tiles API en un proyecto y crea una clave. Si juegas en https://profesergiom.github.io/ruta-sur/, conviene restringir la clave a ese sitio (`profesergiom.github.io`). Si abres el archivo con doble clic, la clave debe quedar sin restricción de sitio web, porque un archivo local no tiene sitio.

La credencial se guarda solo en el navegador (`localStorage`).

### Controles

| Tecla | Acción |
|---|---|
| W A S D o flechas | Acelerar, girar y frenar. Detenido, mantener "atrás" engancha la reversa |
| Espacio | Freno de mano |
| C | Cámara: cabina, exterior, cenital |
| Q, E o arrastrar | Mirar a los lados |
| V | Espejos en pantalla: mostrar u ocultar los recuadros |
| Enter, N | Aceptar el encargo, pedir otro |
| R | Volver a la calle más cercana |
| G | Activar o desactivar los choques |
| M, F3 | Sonido, datos técnicos |
| Esc o P | Pausa |

Con pantalla táctil aparecen botones en pantalla, y la guía de despacho se toca para aceptar el encargo. También funciona un mando con disposición estándar.

## Cómo está hecho

El juego es un solo archivo HTML sin dependencias externas. `tools/build.mjs` une con esbuild los módulos de `src/` y las bibliotecas (Three.js, 3d-tiles-renderer y three-mesh-bvh), agrega el decodificador Draco y las tipografías, y lo inserta todo en `src/index.template.html`. El resultado, `docs/index.html`, pesa cerca de 1,4 MB. GitHub Pages publica la carpeta `docs/` tal cual, así que ese archivo es a la vez el juego en línea y el que se puede descargar.

La primera versión pedía las bibliotecas y las tipografías a servidores externos al abrirse. Bastaba que esos pedidos estuvieran bloqueados, como ocurre en la vista previa de una aplicación, para que la página quedara sin programa. Por eso ahora todo viaja en el archivo.

| Módulo | Qué hace |
|---|---|
| `physics.js` | Modelo del camión: bicicleta cinemática, semirremolque articulado, motor diésel con caja automatizada, frenos, retardador, choques y seguimiento del suelo sobre una malla ruidosa. No depende de Three.js |
| `world.js` | El mundo. `TilesWorld` carga las teselas de Google (directo o por Cesium ion) y responde los rayos de la física con un BVH por malla. `TestWorld` es la ciudad de pruebas. También reconoce cuando la vista bloquea la conexión con los servicios |
| `osm.js` | Red vial de OpenStreetMap: grafo, ruta sin vueltas en U, indicaciones, seguimiento del avance, destinos y punto de aparición |
| `jobs.js` | Encargos: carga, destino, pago, bono de puntualidad, descuento por daño |
| `geo.js` | Conversión entre latitud y longitud y las coordenadas del juego (WGS84) |
| `truck-model.js`, `hud.js`, `audio.js`, `input.js` | Modelo 3D del camión, tablero y minimapa, sonido sintetizado, teclado, táctil y mando |
| `mirrors.js` | Espejos retrovisores: una cámara por espejo dibuja en una textura que va en el vidrio de la cabina y en los recuadros de la pantalla |
| `main.js` | Pantalla inicial, carga, bucle principal y cámaras |
| `testcity.js` | Ciudad de pruebas generada, también usada para fabricar un tileset de prueba |
| `embebidos.js` | Contrato de los recursos que el armado mete en el archivo (el decodificador Draco) |

La plantilla lleva además una **guardia de arranque**: un script corto, escrito con sintaxis antigua, que corre antes que el programa. Instala las tipografías, anota los errores sin atender y los muestra como un informe que se puede copiar. Si el programa no arranca (navegador antiguo, sin WebGL 2, vista que no ejecuta scripts), la página lo dice y propone la salida. El informe cita el archivo por su nombre, sin la ruta del computador.

Convención de ejes: +X al oeste, +Y arriba, +Z al norte, con origen en el punto elegido. Es la que entrega el complemento de reorientación de la biblioteca de teselas.

### Choques

El camión choca con lo que la malla tenga a un metro del suelo. Dos familias de sondas lo cuidan. Las del parachoques y de la cola miran en el sentido de marcha y recortan el avance a la distancia libre. Las de los costados vigilan los flancos de cada unidad, porque en una curva el semirremolque corta la esquina y su costado alcanza lo que el tracto esquivó. Cada punto del flanco lanza un rayo desde donde está hacia donde iría en el paso, y un rayo más recorre cada flanco de punta a punta para atrapar una esquina ajena que entre entre dos puntos. Un movimiento que se aleja del obstáculo nunca se bloquea, así que de un roce siempre se sale en reversa. La velocidad de acercamiento se mide según la normal de la superficie tocada: un roce tangencial detiene el camión sin dañarlo, y un costalazo descuenta como un choque frontal.

### Espejos

Cada espejo es una cámara que mira hacia atrás desde el vidrio, 7° hacia afuera, y dibuja en una textura. La textura va en el vidrio del espejo de la cabina (el derecho aparece al mirar a la derecha con E) y, para no tener que girar la cabeza, en dos recuadros en lo alto de la pantalla que la tecla V oculta. La imagen se invierte de izquierda a derecha, como en un espejo real. En calidad baja y media se refresca un espejo por cuadro; en alta, los dos. Sobre el mapa real, las cámaras de los espejos piden sus propias teselas al cargador, con el detalle que corresponde a su tamaño.

La malla de Google trae forma y textura, pero no sabe qué es una calle. Por eso la red vial sale de OpenStreetMap. Con ella el juego elige dónde aparece el camión, genera destinos alcanzables, calcula la ruta y dibuja el minimapa.

## Pruebas

```
npm install
npm test          # pruebas numéricas, sin navegador (247 comprobaciones)
npm run tileset   # fabrica el tileset sintético que usan las pruebas de extremo a extremo
npm run e2e       # el juego completo en Chromium sin interfaz, 209 comprobaciones (necesita: npm i -D playwright)
```

Las pruebas numéricas cubren el modelo del camión (radios de giro contra la teoría, corredor de giro de la norma europea, aceleración, frenado, pendientes, caja de cambios, bajadas, choques frontales y laterales), la geodesia, la red vial y los encargos. `tests/osm-real.test.mjs` usa una muestra real del centro de Temuco (`tests/fixtures/temuco-centro.json`, © OpenStreetMap contributors, ODbL).

Las pruebas de extremo a extremo abren `docs/index.html` como archivo local y anotan cada pedido que sale a la red. Los servicios de mapas se simulan en sus direcciones reales, y cada simulación responde como el servicio a lo que el juego pide: Google exige clave y sesión vigente, y Overpass devuelve los campos del nivel de detalle consultado.

| Archivo | Qué comprueba |
|---|---|
| `e2e-test-city.mjs` | Ciudad de pruebas con teclado: manejo, cámaras, entrega completa, choque frontal, roce lateral y espejos. Sin pedidos a la red |
| `e2e-touch.mjs` | Lo mismo con pantalla táctil, en tamaño de teléfono, y que los espejos no tapen los botones |
| `e2e-tiles.mjs` | Camino de teselas: clave de Google, token de Cesium ion, sesión vencida, errores del servicio, calles atrasadas |
| `e2e-vista-previa.mjs` | El archivo dentro de un marco aislado con política de seguridad estricta, entregado como dirección, `blob:` y `srcdoc`, y en una vista que no ejecuta scripts |
| `e2e-fallas.mjs` | Sin WebGL, programa que falla al arrancar, error durante la partida y pérdida del contexto gráfico: cada falla queda explicada en pantalla |

## Qué está verificado y qué falta verificar

Verificado con el servicio real, desde un navegador:

- **Overpass (calles de OpenStreetMap).** La consulta exacta del juego para el centro de Temuco respondió 200 con permiso de lectura entre orígenes, con la lista de nodos y la geometría de cada vía. Radio de 2,5 km: 2.040 vías, 1,6 MB, 15 s. El grafo, las rutas y el seguimiento pasan sus pruebas sobre una muestra real de esa respuesta.

Verificado solo contra simulaciones:

- **Google Map Tiles API y Cesium ion.** El entorno de desarrollo no tuvo credenciales ni acceso a esos servicios. El juego se probó contra un tileset sintético con la misma estructura (coordenadas ECEF, tilesets anidados con rutas absolutas, compresión Draco, sesión). Quedan por confirmar en la primera partida real: el aspecto y la escala de la malla desde la cabina, el tamaño y la memoria de las teselas reales, los códigos de error que el servicio devuelve ante una clave inválida, y cuánto cuestan en descargas y memoria las teselas que piden las cámaras de los espejos.
- **Vista previa de una aplicación.** La prueba arma una vista previa propia: marco aislado de otro origen, sin almacenamiento y con una política de seguridad que solo deja correr el contenido de la página. En esas condiciones la primera versión daba 6 errores al abrir y quedaba sin programa, el mismo síntoma informado al abrir el archivo dentro de la app de Claude. La versión actual abre con 0 errores y 0 pedidos a la red. La vista previa real de cada aplicación puede imponer otras restricciones, que esta prueba no cubre.

## Límites conocidos

- Las sondas de choque van a un metro del suelo. Un balcón o un letrero más alto no detiene al camión, y un auto estacionado sí. Los puntos de cada costado van cada 4,5 m: un poste muy delgado puede entrar entre dos sin que la arista lo note hasta que un punto lo alcanza.
- Los espejos solo se dibujan en la vista de cabina.
- Bajo un paso superior la fotogrametría suele cerrar el vano con una pared. El camión se detiene ahí. La tecla G desactiva los choques.
- El juego supone tránsito por la derecha.
- La red vial ignora las restricciones de giro de OpenStreetMap (son relaciones, y la consulta trae solo vías).
- La atribución muestra el texto "Google Maps" y las fuentes de las teselas visibles. No usa el logotipo.
- Sin calles en un radio de 2,5 km, o si Overpass no responde, el juego queda en modo libre, sin encargos. Si la respuesta llega tarde, los encargos aparecen durante la partida.
- Dentro de un marco aislado, los enlaces de la pantalla inicial pueden quedar sin efecto, porque el marco decide si deja abrir otras páginas.
- La tipografía Overpass dibuja el punto medio sin ancho. El juego lo usa como separador, así que ese carácter se dibuja con la tipografía de respaldo del sistema.

## Datos y condiciones de uso

- **Google Photorealistic 3D Tiles.** El juego transmite las teselas y no las guarda. Cada partida abre una sesión de mapa, que el servicio cobra como un pedido raíz; la pantalla inicial lleva la cuenta del mes. Las condiciones del servicio piden mostrar la atribución de Google y de las fuentes de datos, y no permiten descargar ni almacenar las teselas.
- **Cesium ion.** La cuenta gratuita es para uso personal y no comercial.
- **OpenStreetMap.** Datos © OpenStreetMap contributors, bajo licencia ODbL. La red de cada ciudad se guarda dos semanas en el navegador para no repetir la consulta.

Un juego comercial necesita revisar estas condiciones con cuidado, en especial las de Google.

### Obras incluidas en el archivo

`docs/index.html` contiene estas obras de terceros. Sus avisos van al inicio del archivo y los textos completos de las licencias, al final.

| Obra | Licencia |
|---|---|
| Three.js | MIT |
| 3d-tiles-renderer | Apache-2.0 |
| three-mesh-bvh | MIT |
| Draco (decodificador glTF distribuido con Three.js) | Apache-2.0 |
| Overpass y Overpass Mono (vía Fontsource) | SIL Open Font License 1.1 |

## Licencia

El código de Ruta Sur se publica bajo la licencia MIT (ver `LICENSE`). Las obras incluidas conservan sus propias licencias, listadas arriba.

## Cambios

**0.3.0**

- Choques laterales: los costados del tracto y del semirremolque chocan con edificios, autos y esquinas. Un roce detiene el camión sin dañarlo; un golpe de costado descuenta según la velocidad de acercamiento. En reversa siempre se sale.
- Espejos retrovisores funcionales: muestran lo que hay detrás, en el vidrio de la cabina y en dos recuadros en pantalla (tecla V). Calidad alta dibuja los dos en cada cuadro.
- Aviso y sonido propios para el roce lateral.

**0.2.0**

- Publicado en GitHub Pages: https://profesergiom.github.io/ruta-sur/

- El archivo ya no pide nada a la red al abrirse: bibliotecas, tipografías y decodificador Draco van adentro.
- Funciona dentro de un marco aislado. "Conducir" dejó de depender del envío de un formulario, que esos marcos bloquean.
- Guardia de arranque e informe de falla. Avisos para: vista que no ejecuta scripts, navegador sin WebGL 2, programa que no arranca, error durante la partida, pérdida del contexto gráfico y conexión bloqueada por la vista.
- El punto medio de los textos se dibuja con su ancho correcto.

**0.1**

- Primera versión del prototipo.

## Próximos pasos posibles

1. Primera partida real y ajuste de lo que muestre: altura de la cámara, tolerancias del suelo, calidad por defecto, costo de las teselas de los espejos.
2. Tránsito y semáforos sobre la red vial.
3. Carreteras: encargos entre ciudades, con carga de calles por tramos.
