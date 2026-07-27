import { type ApiErrorCode } from '@threads-downloader/contracts';

import { type MessageCatalog } from './zh-TW.js';

export const zhCN = {
  locale: {
    code: 'zh-CN',
    direction: 'ltr',
    name: '简体中文',
  },
  metadata: {
    description:
      '通过安全的同源浏览器流程处理公开 Threads 帖子的视频版本。仅供技术和学术研究使用。',
  },
  routes: {
    home: 'Threads Downloader — 公开媒体研究工具',
    terms: '使用条款｜Threads Downloader',
    privacy: '隐私与数据处理｜Threads Downloader',
    copyright: '著作权与下架通知｜Threads Downloader',
  },
  app: {
    brand: 'Threads Downloader',
    languageLabel: '选择语言',
    skipLink: '跳转到主要内容',
    headerLabel: '网站页眉',
    homeLabel: 'Threads Downloader 首页',
    primaryNavigationLabel: '主要导航',
    startDownload: '开始下载',
    disclaimer: '本服务并非 Threads 官方服务；用户须自行确认内容权利，并遵守适用法律及平台条款。',
    legalNavigationLabel: '法律信息导航',
    terms: '使用条款',
    privacy: '隐私与数据处理',
    copyright: '著作权与下架通知',
  },
  downloader: {
    pageTitle: '下载公开 Threads 视频',
    heroCopy: '粘贴帖子网址，验证后选择视频版本。',
    workflowLabel: '获取视频',
    postUrlLabel: 'Threads 帖子网址',
    postUrlPlaceholder: 'https://www.threads.com/@username/post/shortcode',
    postUrlHelp: '支持 threads.com 和 threads.net',
    postUrlError: '请输入有效的公开 Threads 帖子网址。',
    rightsConfirmation: '我确认我有权下载并使用此内容',
    rightsDetail:
      '我确认我拥有该内容、已取得授权，或依适用法律可以保存该内容；我了解学术或非商业目的本身不构成授权，并自行负责遵守法律及平台条款。',
    rightsDetailLink: '查看内容使用责任',
    rightsError: '必须先确认内容使用权利。',
    turnstileLabel: 'Cloudflare Turnstile',
    verificationUnavailable: '安全验证无法使用，请重新加载安全验证。',
    reloadVerification: '重新加载安全验证',
    verificationRequired: '请先完成安全验证。',
    resolvingAction: '正在获取视频……',
    resolveAction: '获取视频',
    bootstrapStatus: '正在建立安全会话……',
    resolveStatus: '正在解析公开帖子……',
    requestReference: (requestId: string) => `参考编号：${requestId}`,
    retryBootstrap: '重新建立安全会话',
    candidateCount: (count: number) => `找到 ${count} 个视频版本`,
    quality: '画质',
    duration: '视频时长',
    size: '大小',
    candidateFallback: '视频信息由来源决定',
    preparingCandidate: '正在准备视频……',
    preparingCandidateLabel: '正在准备视频',
    openOrDownload: '打开或下载视频',
    candidateActionLabel: (action: string, index: number, filename: string) =>
      `${action}，版本 ${index}：${filename}`,
    handoffMessage: '已交由浏览器处理；如果打开播放器，请使用浏览器的保存功能。',
    resolveRequirements: '请确认权利、网址和验证状态后重试。',
    candidateInvalid: '视频版本无效，请重新解析帖子。',
    invalidDownloadId: '下载标识符格式不正确。',
    genericError: '服务暂时无法使用，请稍后重试。',
  },
  apiErrors: {
    HOST_NOT_ALLOWED: '不允许从此网站使用本服务。',
    SESSION_INVALID: '会话无效，请重新建立安全会话。',
    SESSION_EXPIRED: '会话已过期，请重新建立安全会话。',
    SESSION_UNAVAILABLE: '会话暂时无法使用，请稍后重试。',
    REQUEST_INVALID: '请求格式不正确。',
    REQUEST_TOO_LARGE: '请求内容超出大小限制。',
    URL_INVALID: '请输入有效的 Threads 帖子网址。',
    RATE_LIMITED: '操作过于频繁，请稍后重试。',
    TURNSTILE_INVALID: '验证失败，请重新验证后重试。',
    TURNSTILE_UNAVAILABLE: '验证服务暂时无法使用。',
    THREADS_LOGIN_REQUIRED: '此帖子需要登录 Threads 才能访问。',
    THREADS_ACCESS_DENIED: 'Threads 拒绝访问此帖子。',
    THREADS_RATE_LIMITED: 'Threads 暂时限制访问，请稍后重试。',
    THREADS_BOT_BLOCKED: 'Threads 暂时阻止自动访问。',
    THREADS_JAVASCRIPT_REQUIRED: '此帖子当前需要 JavaScript 才能加载。',
    MEDIA_NOT_FOUND: '找不到可下载的视频。',
    RESOLVE_UNAVAILABLE: '暂时无法解析此帖子，请稍后重试。',
    DOWNLOAD_EXPIRED: '下载会话已过期，请重新建立下载。',
    DOWNLOAD_CONCURRENT_LIMIT: '同时下载数量已达上限，请稍后重试。',
    DOWNLOAD_RANGE_UNAVAILABLE: '无法提供请求的下载范围。',
    DOWNLOAD_UPSTREAM_UNAVAILABLE: '下载源暂时无法使用，请稍后重试。',
    DOWNLOAD_UNAVAILABLE: '下载暂时无法使用，请稍后重试。',
    NOT_FOUND: '找不到请求的 API 路径。',
    INTERNAL_ERROR: '服务器暂时无法处理请求。',
  } satisfies Readonly<Record<ApiErrorCode, string>>,
  legalModal: {
    eyebrow: '法律／按需查看',
    close: '关闭',
    loading: '正在加载法律信息。',
    error: '法律信息暂时无法加载，请稍后重试。',
    retry: '重新加载',
  },
  researchPurpose: {
    title: '研究目的与法律边界',
    purpose:
      '本服务的设立与运营仅用于技术和学术研究，运营者不通过提供本服务获取任何商业或经济利益。',
    boundary:
      '上述目的及非商业声明不代表运营者或用户已取得任何内容授权，不表示特定下载、保存或其他使用必然合法，或必然符合著作权限制或例外，也不免除任何人依适用法律应承担的责任。',
    authorization:
      '公开可见、研究或非商业目的不等于授权。用户必须拥有该内容、取得有效授权，或依实际适用法律确实可以进行预定使用。',
    access:
      '本服务仅处理普通公众无需登录即可访问的 Threads 帖子，不处理私人、需要登录或受限制的内容，也不绕过登录、技术措施或其他访问限制。',
  },
  terms: {
    eyebrow: '法律／使用条款',
    title: '使用条款',
    introduction: '使用本服务前，请阅读本服务的技术范围、权利要求和法律边界。',
    scopeTitle: '服务范围',
    scopePublic: '本服务仅接受支持的域名中无需登录即可访问的公开 Threads 帖子网址。',
    scopeCredentials:
      '本服务不接受 Threads 或 Instagram 的 Cookie、账号凭据或登录 token，也不得用于处理私人、受限制或需要规避技术措施的内容。',
    scopeDelivery:
      '本服务提供公开帖子的视频版本解析和同源下载交付；来源可用性、内容完整性及浏览器的最终保存结果仍可能受来源和用户环境影响。',
    rightsTitle: '用户责任与权利',
    rightsBasis: '用户提交前须确认自己拥有内容、取得有效授权，或依适用法律可以进行预定使用。',
    rightsOwnership:
      '内容及相关著作权、商标和其他权利仍归原权利人所有；本服务不授予任何第三方内容权利。',
    rightsUse:
      '下载后的保存、编辑、复制、再发布、分享或其他使用，由用户根据实际用途确认权利依据和法律责任。',
    rightsAbuse: '不得利用本服务侵害他人权利、干扰服务安全，或规避来源平台的访问控制。',
    affiliationTitle: '第三方与非隶属声明',
    affiliation:
      '本服务并非 Meta、Instagram、Threads 或 SpaceX 的官方产品，也未获其背书、授权、委托或合作。第三方内容及标志的权利仍归各权利人所有。',
    reviewTitle: '运营者与定期审查',
    review:
      '本服务运营者的显示名称为 Pony。本页不构成法律意见，也不对特定下载作合法性判定；运营者应根据实际所在地、数据流、服务情况及适用法律定期审查本条款，并在运营条件或法律发生变化时更新。',
  },
  privacy: {
    eyebrow: '法律／隐私',
    title: '隐私与数据处理说明',
    introduction:
      '本页根据当前代码实现的数据流，说明本服务处理的数据、用途、接收方及逻辑保留期限。',
    dataTitle: '处理的数据',
    dataPost:
      '用户输入的公开 Threads 帖子网址、权利确认，以及解析后的帖子短代码、版本文件名、尺寸、长度和其他安全元数据。',
    dataCookie:
      '本服务设置匿名的 __Host-td_session 会话 Cookie；其属性为 HttpOnly、Secure、SameSite=Lax，且仅限本站路径。服务器还会处理会话及 CSRF token 的哈希值和到期时间。',
    dataIp:
      '连接 IP 会在请求处理期间用于安全验证，并以使用服务器端密钥生成的哈希标识值进行短期限流；本页不声称本服务完全不处理 IP。',
    dataTurnstile:
      'Cloudflare Turnstile 验证 token、其短期防重放哈希值、验证时间和安全请求标识数据。',
    dataDownload:
      '下载任务所需的不透明标识符、密封保存的来源媒体网址、文件安全元数据、Range 区间、任务状态、租约及时间戳。',
    purposeTitle: '处理目的',
    purpose:
      '上述数据用于建立匿名会话、验证同源请求、解析公开帖子、将下载交付给浏览器、支持断点续传，以及防止重放、滥用和超额并发。本服务不要求用户提供 Threads 或 Instagram 的登录 Cookie、账号密码或访问 token，也不会将这类登录凭据转交给来源服务。',
    recipientTitle: '数据接收方与外部服务',
    recipientCloudflare:
      'Cloudflare Workers 和 Durable Objects 处理本站请求、短期状态及流式传输；Cloudflare Turnstile 接收验证 token、连接 IP 及验证所需的浏览器和请求数据。',
    recipientThreads: 'Threads 接收服务器为读取用户提交的公开帖子而发出的 HTTPS 请求。',
    recipientInstagram:
      'Instagram 内容分发网络（CDN）接收服务器为确认媒体并交付 Range 内容而发出的 HTTPS 请求。',
    recipientBoundary:
      '因此，本服务不声称没有第三方处理。Cloudflare 基础设施的边缘安全记录、备份及其各自的保留政策不由此应用程序代码决定，应根据其当时有效的政策和实际服务设置定期审查。',
    retentionTitle: '应用程序逻辑保留期限',
    sessionLabel: '匿名会话',
    sessionRetention:
      'Cookie、会话哈希值及 CSRF 哈希值最长保留 12 小时；到期后由会话存储的定时任务清除。',
    ipLabel: 'IP 限流',
    ipRetention:
      '解析事件使用 60 秒限流窗口，生效中的解析许可最长为 30 秒。建立匿名会话时，使用服务器端密钥生成的 IP 哈希值、配额签发事件及必要的不透明预约数据最长保留 12 小时；短效预约为 30 秒，没有待处理数据后会删除该限流状态。',
    turnstileLabel: 'Turnstile 防重放',
    turnstileRetention: '原始 token 仅在验证流程中处理；应用程序最长保存其防重放哈希值 5 分钟。',
    candidateLabel: '解析候选项',
    candidateRetention:
      '帖子短代码、候选项安全元数据及密封授权最长保留 10 分钟；在此期间可重新建立下载任务。单次签发的临时预约为 30 秒，不会缩短候选项的保留期限。',
    downloadLabel: '下载任务',
    downloadRetention:
      '必须在签发后 10 分钟内开始；开始后空闲期限为 10 分钟，绝对最长存续时间为 1 小时。完成后保留 90 秒，以支持必要的浏览器请求；流式传输租约最长为 15 分钟，且不得超过任务期限。',
    retentionBoundary:
      '上述期限是应用程序内的逻辑到期和删除规则，不等同于对 Cloudflare 边缘安全记录、基础设施备份、用户浏览器记录或第三方系统保留期限的保证。',
    securityTitle: '安全边界',
    security:
      '应用程序以哈希值处理会话、CSRF token、IP 和 Turnstile token 等标识数据，并密封保存来源媒体网址；但版本元数据、Range 状态及其他服务状态不会因此全部成为加密数据。本页不作出“所有数据均已加密”“完全不保留记录”或“数据会立即被物理删除”的声明。',
    contactTitle: '隐私与数据处理联系方式',
    contact: '本服务运营者的显示名称为 Pony。如对本服务的隐私或数据处理有疑问，可发送电子邮件至：',
    contactLabel: '发送隐私与数据处理咨询至 pony@pylot.dev',
    reviewTitle: '定期审查提醒',
    review:
      '本页不构成法律意见。运营者应根据实际所在地、数据流、Cloudflare 的实际设置及当时有效的保留政策定期审查本页，并在相关条件发生变化时更新。',
  },
  copyright: {
    eyebrow: '法律／著作权',
    title: '著作权与下架通知',
    introduction: '公开发布在网络上的内容仍可能受到著作权及其他权利保护。',
    rightsTitle: '权利边界',
    rights:
      '公开可见不表示内容可任意下载、复制、保存、分享或用于其他用途。研究或非商业目的也不当然构成授权，也不当然符合任何法域下的著作权限制与例外。内容及相关权利仍归原权利人所有，用户须根据实际用途确认其权利或合法依据。',
    statusBadge: '正式运营信息',
    statusTitle: '运营者身份与申诉联系方式',
    statusContact: '本服务运营者的显示名称为 Pony。权利人或其授权代表可将著作权或下架通知发送至：',
    contactLabel: '发送著作权或下架通知至 pony@pylot.dev',
    statusBoundary:
      '本页不构成法律意见，也不声称任何特定法域的法定程序已适用。运营者应根据实际所在地、服务情况及适用法律定期审查本页和通知处理流程。',
    noticeTitle: '通知应包含的信息',
    noticeIntro: '为便于根据可核实事实进行合理审查，通知方宜提供：',
    noticeIdentity: '通知方的姓名或组织名称，以及可用于回复的联系方式。',
    noticeWork: '主张权利的作品及可供核对的原始来源。',
    noticeLocation: '涉及申诉的 Threads 网址、本站页面或其他足以识别相关内容的信息。',
    noticeBasis: '通知方的权利依据，以及希望本服务采取的措施。',
    noticeAccuracy: '足以确认通知内容准确性及授权身份的说明。',
    processTitle: '流程边界',
    process:
      '本页当前仅说明一般权利通知信息，不声称适用任何特定国家或地区的通知与下架、安全港或反通知制度，也不虚构法定格式、处理期限、自动移除规则、责任认定、准据法或管辖。',
    affiliationTitle: '非官方隶属关系',
    affiliation:
      '本服务并非 Meta、Instagram、Threads 或 SpaceX 的官方产品，也未获其背书、授权、委托或合作。',
  },
} as const satisfies MessageCatalog;
