# Ruta Sur

Simulador de camiones que corre en el navegador sobre un mapa abierto levantado desde OpenStreetMap: las calles verdaderas de una ciudad, con sus edificios como cajas de colores. El jugador conduce un tracto con semirremolque, o un camión rígido, y reparte cargas entre esquinas.

Este es un prototipo. Hasta la versión 0.4 manejaba también sobre la malla 3D fotorrealista de Google, que exige una credencial de pago o una cuenta de Cesium ion; la 0.5 deja solo los datos abiertos.

**Jugar en línea:** https://profesergiom.github.io/ruta-sur/

## Cómo jugar

1. Abre https://profesergiom.github.io/ruta-sur/ en Chrome o Edge. También puedes guardar `docs/index.html` en el computador y abrirlo con doble clic: es el mismo archivo y funciona igual. Las pruebas corren en Chromium, el motor de ambos navegadores. Firefox no se probó.
2. Elige la ciudad (Temuco, Santiago, Concepción, o cualquier punto por latitud y longitud), el camión y la calidad, y presiona "Conducir". El juego pide a OpenStreetMap las calles y los edificios de esa zona y levanta la ciudad. Necesita internet la primera vez; la respuesta queda guardada dos semanas en el navegador.
3. "Ciudad de pruebas, sin conexión" abre una ciudad generada en el momento. Sirve para conocer los controles y, abierta como archivo, funciona sin internet.

El archivo trae adentro todo lo que el juego necesita: el programa, las bibliotecas y las tipografías. Al abrirse no pide nada a la red. La red se usa recién al pulsar "Conducir", para pedir las calles y los edificios a Overpass.

### Si se abre dentro de otra aplicación

La vista previa de una aplicación muestra el archivo en un marco aislado, que no deja salir pedidos a otros servidores. Ahí el juego abre y la ciudad de pruebas se puede manejar. El mapa abierto necesita conectarse con OpenStreetMap: cuando la vista bloquea esa conexión, el juego lo dice en pantalla y pide abrir el archivo en el navegador. La pantalla inicial lo anticipa con una nota.

En un marco aislado tampoco hay almacenamiento: la caja de los encargos y las calles guardadas duran lo que dura la visita.

### Controles

| Tecla | Acción |
|---|---|
| W A S D o flechas | Acelerar, girar y frenar. Detenido, mantener "atrás" engancha la reversa |
| Espacio | Freno de mano |
| C | Cámara: cabina, exterior, cenital |
| Q, E o arrastrar | Mirar a los lados |
| V | Espejos en pantalla: mostrar u ocultar los recuadros |
| X | Radio: la emisora siguiente (en la pausa se elige una o se pega otra dirección) |
| T | Adelantar la hora del juego |
| Enter, N | Aceptar el encargo, pedir otro |
| R | Volver a la calle más cercana |
| G | Activar o desactivar los choques |
| M, F3 | Sonido, datos técnicos |
| Esc o P | Pausa |

Con pantalla táctil aparecen botones en pantalla, y la guía de despacho se toca para aceptar el encargo. También funciona un mando con disposición estándar.

## Cómo está hecho

El juego es un solo archivo HTML sin dependencias externas. `tools/build.mjs` une con esbuild los módulos de `src/` y las bibliotecas (Three.js y three-mesh-bvh), agrega las tipografías y lo inserta todo en `src/index.template.html`. El resultado, `docs/index.html`, pesa cerca de 0,8 MB. GitHub Pages publica la carpeta `docs/` tal cual, así que ese archivo es a la vez el juego en línea y el que se puede descargar. La raíz del repositorio lleva un `index.html` que redirige a `docs/` y un `.nojekyll`, por si Pages quedara configurado para publicar la raíz: sin ellos, GitHub mostraría el README en lugar del juego.

La primera versión pedía las bibliotecas y las tipografías a servidores externos al abrirse. Bastaba que esos pedidos estuvieran bloqueados, como ocurre en la vista previa de una aplicación, para que la página quedara sin programa. Por eso ahora todo viaja en el archivo.

