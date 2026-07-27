import { type ApiErrorCode } from '@threads-downloader/contracts';

import { type MessageCatalog } from './zh-TW.js';

export const es = {
  locale: {
    code: 'es',
    direction: 'ltr',
    name: 'Español',
  },
  metadata: {
    description:
      'Resuelve versiones de video de publicaciones públicas de Threads mediante un flujo seguro del navegador y del mismo origen. Diseñado para la investigación técnica y académica.',
  },
  routes: {
    home: 'Threads Downloader — Herramienta de investigación de contenido multimedia público',
    terms: 'Términos de uso | Threads Downloader',
    privacy: 'Privacidad y tratamiento de datos | Threads Downloader',
    copyright: 'Aviso de derechos de autor y retirada de contenido | Threads Downloader',
  },
  app: {
    brand: 'Threads Downloader',
    languageLabel: 'Seleccionar idioma',
    skipLink: 'Ir al contenido principal',
    headerLabel: 'Encabezado del sitio',
    homeLabel: 'Página de inicio de Threads Downloader',
    primaryNavigationLabel: 'Navegación principal',
    startDownload: 'Iniciar descarga',
    disclaimer:
      'Este no es un servicio oficial de Threads. Los usuarios deben confirmar sus derechos sobre el contenido y cumplir la legislación aplicable y los términos de la plataforma.',
    legalNavigationLabel: 'Información legal',
    terms: 'Términos de uso',
    privacy: 'Privacidad y tratamiento de datos',
    copyright: 'Derechos de autor y retirada de contenido',
  },
  downloader: {
    pageTitle: 'Descargar videos públicos de Threads',
    heroCopy:
      'Pega la URL de una publicación, completa la verificación y elige una versión de video.',
    workflowLabel: 'Obtener video',
    postUrlLabel: 'URL de la publicación de Threads',
    postUrlPlaceholder: 'https://www.threads.com/@username/post/shortcode',
    postUrlHelp: 'Compatible con threads.com y threads.net',
    postUrlError: 'Introduce una URL válida de una publicación pública de Threads.',
    rightsConfirmation: 'Confirmo que tengo derecho a descargar y usar este contenido',
    rightsDetail:
      'Confirmo que soy titular del contenido, tengo permiso o puedo guardarlo conforme a la legislación aplicable. Entiendo que un fin académico o no comercial no concede permiso por sí mismo y que soy responsable de cumplir la legislación y los términos de la plataforma.',
    rightsDetailLink: 'Revisar las responsabilidades sobre el uso del contenido',
    rightsError: 'Confirma tu derecho a usar el contenido antes de continuar.',
    turnstileLabel: 'Verificación de seguridad',
    verificationUnavailable:
      'La verificación de seguridad no está disponible. Vuelve a cargarla e inténtalo de nuevo.',
    reloadVerification: 'Volver a cargar la verificación de seguridad',
    verificationRequired: 'Completa primero la verificación de seguridad.',
    resolvingAction: 'Obteniendo el video…',
    resolveAction: 'Obtener video',
    bootstrapStatus: 'Estableciendo una sesión segura…',
    resolveStatus: 'Resolviendo la publicación pública…',
    requestReference: (requestId: string) => `Referencia: ${requestId}`,
    retryBootstrap: 'Iniciar una nueva sesión segura',
    candidateCount: (count: number) =>
      count === 1 ? 'Se encontró 1 versión de video' : `Se encontraron ${count} versiones de video`,
    quality: 'Calidad',
    duration: 'Duración',
    size: 'Tamaño',
    candidateFallback: 'Los detalles del video dependen de la fuente',
    preparingCandidate: 'Preparando el video…',
    preparingCandidateLabel: 'Preparando el video',
    openOrDownload: 'Abrir o descargar el video',
    candidateActionLabel: (action: string, index: number, filename: string) =>
      `${action}, versión ${index}: ${filename}`,
    handoffMessage:
      'El video se ha transferido al navegador. Si se abre en un reproductor, usa la opción de guardar del navegador.',
    resolveRequirements:
      'Comprueba la confirmación de derechos, la URL y el estado de la verificación, y vuelve a intentarlo.',
    candidateInvalid: 'La versión de video no es válida. Vuelve a resolver la publicación.',
    invalidDownloadId: 'El identificador de descarga no es válido.',
    genericError: 'El servicio no está disponible temporalmente. Inténtalo de nuevo más tarde.',
  },
  apiErrors: {
    HOST_NOT_ALLOWED: 'No se permite usar el servicio desde este sitio web.',
    SESSION_INVALID: 'La sesión no es válida. Inicia una nueva sesión segura.',
    SESSION_EXPIRED: 'La sesión ha expirado. Inicia una nueva sesión segura.',
    SESSION_UNAVAILABLE:
      'La sesión no está disponible temporalmente. Inténtalo de nuevo más tarde.',
    REQUEST_INVALID: 'El formato de la solicitud no es válido.',
    REQUEST_TOO_LARGE: 'La solicitud supera el límite de tamaño.',
    URL_INVALID: 'Introduce una URL válida de una publicación de Threads.',
    RATE_LIMITED: 'Se han realizado demasiadas solicitudes. Inténtalo de nuevo más tarde.',
    TURNSTILE_INVALID: 'La verificación ha fallado. Complétala de nuevo y vuelve a intentarlo.',
    TURNSTILE_UNAVAILABLE: 'El servicio de verificación no está disponible temporalmente.',
    THREADS_LOGIN_REQUIRED: 'Esta publicación requiere iniciar sesión en Threads.',
    THREADS_ACCESS_DENIED: 'Threads ha denegado el acceso a esta publicación.',
    THREADS_RATE_LIMITED:
      'Threads está limitando el acceso temporalmente. Inténtalo de nuevo más tarde.',
    THREADS_BOT_BLOCKED: 'Threads está bloqueando temporalmente el acceso automatizado.',
    THREADS_JAVASCRIPT_REQUIRED: 'Actualmente, esta publicación requiere JavaScript para cargarse.',
    MEDIA_NOT_FOUND: 'No se encontró ninguna versión de video compatible.',
    RESOLVE_UNAVAILABLE:
      'No se puede resolver esta publicación en este momento. Inténtalo de nuevo más tarde.',
    DOWNLOAD_EXPIRED: 'La sesión de descarga ha expirado. Inicia una nueva descarga.',
    DOWNLOAD_CONCURRENT_LIMIT:
      'Se ha alcanzado el límite de descargas simultáneas. Inténtalo de nuevo más tarde.',
    DOWNLOAD_RANGE_UNAVAILABLE: 'El intervalo de descarga solicitado no está disponible.',
    DOWNLOAD_UPSTREAM_UNAVAILABLE:
      'La fuente de descarga no está disponible temporalmente. Inténtalo de nuevo más tarde.',
    DOWNLOAD_UNAVAILABLE:
      'La descarga no está disponible temporalmente. Inténtalo de nuevo más tarde.',
    NOT_FOUND: 'No se encontró la ruta de API solicitada.',
    INTERNAL_ERROR: 'El servidor no puede procesar la solicitud en este momento.',
  } satisfies Readonly<Record<ApiErrorCode, string>>,
  legalModal: {
    eyebrow: 'LEGAL / A SOLICITUD',
    close: 'Cerrar',
    loading: 'Cargando la información legal.',
    error: 'La información legal no está disponible temporalmente. Inténtalo de nuevo más tarde.',
    retry: 'Volver a cargar',
  },
  researchPurpose: {
    title: 'Finalidad de investigación y límites legales',
    purpose:
      'Este servicio se ofrece exclusivamente para investigación técnica y académica. El operador no busca obtener beneficios comerciales ni económicos al proporcionarlo.',
    boundary:
      'Esa finalidad y la declaración de carácter no comercial no significan que el operador o el usuario hayan obtenido autorización sobre ningún contenido. Tampoco establecen que una descarga, almacenamiento u otro uso concreto sean legales o estén amparados por una limitación o excepción a los derechos de autor, ni eximen a nadie de sus responsabilidades conforme a la legislación aplicable.',
    authorization:
      'Que el contenido sea visible públicamente o se use con fines de investigación o no comerciales no concede autorización. Los usuarios deben ser titulares del contenido, contar con una autorización válida o estar legalmente facultados, conforme a la legislación que realmente corresponda, para realizar el uso previsto.',
    access:
      'Este servicio solo procesa publicaciones de Threads a las que el público general puede acceder sin iniciar sesión. No procesa contenido privado, que requiera iniciar sesión o que esté restringido, ni elude el inicio de sesión, medidas técnicas u otras restricciones de acceso.',
  },
  terms: {
    eyebrow: 'LEGAL / TÉRMINOS',
    title: 'Términos de uso',
    introduction:
      'Antes de usar este servicio, revisa su alcance técnico, los requisitos sobre derechos y los límites legales.',
    scopeTitle: 'Alcance del servicio',
    scopePublic:
      'Este servicio solo acepta URL de publicaciones públicas de Threads en dominios compatibles a las que se pueda acceder sin iniciar sesión.',
    scopeCredentials:
      'Este servicio no acepta cookies, credenciales de cuenta ni tokens de inicio de sesión de Threads o Instagram. No debe usarse para procesar contenido privado o restringido, ni contenido que requiera eludir medidas técnicas.',
    scopeDelivery:
      'Este servicio resuelve versiones de video de publicaciones públicas y entrega las descargas desde el mismo origen. La disponibilidad de la fuente, la integridad del contenido y el guardado final del archivo por parte del navegador aún pueden depender de la fuente y del entorno del usuario.',
    rightsTitle: 'Responsabilidades y derechos del usuario',
    rightsBasis:
      'Antes de enviar una solicitud, los usuarios deben confirmar que son titulares del contenido, cuentan con una autorización válida o pueden realizar el uso previsto conforme a la legislación aplicable.',
    rightsOwnership:
      'El contenido y los derechos de autor, marcas comerciales y demás derechos relacionados pertenecen a sus respectivos titulares. Este servicio no concede derechos sobre contenido de terceros.',
    rightsUse:
      'Los usuarios son responsables de establecer sus derechos y fundamento jurídico para almacenar, editar, copiar, volver a publicar, compartir o usar de cualquier otro modo el contenido descargado, de acuerdo con el uso real que hagan de él.',
    rightsAbuse:
      'No uses este servicio para infringir derechos de terceros, interferir con la seguridad del servicio ni eludir los controles de acceso de la plataforma de origen.',
    affiliationTitle: 'Terceros y ausencia de afiliación',
    affiliation:
      'Este servicio no es un producto oficial de Meta, Instagram, Threads ni SpaceX, y no cuenta con su respaldo, autorización, encargo ni colaboración. Los derechos sobre contenidos y marcas de terceros pertenecen a sus respectivos titulares.',
    reviewTitle: 'Operador y revisión periódica',
    review:
      'El nombre público del operador es Pony. Esta página no constituye asesoramiento jurídico ni determina si una descarga concreta es legal. El operador debe revisar periódicamente estos términos según la ubicación real, los flujos de datos, las condiciones del servicio y la legislación aplicable, y actualizarlos cuando cambien las condiciones operativas o la legislación.',
  },
  privacy: {
    eyebrow: 'LEGAL / PRIVACIDAD',
    title: 'Aviso de privacidad y tratamiento de datos',
    introduction:
      'Esta página describe los datos tratados por el servicio actual, las finalidades del tratamiento, los destinatarios y los plazos de conservación lógica definidos en el nivel de la aplicación.',
    dataTitle: 'Datos tratados',
    dataPost:
      'La URL de la publicación pública de Threads y la confirmación de derechos enviadas por el usuario, además del código abreviado de la publicación resuelta, el nombre de archivo de la versión, sus dimensiones y duración, y los metadatos de seguridad asociados.',
    dataCookie:
      'Este servicio establece una cookie anónima __Host-td_session con los atributos HttpOnly, Secure, SameSite=Lax y una ruta limitada a la raíz del sitio. El servidor también trata los valores hash y las fechas de caducidad de la sesión y del token CSRF.',
    dataIp:
      'La dirección IP de la conexión se usa para la verificación de seguridad mientras se procesa una solicitud. Un hash con clave derivado de ella se usa para limitar solicitudes durante un periodo breve. Este aviso no afirma que el servicio nunca trate direcciones IP.',
    dataTurnstile:
      'El token de verificación de Cloudflare Turnstile, su hash antirrepetición de corta duración, la hora de verificación y los identificadores de seguridad de la solicitud.',
    dataDownload:
      'Los identificadores opacos necesarios para los trabajos de descarga, las URL de los medios de origen almacenadas de forma sellada, los metadatos de seguridad del archivo, los intervalos de bytes, el estado del trabajo, las concesiones temporales de ejecución y las marcas de tiempo.',
    purposeTitle: 'Finalidades del tratamiento',
    purpose:
      'Estos datos se usan para establecer sesiones anónimas, verificar solicitudes del mismo origen, resolver publicaciones públicas, entregar descargas al navegador, admitir transferencias reanudables y evitar repeticiones, abusos y exceso de concurrencia. El servicio no solicita cookies de inicio de sesión, contraseñas de cuenta ni tokens de acceso de Threads o Instagram, ni transfiere esas credenciales de inicio de sesión a los servicios de origen.',
    recipientTitle: 'Destinatarios de los datos y servicios externos',
    recipientCloudflare:
      'Cloudflare Workers y Durable Objects procesan las solicitudes del sitio, el estado de corta duración y las transferencias en streaming. Cloudflare Turnstile recibe el token de verificación, la dirección IP de conexión y los datos del navegador y de la solicitud necesarios para la verificación.',
    recipientThreads:
      'Threads recibe las solicitudes HTTPS que envía el servidor para leer la publicación pública proporcionada por el usuario.',
    recipientInstagram:
      'La red de distribución de contenido (CDN) de Instagram recibe las solicitudes HTTPS que envía el servidor para verificar los medios y entregar contenido por intervalos de bytes.',
    recipientBoundary:
      'Por tanto, este servicio no afirma que los datos no sean tratados por terceros. La conservación de los registros de seguridad perimetral de Cloudflare, las copias de seguridad de la infraestructura y otros registros de infraestructura no está determinada por el código de esta aplicación y debe revisarse periódicamente conforme a las políticas y la configuración del servicio vigentes.',
    retentionTitle: 'Conservación lógica en la aplicación',
    sessionLabel: 'Sesión anónima',
    sessionRetention:
      'La cookie, el hash de la sesión y el hash CSRF se conservan durante un máximo de 12 horas. Después de que expiren, la alarma programada del almacén de sesiones los elimina.',
    ipLabel: 'Limitación de solicitudes por IP',
    ipRetention:
      'Los eventos de resolución usan una ventana de limitación de 60 segundos, y los permisos de resolución activos duran como máximo 30 segundos. Al establecer una sesión anónima, el hash de IP con clave del servidor, los eventos de emisión de cuota y los datos opacos de reserva necesarios se conservan durante un máximo de 12 horas. Las reservas de corta duración duran 30 segundos, y el estado de limitación se elimina cuando no quedan datos pendientes.',
    turnstileLabel: 'Prevención de repetición de Turnstile',
    turnstileRetention:
      'El token original solo se trata durante la verificación. La aplicación conserva su hash antirrepetición durante un máximo de 5 minutos.',
    candidateLabel: 'Candidatos resueltos',
    candidateRetention:
      'El código abreviado de la publicación, los metadatos de seguridad de los candidatos y la autorización almacenada de forma sellada se conservan durante un máximo de 10 minutos, periodo durante el cual se puede volver a crear un trabajo de descarga. Cada reserva temporal dura 30 segundos y no reduce el plazo de conservación de los candidatos.',
    downloadLabel: 'Trabajos de descarga',
    downloadRetention:
      'Un trabajo debe comenzar en los 10 minutos posteriores a su emisión. Una vez iniciado, el plazo de inactividad es de 10 minutos y la duración absoluta máxima es de 1 hora. Los trabajos completados se conservan durante 90 segundos para admitir las solicitudes necesarias del navegador. Una concesión temporal de transmisión dura como máximo 15 minutos y no puede superar la duración del trabajo.',
    retentionBoundary:
      'Estos plazos son reglas de caducidad y eliminación lógica en la aplicación. No garantizan los plazos de conservación de los registros de seguridad perimetral de Cloudflare, las copias de seguridad de la infraestructura, los registros del navegador del usuario ni los sistemas de terceros.',
    securityTitle: 'Límites de seguridad',
    security:
      'La aplicación trata como hashes identificadores como la sesión, el token CSRF, la IP y el token de Turnstile, y almacena de forma sellada las URL de los medios de origen. Esto no hace que todos los metadatos de las versiones, el estado de los intervalos de bytes u otros estados del servicio estén cifrados. Este aviso no afirma que todos los datos estén cifrados, que no se guarde ningún registro ni que los datos se eliminen físicamente de inmediato.',
    contactTitle: 'Contacto sobre privacidad y tratamiento de datos',
    contact:
      'El nombre público del operador es Pony. Para consultas sobre la privacidad o el tratamiento de datos de este servicio, escribe a:',
    contactLabel: 'Enviar consultas sobre privacidad y tratamiento de datos a pony@pylot.dev',
    reviewTitle: 'Recordatorio de revisión periódica',
    review:
      'Esta página no constituye asesoramiento jurídico. El operador debe revisarla periódicamente según la ubicación real, los flujos de datos, la configuración de Cloudflare y las políticas de conservación vigentes, y actualizarla cuando cambien esas condiciones.',
  },
  copyright: {
    eyebrow: 'LEGAL / DERECHOS DE AUTOR',
    title: 'Aviso de derechos de autor y retirada de contenido',
    introduction:
      'El contenido publicado abiertamente en internet puede seguir protegido por derechos de autor y otros derechos.',
    rightsTitle: 'Límites de los derechos',
    rights:
      'Que el contenido sea visible públicamente no significa que se pueda descargar, copiar, almacenar, compartir o usar de cualquier otro modo sin restricciones. Una finalidad de investigación o no comercial no concede permiso por sí misma ni implica necesariamente que el uso esté amparado por una limitación o excepción a los derechos de autor en ninguna jurisdicción. El contenido y los derechos relacionados pertenecen a sus respectivos titulares, y los usuarios deben establecer sus derechos o fundamento lícito según el uso que realmente hagan.',
    statusBadge: 'Información del servicio en producción',
    statusTitle: 'Identidad del operador y contacto para notificaciones',
    statusContact:
      'El nombre público del operador es Pony. El titular de un derecho o su representante autorizado puede enviar una notificación de derechos de autor o solicitud de retirada de contenido a:',
    contactLabel: 'Enviar una notificación de derechos de autor o retirada a pony@pylot.dev',
    statusBoundary:
      'Esta página no constituye asesoramiento jurídico ni afirma que sea aplicable un procedimiento legal de una jurisdicción concreta. El operador debe revisar periódicamente esta página y el proceso de gestión de notificaciones según la ubicación real, las condiciones del servicio y la legislación aplicable.',
    noticeTitle: 'Información que debe incluir una notificación',
    noticeIntro:
      'Para facilitar una revisión razonable basada en hechos verificables, la notificación debe incluir:',
    noticeIdentity:
      'El nombre de la persona u organización que envía la notificación y los datos de contacto para responder.',
    noticeWork:
      'La obra sobre la que se reivindican derechos y una fuente original que pueda verificarse.',
    noticeLocation:
      'La URL de Threads, la página del sitio u otra información suficiente para identificar el contenido en cuestión.',
    noticeBasis:
      'El fundamento de los derechos reivindicados y la medida que se solicita a este servicio.',
    noticeAccuracy:
      'Una declaración suficiente para confirmar la exactitud de la notificación y la autoridad de quien la envía.',
    processTitle: 'Límites del proceso',
    process:
      'Esta página solo describe información general para notificaciones sobre derechos. No afirma que sea aplicable ningún régimen nacional o regional concreto de notificación y retirada, de puerto seguro («safe harbor») o de contranotificación, ni inventa formatos legales, plazos de tramitación, reglas de retirada automática, determinaciones de responsabilidad, legislación aplicable o jurisdicción.',
    affiliationTitle: 'Sin afiliación oficial',
    affiliation:
      'Este servicio no es un producto oficial de Meta, Instagram, Threads ni SpaceX, y no cuenta con su respaldo, autorización, encargo ni colaboración.',
  },
} as const satisfies MessageCatalog;
