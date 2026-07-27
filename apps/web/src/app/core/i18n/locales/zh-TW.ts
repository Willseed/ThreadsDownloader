import { type ApiErrorCode } from '@threads-downloader/contracts';

export const zhTW = {
  locale: {
    code: 'zh-TW',
    direction: 'ltr',
    name: '繁體中文',
  },
  metadata: {
    description: '以安全、同源的瀏覽器流程處理公開 Threads 貼文影片版本。僅供技術及學術研究使用。',
  },
  routes: {
    home: 'Threads Downloader — 公開媒體研究工具',
    terms: '使用條款｜Threads Downloader',
    privacy: '隱私與資料處理｜Threads Downloader',
    copyright: '著作權與下架通知｜Threads Downloader',
  },
  app: {
    brand: 'Threads Downloader',
    languageLabel: '選擇語言',
    skipLink: '跳到主要內容',
    headerLabel: '網站標頭',
    homeLabel: 'Threads Downloader 首頁',
    primaryNavigationLabel: '主要導覽',
    startDownload: '開始下載',
    disclaimer: '本服務非 Threads 官方服務；使用者須自行確認內容權利，並遵守適用法律與平台條款。',
    legalNavigationLabel: '法務資訊',
    terms: '使用條款',
    privacy: '隱私與資料處理',
    copyright: '著作權與下架通知',
  },
  downloader: {
    pageTitle: '下載公開 Threads 影片',
    heroCopy: '貼上貼文網址，驗證後選擇影片版本。',
    workflowLabel: '取得影片',
    postUrlLabel: 'Threads 貼文網址',
    postUrlPlaceholder: 'https://www.threads.com/@username/post/shortcode',
    postUrlHelp: '支援 threads.com 與 threads.net',
    postUrlError: '請輸入有效的公開 Threads 貼文網址。',
    rightsConfirmation: '我確認我有權下載及使用此內容',
    rightsDetail:
      '我確認我擁有內容、已取得授權，或依適用法律得以保存；我了解學術或非商業目的本身不構成授權，並自行負責遵守法律與平台條款。',
    rightsDetailLink: '查看內容使用責任',
    rightsError: '必須先確認內容使用權利。',
    turnstileLabel: 'Cloudflare Turnstile',
    verificationUnavailable: '安全驗證無法使用，請重新載入安全驗證。',
    reloadVerification: '重新載入安全驗證',
    verificationRequired: '請先完成安全驗證。',
    resolvingAction: '正在取得影片……',
    resolveAction: '取得影片',
    bootstrapStatus: '正在建立安全工作階段……',
    resolveStatus: '正在解析公開貼文……',
    requestReference: (requestId: string) => `參考編號：${requestId}`,
    retryBootstrap: '重新建立安全工作階段',
    candidateCount: (count: number) => `找到 ${count} 個影片版本`,
    quality: '畫質',
    duration: '影片長度',
    size: '大小',
    candidateFallback: '影片資訊由來源決定',
    preparingCandidate: '正在準備影片……',
    preparingCandidateLabel: '正在準備影片',
    openOrDownload: '開啟或下載影片',
    candidateActionLabel: (action: string, index: number, filename: string) =>
      `${action}，版本 ${index}：${filename}`,
    handoffMessage: '已交由瀏覽器處理；若開啟播放器，請使用瀏覽器的儲存功能。',
    resolveRequirements: '請確認權利、網址與驗證狀態後再試。',
    candidateInvalid: '下載候選無效，請重新解析貼文。',
    invalidDownloadId: '下載識別碼格式不正確。',
    genericError: '服務暫時無法使用，請稍後再試。',
  },
  apiErrors: {
    HOST_NOT_ALLOWED: '不允許從此網站使用服務。',
    SESSION_INVALID: '工作階段無效，請重新建立安全工作階段。',
    SESSION_EXPIRED: '工作階段已過期，請重新建立安全工作階段。',
    SESSION_UNAVAILABLE: '工作階段暫時無法使用，請稍後再試。',
    REQUEST_INVALID: '請求格式不正確。',
    REQUEST_TOO_LARGE: '請求內容超過大小限制。',
    URL_INVALID: '請輸入有效的 Threads 貼文網址。',
    RATE_LIMITED: '操作過於頻繁，請稍後再試。',
    TURNSTILE_INVALID: '驗證失敗，請重新驗證後再試。',
    TURNSTILE_UNAVAILABLE: '驗證服務暫時無法使用。',
    THREADS_LOGIN_REQUIRED: '此貼文需要登入 Threads 才能存取。',
    THREADS_ACCESS_DENIED: 'Threads 拒絕存取此貼文。',
    THREADS_RATE_LIMITED: 'Threads 暫時限制存取，請稍後再試。',
    THREADS_BOT_BLOCKED: 'Threads 暫時阻擋自動存取。',
    THREADS_JAVASCRIPT_REQUIRED: '此貼文目前需要 JavaScript 才能載入。',
    MEDIA_NOT_FOUND: '找不到可下載的影片。',
    RESOLVE_UNAVAILABLE: '暫時無法解析此貼文，請稍後再試。',
    DOWNLOAD_EXPIRED: '下載工作階段已過期，請重新建立下載。',
    DOWNLOAD_CONCURRENT_LIMIT: '同時下載數量已達上限，請稍後再試。',
    DOWNLOAD_RANGE_UNAVAILABLE: '無法提供要求的下載範圍。',
    DOWNLOAD_UPSTREAM_UNAVAILABLE: '下載來源暫時無法使用，請稍後再試。',
    DOWNLOAD_UNAVAILABLE: '下載暫時無法使用，請稍後再試。',
    NOT_FOUND: '找不到請求的 API 路徑。',
    INTERNAL_ERROR: '伺服器暫時無法處理請求。',
  } satisfies Readonly<Record<ApiErrorCode, string>>,
  legalModal: {
    eyebrow: '法務／隨選即看',
    close: '關閉',
    loading: '正在載入法務資訊。',
    error: '法務資訊暫時無法載入，請稍後再試。',
    retry: '重新載入',
  },
  researchPurpose: {
    title: '研究目的與法律界線',
    purpose:
      '本服務之設置與營運目的僅為技術及學術研究，營運者不藉提供本服務獲取任何商業或經濟利益。',
    boundary:
      '上述目的與非商業聲明不代表營運者或使用者已取得任何內容授權，不表示特定下載、保存或其他使用必然合法或符合著作權限制或例外，也不免除任何人依適用法律應負的責任。',
    authorization:
      '公開可見、研究或非商業目的不等於授權。使用者必須擁有內容、取得有效授權，或依實際適用法律確實得為預定使用。',
    access:
      '本服務只處理無需登入即可由一般公眾存取的 Threads 貼文，不處理私人、須登入或受限制內容，也不繞過登入、技術措施或其他存取限制。',
  },
  terms: {
    eyebrow: '法務／使用條款',
    title: '使用條款',
    introduction: '使用本服務前，請閱讀本服務的技術範圍、權利要求與法律界線。',
    scopeTitle: '服務範圍',
    scopePublic: '本服務只接受支援網域中、無需登入即可存取的公開 Threads 貼文網址。',
    scopeCredentials:
      '本服務不接受 Threads 或 Instagram 的 Cookie、帳號憑證或登入 token，也不得用來處理私人、受限制或須規避技術措施的內容。',
    scopeDelivery:
      '本服務提供公開貼文的影片版本解析與同源下載交付；來源可用性、內容完整性及瀏覽器最終儲存結果仍可能受來源與使用者環境影響。',
    rightsTitle: '使用者責任與權利',
    rightsBasis: '使用者提交前須確認自己擁有內容、取得有效授權，或依適用法律得為預定使用。',
    rightsOwnership:
      '內容及相關著作權、商標與其他權利仍歸原權利人所有；本服務不授予任何第三方內容權利。',
    rightsUse:
      '下載後的保存、編輯、重製、再發布、分享或其他利用，由使用者依實際用途確認權利基礎與法律責任。',
    rightsAbuse: '不得藉本服務侵害他人權利、干擾服務安全，或規避來源平台的存取控制。',
    affiliationTitle: '第三方與非隸屬聲明',
    affiliation:
      '本服務並非 Meta、Instagram、Threads 或 SpaceX 的官方產品，亦未獲其背書、授權、委託或合作。第三方內容與標誌的權利仍屬各權利人。',
    reviewTitle: '營運者與定期審閱',
    review:
      '本服務營運者顯示名稱為 Pony。本頁不構成法律意見，亦不對特定下載作合法性判定；營運者應依實際所在地、資料流、服務情況與適用法律定期審閱本條款，並在營運條件或法律變動時更新。',
  },
  privacy: {
    eyebrow: '法務／隱私',
    title: '隱私與資料處理說明',
    introduction:
      '本頁依目前程式碼所實作的資料流，說明本服務處理的資料、用途、接收者與邏輯保存期限。',
    dataTitle: '處理的資料',
    dataPost:
      '使用者輸入的公開 Threads 貼文網址、權利確認，以及解析後的貼文短碼、版本檔名、尺寸、長度與其他安全中繼資料。',
    dataCookie:
      '本服務設定匿名的 __Host-td_session 工作階段 Cookie；其屬性為 HttpOnly、Secure、SameSite=Lax 且限本站路徑。伺服器另處理工作階段與 CSRF token 的雜湊及到期時間。',
    dataIp:
      '連線 IP 會在請求處理期間用於安全驗證，並以帶有服務端金鑰的雜湊識別值進行短期限流；本頁不宣稱服務完全不處理 IP。',
    dataTurnstile:
      'Cloudflare Turnstile 驗證 token、其短期防重放雜湊、驗證時間與安全請求識別資料。',
    dataDownload:
      '下載工作所需的不透明識別碼、密封的來源媒體網址、檔案安全中繼資料、Range 區間、工作狀態、租約與時間戳記。',
    purposeTitle: '處理目的',
    purpose:
      '上述資料用於建立匿名工作階段、驗證同源請求、解析公開貼文、將下載交付給瀏覽器、支援中斷續傳，以及防止重放、濫用與超額並行。服務不要求使用者提供 Threads 或 Instagram 的登入 Cookie、帳號密碼或存取 token，也不會把這類登入憑證轉交來源服務。',
    recipientTitle: '資料接收者與外部服務',
    recipientCloudflare:
      'Cloudflare Workers 與 Durable Objects 處理本站請求、短期狀態與串流；Cloudflare Turnstile 接收驗證 token、連線 IP 及驗證所需的瀏覽器與請求資料。',
    recipientThreads: 'Threads 接收伺服器為讀取使用者所提交公開貼文而發出的 HTTPS 請求。',
    recipientInstagram:
      'Instagram 內容傳遞網路（CDN）接收伺服器為確認媒體與交付 Range 內容而發出的 HTTPS 請求。',
    recipientBoundary:
      '因此，本服務不宣稱沒有第三方處理。Cloudflare 基礎設施的邊緣安全紀錄、備份與其各自保存政策不由此應用程式程式碼決定，應依其當時有效的政策與實際服務設定定期審閱。',
    retentionTitle: '應用程式邏輯保存期限',
    sessionLabel: '匿名工作階段',
    sessionRetention:
      'Cookie、工作階段雜湊與 CSRF 雜湊最長 12 小時；到期後由工作階段儲存的鬧鐘清除。',
    ipLabel: 'IP 限流',
    ipRetention:
      '解析事件使用 60 秒限流視窗，作用中的解析許可最長 30 秒。建立匿名工作階段時，帶有服務端金鑰的 IP 雜湊、核發額度事件及必要的不透明預約資料最長保留 12 小時；短效預約為 30 秒，無待處理資料後刪除該限流狀態。',
    turnstileLabel: 'Turnstile 防重放',
    turnstileRetention: '原始 token 只在驗證流程中處理；應用程式保存其防重放雜湊最長 5 分鐘。',
    candidateLabel: '解析候選',
    candidateRetention:
      '貼文短碼、候選安全中繼資料及密封授權最長 10 分鐘；期間可重新建立下載工作。單次核發的暫態預約為 30 秒，不會縮短候選的保留期限。',
    downloadLabel: '下載工作',
    downloadRetention:
      '須在核發後 10 分鐘內開始；開始後閒置期限為 10 分鐘，絕對最長存續 1 小時。完成後保留 90 秒以支援必要的瀏覽器請求；串流租約最長 15 分鐘，且不超過工作期限。',
    retentionBoundary:
      '上述期限是應用程式內的邏輯到期與刪除規則，不等同於對 Cloudflare 邊緣安全紀錄、基礎設施備份、使用者瀏覽器紀錄或第三方系統保存期限的保證。',
    securityTitle: '安全界線',
    security:
      '應用程式以雜湊值處理工作階段、CSRF token、IP 與 Turnstile token 等識別資料，並密封保存來源媒體網址；但版本中繼資料、Range 狀態與其他服務狀態不因此全部成為加密資料。本頁不作「所有資料皆加密」、「完全無紀錄」或「資料立即物理刪除」的聲明。',
    contactTitle: '隱私與資料處理聯絡',
    contact: '本服務營運者顯示名稱為 Pony。如對本服務的隱私或資料處理有疑問，可寄送電子郵件至：',
    contactLabel: '寄送隱私與資料處理詢問至 pony@pylot.dev',
    reviewTitle: '定期審閱提醒',
    review:
      '本頁不構成法律意見。營運者應依實際所在地、資料流、Cloudflare 的實際設定與當時有效的保存政策定期審閱本頁，並在相關條件變動時更新。',
  },
  copyright: {
    eyebrow: '法務／著作權',
    title: '著作權與下架通知',
    introduction: '公開於網路的內容仍可能受到著作權及其他權利保護。',
    rightsTitle: '權利界線',
    rights:
      '公開可見不表示內容可任意下載、重製、保存、分享或為其他利用。研究或非商業目的亦不當然構成授權或任何法域下的限制與例外。內容及相關權利仍歸原權利人所有，使用者須依實際用途確認其權利或適法依據。',
    statusBadge: '正式營運資訊',
    statusTitle: '營運者識別與申訴聯絡',
    statusContact: '本服務營運者顯示名稱為 Pony。權利人或其授權代表可將著作權或下架通知寄送至：',
    contactLabel: '寄送著作權或下架通知至 pony@pylot.dev',
    statusBoundary:
      '本頁不構成法律意見，也不聲稱任何特定法域的法定程序已適用。營運者應依實際所在地、服務情況與適用法律定期審閱本頁及通知處理流程。',
    noticeTitle: '通知應包含的資料',
    noticeIntro: '為利依可核實事實進行合理檢視，通知者宜提供：',
    noticeIdentity: '通知者姓名或組織名稱，以及可回覆的聯絡方式。',
    noticeWork: '主張權利的作品及可核對的原始來源。',
    noticeLocation: '涉及申訴的 Threads 網址、本站頁面或其他足以識別內容的資訊。',
    noticeBasis: '通知者的權利基礎，以及希望服務採取的措施。',
    noticeAccuracy: '足以確認通知內容正確性與授權身分的說明。',
    processTitle: '流程界線',
    process:
      '本頁目前只描述一般權利通知資訊，不聲稱適用任何特定國家或地區的通知與下架、安全港或反通知制度，也不捏造法定格式、處理期限、自動移除規則、責任認定、準據法或管轄。',
    affiliationTitle: '非官方隸屬',
    affiliation:
      '本服務並非 Meta、Instagram、Threads 或 SpaceX 的官方產品，亦未獲其背書、授權、委託或合作。',
  },
} as const;

type CatalogShape<T> = T extends (...arguments_: infer Arguments) => string
  ? (...arguments_: Arguments) => string
  : T extends string
    ? string
    : T extends object
      ? { readonly [Key in keyof T]: CatalogShape<T[Key]> }
      : never;

export type MessageCatalog = CatalogShape<typeof zhTW>;