| Módulo | Qué hace |
|---|---|
| `physics.js` | Modelo del camión: bicicleta cinemática, semirremolque articulado, motor diésel con caja automatizada, frenos, retardador, choques y seguimiento del suelo sobre una malla ruidosa. No depende de Three.js |
| `world.js` | Lo que comparten los mundos: los rayos contra las mallas con un BVH por malla, las consultas a Overpass (calles y edificios) con su memoria local, y la detección de una vista que bloquea la red. También `TestWorld`, la ciudad de pruebas |
| `osm.js` | Red vial de OpenStreetMap: grafo, ruta sin vueltas en U, indicaciones, seguimiento del avance, destinos y punto de aparición |
| `jobs.js` | Encargos: carga, destino, pago, bono de puntualidad, descuento por daño |
| `geo.js` | Conversión entre latitud y longitud y las coordenadas del juego (WGS84) |
| `truck-model.js`, `hud.js`, `audio.js`, `input.js` | Modelo 3D del camión, tablero y minimapa, sonido sintetizado, teclado, táctil y mando |
| `radio.js` | Radios chilenas por internet: lista de emisoras, reproducción con el elemento de audio y una dirección propia |
| `daylight.js` | Ciclo de día y noche: nivel de luz, colores del cielo y la bruma, tinte de la ciudad, sol y luces encendidas según la hora. No depende de Three.js |
| `mirrors.js` | Espejos retrovisores: una cámara por espejo dibuja en una textura que va en el vidrio de la cabina y en los recuadros de la pantalla |
| `openmap.js` | Mapa abierto: convierte las calles y los edificios de OpenStreetMap en franjas de asfalto con vereda y prismas de colores, por trozos. Triangula las plantas por recorte de orejas. No depende de Three.js |
| `openworld.js` | El mundo del mapa abierto: pide calles y edificios a Overpass, levanta los trozos alrededor del camión y responde los rayos de la física |
| `main.js` | Pantalla inicial, carga, bucle principal y cámaras |
| `testcity.js` | Ciudad de pruebas generada; su constructor de mallas también lo usa el mapa abierto |

La plantilla lleva además una **guardia de arranque**: un script corto, escrito con sintaxis antigua, que corre antes que el programa. Instala las tipografías, anota los errores sin atender y los muestra como un informe que se puede copiar. Si el programa no arranca (navegador antiguo, sin WebGL 2, vista que no ejecuta scripts), la página lo dice y propone la salida. El informe cita el archivo por su nombre, sin la ruta del computador.

Convención de ejes: +X al oeste, +Y arriba, +Z al norte, con origen en el punto elegido. La conversión desde latitud y longitud pasa por coordenadas ECEF, así que es exacta a cualquier distancia del origen.

### Mapa abierto

El mundo principal del juego no usa fotografía. Las calles salen de la misma consulta a Overpass que la red vial, y se dibujan como franjas de asfalto con una vereda a cada lado y el ancho típico de su clase (una residencial, 7 m; una primaria, 10 m). Los edificios salen de una segunda consulta, de las vías cerradas con etiqueta `building` en 1,5 km alrededor del punto elegido, y se extruyen desde su planta: con la altura que OSM declare (`height`), o con los pisos (`building:levels`, a 3,2 m cada uno), o con una altura típica de su tipo (una casa, 5,5 m; un edificio de departamentos, 15 m), dispersa un poco para que una cuadra no salga pareja. Las plantas cóncavas se triangulan por recorte de orejas. El suelo es plano. Todo se arma por trozos de 120 m alrededor del camión, con un BVH por trozo para la física, y los trozos lejanos se liberan. Los edificios se guardan en el navegador dos semanas, como las calles.

### Día y noche

La partida empieza a las 17:00 y el reloj del tablero avanza una hora del juego por cada minuto de reloj (la tecla T adelanta una hora). El sol sale a las 6:30 y se pone a las 19:30. Con la hora cambian el cielo y la bruma (naranja en el crepúsculo, azul oscuro de noche), la fuerza del sol sobre el camión y un tinte que oscurece la ciudad. Al crepúsculo se encienden las luces, poco a poco y sin saltos: los faroles brillan y dejan charcos de luz sobre la calzada, las ventanas se encienden en un patrón de cuatro por cuatro celdas con algunas apagadas (una capa de luz que se suma a la fachada, con la misma geometría), y el camión prende los focos, que dibujan un haz sobre la calzada por delante. Todo sale de `daylight.js`, una función pura de la hora, que las pruebas numéricas recorren hora a hora. El ciclo corre igual en la ciudad de pruebas, sin faroles.

