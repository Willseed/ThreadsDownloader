import { type ApiErrorCode } from '@threads-downloader/contracts';

import { type MessageCatalog } from './zh-TW.js';

export const ko = {
  locale: {
    code: 'ko',
    direction: 'ltr',
    name: '한국어',
  },
  metadata: {
    description:
      '안전한 동일 출처 브라우저 흐름을 통해 공개 Threads 게시물의 동영상 버전을 분석합니다. 기술 및 학술 연구용으로 설계되었습니다.',
  },
  routes: {
    home: 'Threads Downloader — 공개 콘텐츠 연구 도구',
    terms: '이용 약관 | Threads Downloader',
    privacy: '개인정보 보호 및 데이터 처리 | Threads Downloader',
    copyright: '저작권 및 삭제 요청 안내 | Threads Downloader',
  },
  app: {
    brand: 'Threads Downloader',
    languageLabel: '언어 선택',
    skipLink: '본문으로 건너뛰기',
    headerLabel: '사이트 헤더',
    homeLabel: 'Threads Downloader 홈',
    primaryNavigationLabel: '주요 탐색',
    startDownload: '다운로드 시작',
    disclaimer:
      '이 서비스는 Threads 공식 서비스가 아닙니다. 사용자는 콘텐츠에 대한 권리를 확인하고 관련 법률 및 플랫폼 약관을 준수해야 합니다.',
    legalNavigationLabel: '법적 정보',
    terms: '이용 약관',
    privacy: '개인정보 보호 및 데이터 처리',
    copyright: '저작권 및 삭제 요청',
  },
  downloader: {
    pageTitle: '공개 Threads 동영상 다운로드',
    heroCopy: '게시물 URL을 붙여넣고 인증을 완료한 후 동영상 버전을 선택하세요.',
    workflowLabel: '동영상 가져오기',
    postUrlLabel: 'Threads 게시물 URL',
    postUrlPlaceholder: 'https://www.threads.com/@username/post/shortcode',
    postUrlHelp: 'threads.com 및 threads.net을 지원합니다.',
    postUrlError: '올바른 공개 Threads 게시물 URL을 입력하세요.',
    rightsConfirmation: '이 콘텐츠를 다운로드하고 사용할 권리가 있음을 확인합니다',
    rightsDetail:
      '본인이 콘텐츠 소유자이거나 허가를 받았거나 관련 법률에 따라 저장할 수 있음을 확인합니다. 학술 또는 비상업적 목적 자체만으로 허가가 부여되는 것은 아니며, 법률과 플랫폼 약관을 준수할 책임이 본인에게 있음을 이해합니다.',
    rightsDetailLink: '콘텐츠 사용 책임 확인',
    rightsError: '계속하기 전에 콘텐츠를 사용할 권리를 확인하세요.',
    turnstileLabel: '보안 인증',
    verificationUnavailable: '보안 인증을 사용할 수 없습니다. 다시 로드한 후 재시도하세요.',
    reloadVerification: '보안 인증 다시 로드',
    verificationRequired: '먼저 보안 인증을 완료하세요.',
    resolvingAction: '동영상을 가져오는 중…',
    resolveAction: '동영상 가져오기',
    bootstrapStatus: '보안 세션을 설정하는 중…',
    resolveStatus: '공개 게시물을 분석하는 중…',
    requestReference: (requestId: string) => `참조 번호: ${requestId}`,
    retryBootstrap: '새 보안 세션 시작',
    candidateCount: (count: number) => `${count}개의 동영상 버전을 찾았습니다`,
    quality: '화질',
    duration: '재생 시간',
    size: '크기',
    candidateFallback: '동영상 세부 정보는 원본에 따라 달라집니다',
    preparingCandidate: '동영상을 준비하는 중…',
    preparingCandidateLabel: '동영상 준비 중',
    openOrDownload: '동영상 열기 또는 다운로드',
    candidateActionLabel: (action: string, index: number, filename: string) =>
      `${action}: 버전 ${index}, ${filename}`,
    handoffMessage:
      '동영상이 브라우저에 전달되었습니다. 플레이어에서 열리면 브라우저의 저장 기능을 사용하세요.',
    resolveRequirements: '권리 확인, URL 및 인증 상태를 확인한 후 다시 시도하세요.',
    candidateInvalid: '이 동영상 버전은 유효하지 않습니다. 게시물을 다시 분석하세요.',
    invalidDownloadId: '다운로드 식별자가 올바르지 않습니다.',
    genericError: '서비스를 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.',
  },
  apiErrors: {
    HOST_NOT_ALLOWED: '이 웹사이트에서는 이 서비스를 사용할 수 없습니다.',
    SESSION_INVALID: '세션이 유효하지 않습니다. 새 보안 세션을 시작하세요.',
    SESSION_EXPIRED: '세션이 만료되었습니다. 새 보안 세션을 시작하세요.',
    SESSION_UNAVAILABLE: '세션을 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.',
    REQUEST_INVALID: '요청 형식이 올바르지 않습니다.',
    REQUEST_TOO_LARGE: '요청이 크기 제한을 초과했습니다.',
    URL_INVALID: '올바른 Threads 게시물 URL을 입력하세요.',
    RATE_LIMITED: '요청이 너무 많습니다. 나중에 다시 시도하세요.',
    TURNSTILE_INVALID: '인증에 실패했습니다. 인증을 다시 완료한 후 재시도하세요.',
    TURNSTILE_UNAVAILABLE: '인증 서비스를 일시적으로 사용할 수 없습니다.',
    THREADS_LOGIN_REQUIRED: '이 게시물을 보려면 Threads에 로그인해야 합니다.',
    THREADS_ACCESS_DENIED: 'Threads에서 이 게시물에 대한 접근을 거부했습니다.',
    THREADS_RATE_LIMITED:
      'Threads에서 일시적으로 접근을 제한하고 있습니다. 나중에 다시 시도하세요.',
    THREADS_BOT_BLOCKED: 'Threads에서 자동화된 접근을 일시적으로 차단하고 있습니다.',
    THREADS_JAVASCRIPT_REQUIRED: '현재 이 게시물을 불러오려면 JavaScript가 필요합니다.',
    MEDIA_NOT_FOUND: '지원되는 동영상 버전을 찾지 못했습니다.',
    RESOLVE_UNAVAILABLE: '현재 이 게시물을 분석할 수 없습니다. 나중에 다시 시도하세요.',
    DOWNLOAD_EXPIRED: '다운로드 세션이 만료되었습니다. 새 다운로드를 시작하세요.',
    DOWNLOAD_CONCURRENT_LIMIT: '동시 다운로드 한도에 도달했습니다. 나중에 다시 시도하세요.',
    DOWNLOAD_RANGE_UNAVAILABLE: '요청한 바이트 범위를 사용할 수 없습니다.',
    DOWNLOAD_UPSTREAM_UNAVAILABLE:
      '다운로드 원본을 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.',
    DOWNLOAD_UNAVAILABLE: '다운로드를 일시적으로 사용할 수 없습니다. 나중에 다시 시도하세요.',
    NOT_FOUND: '요청한 API 경로를 찾을 수 없습니다.',
    INTERNAL_ERROR: '서버에서 요청을 일시적으로 처리할 수 없습니다.',
  } satisfies Readonly<Record<ApiErrorCode, string>>,
  legalModal: {
    eyebrow: '법률 정보',
    close: '닫기',
    loading: '법적 정보를 불러오는 중입니다.',
    error: '법적 정보를 일시적으로 불러올 수 없습니다. 나중에 다시 시도하세요.',
    retry: '다시 로드',
  },
  researchPurpose: {
    title: '연구 목적 및 법적 경계',
    purpose:
      '이 서비스는 기술 및 학술 연구 목적으로만 제공됩니다. 운영자는 서비스 제공을 통해 상업적 또는 경제적 이익을 추구하지 않습니다.',
    boundary:
      '위 목적 및 비상업적이라는 설명은 운영자나 사용자가 콘텐츠에 대한 허가를 받았음을 의미하지 않습니다. 또한 특정 다운로드, 저장 또는 기타 이용이 합법적이거나 저작권 제한 또는 예외에 해당함을 의미하지 않으며, 관련 법률에 따른 책임을 면제하지 않습니다.',
    authorization:
      '공개적으로 볼 수 있다는 사실이나 연구 또는 비상업적 목적은 허가를 부여하지 않습니다. 사용자는 콘텐츠를 소유하거나 유효한 허가를 받았거나 실제로 적용되는 법률에 따라 의도한 방식으로 이용할 수 있어야 합니다.',
    access:
      '이 서비스는 일반 대중이 로그인 없이 접근할 수 있는 Threads 게시물만 처리합니다. 비공개, 로그인이 필요하거나 제한된 콘텐츠를 처리하지 않으며 로그인, 기술적 조치 또는 기타 접근 제한을 우회하지 않습니다.',
  },
  terms: {
    eyebrow: '법률 / 이용 약관',
    title: '이용 약관',
    introduction: '이 서비스를 사용하기 전에 기술적 범위, 권리 요건 및 법적 경계를 확인하세요.',
    scopeTitle: '서비스 범위',
    scopePublic:
      '이 서비스는 지원되는 도메인에서 로그인 없이 접근할 수 있는 공개 Threads 게시물 URL만 받습니다.',
    scopeCredentials:
      '이 서비스는 Threads 또는 Instagram의 쿠키, 계정 자격 증명 또는 로그인 토큰을 받지 않습니다. 비공개 또는 제한된 콘텐츠나 기술적 조치를 우회해야 하는 콘텐츠를 처리하는 데 사용해서는 안 됩니다.',
    scopeDelivery:
      '이 서비스는 공개 게시물의 동영상 버전을 분석하고 동일 출처를 통해 다운로드를 전달합니다. 원본의 가용성, 콘텐츠의 완전성 및 브라우저의 최종 파일 저장 결과는 원본과 사용자 환경의 영향을 받을 수 있습니다.',
    rightsTitle: '사용자의 책임 및 권리',
    rightsBasis:
      '요청을 제출하기 전에 사용자는 콘텐츠를 소유하거나 유효한 허가를 받았거나 관련 법률에 따라 의도한 방식으로 이용할 수 있음을 확인해야 합니다.',
    rightsOwnership:
      '콘텐츠와 관련 저작권, 상표권 및 기타 권리는 각 권리자에게 있습니다. 이 서비스는 제3자 콘텐츠에 대한 어떠한 권리도 부여하지 않습니다.',
    rightsUse:
      '사용자는 실제 이용 방식에 따라 다운로드한 콘텐츠를 저장, 편집, 복제, 재게시, 공유하거나 기타 방식으로 이용할 권리와 법적 근거를 확인할 책임이 있습니다.',
    rightsAbuse:
      '이 서비스를 사용하여 타인의 권리를 침해하거나 서비스 보안을 방해하거나 원본 플랫폼의 접근 통제를 우회해서는 안 됩니다.',
    affiliationTitle: '제3자 및 비제휴 고지',
    affiliation:
      '이 서비스는 Meta, Instagram, Threads 또는 SpaceX의 공식 제품이 아니며 이들의 보증, 승인, 위탁 또는 협력으로 운영되지 않습니다. 제3자 콘텐츠와 표장에 대한 권리는 각 권리자에게 있습니다.',
    reviewTitle: '운영자 및 정기 검토',
    review:
      '운영자의 표시 이름은 Pony입니다. 이 페이지는 법률 자문이 아니며 특정 다운로드의 합법성을 판단하지 않습니다. 운영자는 실제 소재지, 데이터 흐름, 서비스 상태 및 관련 법률에 따라 본 약관을 정기적으로 검토하고 운영 조건이나 법률이 변경되면 업데이트해야 합니다.',
  },
  privacy: {
    eyebrow: '법률 / 개인정보 보호',
    title: '개인정보 보호 및 데이터 처리 안내',
    introduction:
      '이 페이지에서는 현재 서비스가 처리하는 데이터, 처리 목적, 수신자 및 애플리케이션 수준의 논리적 보존 기간을 설명합니다.',
    dataTitle: '처리하는 데이터',
    dataPost:
      '사용자가 제출한 공개 Threads 게시물 URL과 권리 확인, 분석된 게시물 숏코드, 버전 파일 이름, 크기, 재생 시간 및 관련 보안 메타데이터를 처리합니다.',
    dataCookie:
      '이 서비스는 HttpOnly, Secure, SameSite=Lax 및 Path=/ 속성이 있는 익명 __Host-td_session 쿠키를 설정합니다. 서버는 세션 및 CSRF 토큰의 해시값과 만료 시간도 처리합니다.',
    dataIp:
      '연결 IP 주소는 요청을 처리하는 동안 보안 인증에 사용됩니다. 이 주소에서 파생된 서버 키 기반 해시는 단기 요청 제한에 사용됩니다. 이 안내는 서비스가 IP 주소를 전혀 처리하지 않는다고 주장하지 않습니다.',
    dataTurnstile:
      'Cloudflare Turnstile 인증 토큰, 단기 재사용 방지 해시, 인증 시간 및 보안 요청 식별자입니다.',
    dataDownload:
      '다운로드 작업에 필요한 불투명 식별자, 봉인된 형태로 저장된 원본 미디어 URL, 파일 보안 메타데이터, 바이트 범위, 작업 상태, 임시 실행 리스(lease) 및 타임스탬프입니다.',
    purposeTitle: '처리 목적',
    purpose:
      '이 데이터는 익명 세션 설정, 동일 출처 요청 확인, 공개 게시물 분석, 브라우저로 다운로드 전달, 이어받기 전송 지원, 재사용·악용·과도한 동시 실행 방지에 사용됩니다. 이 서비스는 사용자에게 Threads 또는 Instagram 로그인 쿠키, 계정 비밀번호 또는 접근 토큰을 요구하지 않으며 이러한 로그인 자격 증명을 원본 서비스에 전달하지 않습니다.',
    recipientTitle: '데이터 수신자 및 외부 서비스',
    recipientCloudflare:
      'Cloudflare Workers와 Durable Objects는 사이트 요청, 단기 상태 및 스트리밍 전송을 처리합니다. Cloudflare Turnstile은 인증 토큰, 연결 IP 주소 및 인증에 필요한 브라우저와 요청 데이터를 수신합니다.',
    recipientThreads:
      'Threads는 사용자가 제출한 공개 게시물을 읽기 위해 서버가 보내는 HTTPS 요청을 수신합니다.',
    recipientInstagram:
      'Instagram 콘텐츠 전송 네트워크(CDN)는 미디어를 확인하고 바이트 범위 콘텐츠를 전달하기 위해 서버가 보내는 HTTPS 요청을 수신합니다.',
    recipientBoundary:
      '따라서 이 서비스는 제3자가 데이터를 처리하지 않는다고 주장하지 않습니다. Cloudflare 엣지 보안 로그, 인프라 백업 및 기타 인프라 기록의 보존은 이 애플리케이션 코드에 의해 결정되지 않으며 당시 유효한 정책과 실제 서비스 설정에 따라 정기적으로 검토해야 합니다.',
    retentionTitle: '애플리케이션 수준의 논리적 보존',
    sessionLabel: '익명 세션',
    sessionRetention:
      '쿠키, 세션 해시 및 CSRF 해시는 최대 12시간 동안 보존됩니다. 만료 후 세션 저장소의 예약 알람이 이를 삭제합니다.',
    ipLabel: 'IP 요청 제한',
    ipRetention:
      '분석 이벤트에는 60초 요청 제한 구간이 적용되며 활성 분석 허가는 최대 30초 동안 유지됩니다. 익명 세션을 설정할 때 서버 키 기반 IP 해시, 할당량 발급 이벤트 및 필요한 불투명 예약 데이터는 최대 12시간 동안 보존됩니다. 단기 예약은 30초 동안 유지되며 대기 중인 데이터가 없으면 요청 제한 상태가 삭제됩니다.',
    turnstileLabel: 'Turnstile 재사용 방지',
    turnstileRetention:
      '원본 토큰은 인증 과정에서만 처리됩니다. 애플리케이션은 재사용 방지 해시를 최대 5분 동안 보존합니다.',
    candidateLabel: '분석 후보',
    candidateRetention:
      '게시물 숏코드, 후보 보안 메타데이터 및 봉인된 형태로 저장된 권한은 최대 10분 동안 보존되며 이 기간에 다운로드 작업을 다시 생성할 수 있습니다. 각 임시 예약은 30초 동안 유지되며 후보 보존 기간을 단축하지 않습니다.',
    downloadLabel: '다운로드 작업',
    downloadRetention:
      '작업은 발급 후 10분 이내에 시작해야 합니다. 시작 후 유휴 만료 시간은 10분이며 절대 최대 수명은 1시간입니다. 완료된 작업은 필요한 브라우저 요청을 지원하기 위해 90초 동안 보존됩니다. 스트리밍 실행 리스는 최대 15분 동안 유지되며 작업 수명을 초과할 수 없습니다.',
    retentionBoundary:
      '위 기간은 애플리케이션 수준의 논리적 만료 및 삭제 규칙입니다. Cloudflare 엣지 보안 로그, 인프라 백업, 사용자 브라우저 기록 또는 제3자 시스템의 보존 기간을 보장하지 않습니다.',
    securityTitle: '보안 경계',
    security:
      '애플리케이션은 세션, CSRF 토큰, IP 및 Turnstile 토큰과 같은 식별자를 해시로 처리하고 원본 미디어 URL을 봉인된 형태로 저장합니다. 그렇다고 모든 버전 메타데이터, 바이트 범위 상태 또는 기타 서비스 상태가 암호화되는 것은 아닙니다. 이 안내는 모든 데이터가 암호화되거나 기록이 전혀 보존되지 않거나 데이터가 즉시 물리적으로 삭제된다고 주장하지 않습니다.',
    contactTitle: '개인정보 보호 및 데이터 처리 문의',
    contact:
      '운영자의 표시 이름은 Pony입니다. 이 서비스의 개인정보 보호 또는 데이터 처리에 관한 문의는 다음 이메일로 보내세요.',
    contactLabel: 'pony@pylot.dev로 개인정보 보호 및 데이터 처리 문의 보내기',
    reviewTitle: '정기 검토 안내',
    review:
      '이 페이지는 법률 자문이 아닙니다. 운영자는 실제 소재지, 데이터 흐름, Cloudflare 설정 및 당시 유효한 보존 정책에 따라 이 페이지를 정기적으로 검토하고 관련 조건이 변경되면 업데이트해야 합니다.',
  },
  copyright: {
    eyebrow: '법률 / 저작권',
    title: '저작권 및 삭제 요청 안내',
    introduction: '인터넷에 공개된 콘텐츠도 저작권 및 기타 권리의 보호를 받을 수 있습니다.',
    rightsTitle: '권리 경계',
    rights:
      '콘텐츠를 공개적으로 볼 수 있다고 해서 제한 없이 다운로드, 복제, 저장, 공유하거나 기타 방식으로 이용할 수 있는 것은 아닙니다. 연구 또는 비상업적 목적 자체만으로 허가가 부여되거나 특정 관할권의 저작권 제한 또는 예외가 적용되는 것은 아닙니다. 콘텐츠 및 관련 권리는 각 권리자에게 있으며 사용자는 실제 이용 방식에 따라 자신의 권리 또는 합법적 근거를 확인해야 합니다.',
    statusBadge: '운영 중인 서비스 정보',
    statusTitle: '운영자 신원 및 알림 연락처',
    statusContact:
      '운영자의 표시 이름은 Pony입니다. 권리자 또는 권한을 위임받은 대리인은 다음 이메일로 저작권 또는 삭제 요청을 보낼 수 있습니다.',
    contactLabel: 'pony@pylot.dev로 저작권 또는 삭제 요청 보내기',
    statusBoundary:
      '이 페이지는 법률 자문이 아니며 특정 관할권의 법정 절차가 적용된다고 주장하지 않습니다. 운영자는 실제 소재지, 서비스 상태 및 관련 법률에 따라 이 페이지와 요청 처리 절차를 정기적으로 검토해야 합니다.',
    noticeTitle: '요청에 포함할 정보',
    noticeIntro:
      '검증 가능한 사실을 바탕으로 합리적으로 검토할 수 있도록 다음 정보를 포함하는 것이 좋습니다.',
    noticeIdentity: '요청을 보내는 개인 또는 단체의 이름과 회신 가능한 연락처입니다.',
    noticeWork: '권리를 주장하는 저작물과 확인 가능한 원본 출처입니다.',
    noticeLocation:
      '관련 Threads URL, 사이트 페이지 또는 해당 콘텐츠를 식별하기에 충분한 정보입니다.',
    noticeBasis: '주장하는 권리의 근거와 이 서비스에 요청하는 조치입니다.',
    noticeAccuracy: '요청 내용의 정확성과 발신자의 권한을 확인하기에 충분한 설명입니다.',
    processTitle: '절차의 한계',
    process:
      '이 페이지는 일반적인 권리 요청 정보만 설명합니다. 특정 국가 또는 지역의 통지 및 삭제, 세이프 하버 또는 이의 제기 통지 제도가 적용된다고 주장하지 않으며 법정 형식, 처리 기한, 자동 삭제 규칙, 책임 판단, 준거법 또는 관할권을 임의로 만들지 않습니다.',
    affiliationTitle: '공식 제휴 없음',
    affiliation:
      '이 서비스는 Meta, Instagram, Threads 또는 SpaceX의 공식 제품이 아니며 이들의 보증, 승인, 위탁 또는 협력으로 운영되지 않습니다.',
  },
} as const satisfies MessageCatalog;
