# Threads Downloader

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | **Español** | [한국어](README.ko.md)

[Abrir el servicio activo de Threads Downloader](https://threads.pylot.dev/)

Threads Downloader es una herramienta independiente para descargar videos de publicaciones públicas
de Threads que cualquier visitante puede ver sin iniciar sesión. No es un servicio oficial de
Threads ni cuenta con el respaldo de Threads, Meta o Instagram.

## Cómo usarlo

1. Abre el [servicio activo](https://threads.pylot.dev/).
2. Pega la URL de una publicación pública de Threads.
3. Confirma que eres titular del contenido, tienes permiso o puedes realizar el uso previsto conforme
   a la legislación aplicable.
4. Selecciona **Obtener video**. La verificación de seguridad suele ejecutarse automáticamente, pero
   sigue las indicaciones en pantalla si se requiere alguna acción adicional.
5. Elige la versión de video que necesitas y descárgala.

## Contenido compatible

- Solo se admiten publicaciones públicas de Threads que un visitante común pueda ver sin iniciar
  sesión.
- No se procesa contenido privado, que requiera iniciar sesión, con restricciones de edad o región,
  ni ningún otro contenido restringido; tampoco se eluden las restricciones de acceso.
- Los formatos de las páginas y las restricciones de la plataforma Threads pueden cambiar, por lo que
  no se garantiza que todas las publicaciones públicas se resuelvan correctamente.
- Descarga únicamente contenido que tengas derecho a usar. Que sea visible públicamente no concede
  permiso para usarlo sin restricciones.

Los Términos de uso, el Aviso de privacidad y tratamiento de datos y el Aviso de derechos de autor y
retirada de contenido completos están disponibles en el encabezado o el pie del sitio y se abren en
un cuadro de diálogo. Para consultas sobre derechos de autor, retirada de contenido o privacidad,
escribe a [pony@pylot.dev](mailto:pony@pylot.dev).

## Solución de problemas

- **Completa primero la verificación de seguridad.** Espera unos segundos y vuelve a intentarlo, y
  comprueba que el navegador no bloquee los scripts que necesita el sitio.
- **No se puede resolver la publicación.** Confirma que la URL corresponda a una publicación pública
  que no requiera iniciar sesión. Si el problema continúa más tarde, puede que la publicación no sea
  compatible.
- **No se puede descargar el video.** Vuelve a resolver la publicación y elige una versión; los
  enlaces de descarga caducan después de un tiempo limitado.
- **El problema continúa.** Informa de él en el
  [repositorio del proyecto](https://github.com/Willseed/ThreadsDownloader) e incluye el mensaje de
  error que aparece en pantalla. No publiques contenido privado ni información de cuentas en una
  incidencia pública.

## Enlaces oficiales

- [Servicio activo de Threads Downloader](https://threads.pylot.dev/)
- [Sitio web de Threads](https://www.threads.com/)
- [Repositorio del proyecto Threads Downloader](https://github.com/Willseed/ThreadsDownloader)

## Recursos para mantenimiento

La siguiente documentación para mantenimiento está escrita actualmente en chino tradicional:

- [Principios de diseño y experiencia de usuario](DESIGN.md)
- [Manual de operaciones y despliegue](docs/operations.md)
- [Notas de investigación](docs/research/)