### Radio

Mientras se maneja se puede escuchar una radio chilena con transmisión gratuita por internet: ADN, Cooperativa y Futuro vienen en la lista, y en la pausa se puede pegar la dirección de cualquier otra transmisión (una `https://` que el navegador sepa reproducir, como un `icecast` o un `.aac`). La tecla X pasa a la emisora siguiente y la tecla M silencia todo. El juego solo reproduce la transmisión pública con el elemento de audio del navegador; no la guarda ni la retransmite. Las direcciones son las que publican las emisoras y aparecen en catálogos públicos de radios chilenas (`src/radio.js`); pueden cambiar sin aviso, y el juego avisa en pantalla cuando una no responde. Radio Punto 7 no está en la lista porque no se encontró una dirección pública de su transmisión; si la conoces, va por el campo de la pausa.

### Ambientación

Todo lo que viste el mapa abierto sale de datos abiertos o se genera en el momento; nada se descarga aparte.

- **Texturas.** La calzada, la vereda, el pasto y las fachadas llevan texturas de grano dibujadas en un lienzo al abrir el juego: asfalto con piedras claras, veredas de baldosas, pasto moteado y fachadas con una ventana por celda de 4 m por piso. Son texturas de luminancia que el color de cada vértice tiñe. Las de las calles se repiten cada 6 m a lo largo, con coordenadas acumuladas tramo a tramo para que no se corten en las esquinas; las de las paredes cuentan celdas enteras por pared, así ninguna ventana queda partida. La línea central va discontinua, con una textura de transparencia.
- **Plazas, parques y agua.** La misma consulta que trae los edificios pide las áreas verdes (`leisure`, `landuse`, `natural`) y el agua (`natural=water`, riberas). Se dibujan como manchas sobre el suelo. Los bosques y parques reciben árboles repartidos por adentro, más densos en los bosques.
- **Árboles y faroles.** Los árboles que OpenStreetMap tiene mapeados uno por uno (`natural=tree`) aparecen donde están. Además, las calles de 7 m o más reciben árboles de vereda cada 16 m, con huecos al azar, y las vías de 8 m o más (terciarias y mayores) faroles cada 34 m alternando de lado. Ninguno se planta sobre un edificio, sobre el agua ni en un cruce. Los árboles y faroles son decorativos: el camión los atraviesa, para que una vereda angosta no deje atascado el reparto.
- **Cerros.** Una línea de lomas brumosas rodea la ciudad en el horizonte, a la distancia que la calidad elegida alcanza a dibujar. Es decorativa: no sale de ningún modelo de elevación, y por eso no coincide con los cerros reales.

### Choques

El camión choca con lo que la malla tenga a un metro del suelo. Dos familias de sondas lo cuidan. Las del parachoques y de la cola miran en el sentido de marcha y recortan el avance a la distancia libre. Las de los costados vigilan los flancos de cada unidad, porque en una curva el semirremolque corta la esquina y su costado alcanza lo que el tracto esquivó. Cada punto del flanco lanza un rayo desde donde está hacia donde iría en el paso, y un rayo más recorre cada flanco de punta a punta para atrapar una esquina ajena que entre entre dos puntos. Un movimiento que se aleja del obstáculo nunca se bloquea, así que de un roce siempre se sale en reversa. La velocidad de acercamiento se mide según la normal de la superficie tocada: un roce tangencial detiene el camión sin dañarlo, y un costalazo descuenta como un choque frontal.

### Espejos

Cada espejo es una cámara que mira hacia atrás desde el vidrio, 7° hacia afuera, y dibuja en una textura. La textura va en el vidrio del espejo de la cabina (el derecho aparece al mirar a la derecha con E) y, para no tener que girar la cabeza, en dos recuadros en lo alto de la pantalla que la tecla V oculta. La imagen se invierte de izquierda a derecha, como en un espejo real. En calidad baja y media se refresca un espejo por cuadro; en alta, los dos.

La red vial sale de la misma consulta a OpenStreetMap. Con ella el juego elige dónde aparece el camión, genera destinos alcanzables, calcula la ruta y dibuja el minimapa.

## Pruebas

```
npm install
npm test          # pruebas numéricas, sin navegador (299 comprobaciones)
npm run e2e       # el juego completo en Chromium sin interfaz, 171 comprobaciones (necesita: npm i -D playwright)
```

Las pruebas numéricas cubren el modelo del camión (radios de giro contra la teoría, corredor de giro de la norma europea, aceleración, frenado, pendientes, caja de cambios, bajadas, choques frontales y laterales), la geodesia, la red vial, el mapa abierto (triangulación, prismas, trozos, memoria de edificios) y los encargos. `tests/osm-real.test.mjs` usa una muestra real del centro de Temuco (`tests/fixtures/temuco-centro.json`, © OpenStreetMap contributors, ODbL). El entorno de desarrollo no llega a Overpass, así que no hay una muestra real de edificios: `tests/open-fixture.mjs` reparte plantas sintéticas en las manzanas de esa muestra, con las etiquetas que usa el juego.

Las pruebas de extremo a extremo abren `docs/index.html` como archivo local y anotan cada pedido que sale a la red. Overpass se simula en su dirección real y responde como el servicio a lo que el juego pide: los campos del nivel de detalle consultado, calles o edificios según la consulta.

| Archivo | Qué comprueba |
|---|---|
| `e2e-test-city.mjs` | Ciudad de pruebas con teclado: manejo, cámaras, entrega completa, choque frontal, roce lateral y espejos. Sin pedidos a la red |
| `e2e-touch.mjs` | Lo mismo con pantalla táctil, en tamaño de teléfono, y que los espejos no tapen los botones |
| `e2e-open.mjs` | Mapa abierto: calles reales del centro de Temuco y edificios sintéticos en sus manzanas, servidos por un Overpass simulado. Partida con el piloto, choque contra un edificio y la carga detenida cuando Overpass falla |
| `e2e-vista-previa.mjs` | El archivo dentro de un marco aislado con política de seguridad estricta, entregado como dirección, `blob:` y `srcdoc`, y en una vista que no ejecuta scripts |
| `e2e-fallas.mjs` | Sin WebGL, programa que falla al arrancar, error durante la partida y pérdida del contexto gráfico: cada falla queda explicada en pantalla |

## Qué está verificado y qué falta verificar

Verificado con el servicio real, desde un navegador:

- **Overpass (calles de OpenStreetMap).** La consulta exacta del juego para el centro de Temuco respondió 200 con permiso de lectura entre orígenes, con la lista de nodos y la geometría de cada vía. Radio de 2,5 km: 2.040 vías, 1,6 MB, 15 s. El grafo, las rutas y el seguimiento pasan sus pruebas sobre una muestra real de esa respuesta.

Verificado solo contra simulaciones:

- **Overpass (edificios).** La consulta de edificios sigue la misma forma que la de calles (`way["building"](around:...)`, `out tags geom`), pero no se pudo enviar al servicio real desde el entorno de desarrollo. Quedan por confirmar en la primera partida: el tamaño de la respuesta en una ciudad densa (1,5 km de Santiago pueden ser decenas de miles de edificios), su tiempo, y si cabe en la memoria local del navegador. Si no cabe, el juego la usa sin guardarla.

- **Vista previa de una aplicación.** La prueba arma una vista previa propia: marco aislado de otro origen, sin almacenamiento y con una política de seguridad que solo deja correr el contenido de la página. En esas condiciones la primera versión daba 6 errores al abrir y quedaba sin programa, el mismo síntoma informado al abrir el archivo dentro de la app de Claude. La versión actual abre con 0 errores y 0 pedidos a la red. La vista previa real de cada aplicación puede imponer otras restricciones, que esta prueba no cubre.

## Límites conocidos

- Las sondas de choque van a un metro del suelo. Un balcón o un letrero más alto no detiene al camión, y un auto estacionado sí. Los puntos de cada costado van cada 4,5 m: un poste muy delgado puede entrar entre dos sin que la arista lo note hasta que un punto lo alcanza.
- Los espejos solo se dibujan en la vista de cabina.
- En el mapa abierto el suelo es plano: no hay relieve ni soleras, y los cerros del horizonte son decorativos. Los edificios y las áreas dibujados en OpenStreetMap como relaciones (con patio interior o en varias partes) no aparecen, y los edificios que no declaran altura ni pisos reciben una altura típica de su tipo. Las calles se dibujan con un ancho fijo por clase, sin carriles ni cruces resueltos. Los árboles y faroles no chocan.
- El juego supone tránsito por la derecha.
- La red vial ignora las restricciones de giro de OpenStreetMap (son relaciones, y la consulta trae solo vías).
- Sin calles en un radio de 2,5 km, o si Overpass no responde, el juego queda en modo libre, sin encargos. Si la respuesta llega tarde, los encargos aparecen durante la partida.
- Dentro de un marco aislado, los enlaces de la pantalla inicial pueden quedar sin efecto, porque el marco decide si deja abrir otras páginas.
- La tipografía Overpass dibuja el punto medio sin ancho. El juego lo usa como separador, así que ese carácter se dibuja con la tipografía de respaldo del sistema.

## Datos y condiciones de uso

- **OpenStreetMap.** Datos © OpenStreetMap contributors, bajo licencia ODbL. Las calles y los edificios de cada ciudad se guardan dos semanas en el navegador para no repetir la consulta. El juego muestra la atribución en pantalla. Las instancias públicas de Overpass piden un uso moderado: cada partida nueva en una zona es una consulta de calles y otra de edificios, y las repeticiones salen de la memoria local.

### Obras incluidas en el archivo

`docs/index.html` contiene estas obras de terceros. Sus avisos van al inicio del archivo y los textos completos de las licencias, al final.

| Obra | Licencia |
|---|---|
| Three.js | MIT |
| three-mesh-bvh | MIT |
| Overpass y Overpass Mono (vía Fontsource) | SIL Open Font License 1.1 |

## Licencia

El código de Ruta Sur se publica bajo la licencia MIT (ver `LICENSE`). Las obras incluidas conservan sus propias licencias, listadas arriba.

## Cambios

**0.8.0**

- Ciclo de día y noche: reloj en el tablero, tecla T para adelantar la hora, cielo y bruma según la hora, y de noche faroles encendidos con charcos de luz, ventanas iluminadas y focos del camión.
- La versión se muestra en la pantalla inicial, y el armado publica `docs/version.json` para que la portada del sitio la lea.

**0.7.0**

- Ambientación del mapa abierto: fachadas con ventanas, pasto con textura, plazas, parques y agua desde OpenStreetMap, árboles mapeados y de vereda, faroles en las vías principales, línea central discontinua y cerros brumosos en el horizonte.
- La memoria local de edificios cambia de formato (guarda también manchas y árboles); la anterior se borra sola.

**0.6.0**

- Radio: ADN, Cooperativa y Futuro mientras se maneja, con la tecla X o desde la pausa, y un campo para pegar otra transmisión.
- Textura de grano en la calzada y de baldosas en las veredas del mapa abierto.

**0.5.0**

- Se retira el modo sobre la malla 3D de Google (directa o por Cesium ion), con su credencial, su contador de sesiones, el cargador de teselas y el decodificador Draco. El mapa abierto de OpenStreetMap pasa a ser el modo principal, con el botón "Conducir". El archivo baja de 1,4 MB a 0,8 MB.
- La geodesia se comprueba contra una conversión de referencia propia, ya sin la biblioteca de teselas.

**0.4.0**

- Mapa abierto: un tercer mundo sin credencial, con las calles y los edificios de OpenStreetMap sobre un suelo plano. Encargos, rutas, choques y espejos funcionan igual que sobre la malla de Google.
- Los edificios se guardan en el navegador dos semanas, aparte de las calles.
- Portada de respaldo en la raíz del repositorio, por si GitHub Pages publica la raíz en vez de `docs/`.

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

1. Primera partida real y ajuste de lo que muestre: tamaño y tiempo de la consulta de edificios en una ciudad grande, altura de la cámara, calidad por defecto.
2. Relieve en el mapa abierto con un modelo de elevación abierto (Copernicus DEM), y árboles y plazas desde las etiquetas de OpenStreetMap.
3. Tránsito y semáforos sobre la red vial.
4. Carreteras: encargos entre ciudades, con carga de calles por tramos.
