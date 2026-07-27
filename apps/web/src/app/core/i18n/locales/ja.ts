import { type ApiErrorCode } from '@threads-downloader/contracts';

import { type MessageCatalog } from './zh-TW.js';

export const ja = {
  locale: {
    code: 'ja',
    direction: 'ltr',
    name: '日本語',
  },
  metadata: {
    description:
      '同一オリジンのブラウザフローを通じて、公開Threads投稿の動画のバージョンを解析します。技術研究および学術研究向けに設計されています。',
  },
  routes: {
    home: 'Threads Downloader — 公開コンテンツ研究ツール',
    terms: '利用規約 | Threads Downloader',
    privacy: 'プライバシーとデータ処理 | Threads Downloader',
    copyright: '著作権および削除要請に関する通知 | Threads Downloader',
  },
  app: {
    brand: 'Threads Downloader',
    languageLabel: '言語を選択',
    skipLink: 'メインコンテンツへ移動',
    headerLabel: 'サイトヘッダー',
    homeLabel: 'Threads Downloaderのホーム',
    primaryNavigationLabel: 'メインナビゲーション',
    startDownload: 'ダウンロードを開始',
    disclaimer:
      '本サービスはThreadsの公式サービスではありません。利用者はコンテンツに関する権利を確認し、適用法およびプラットフォーム規約を遵守する必要があります。',
    legalNavigationLabel: '法的情報',
    terms: '利用規約',
    privacy: 'プライバシーとデータ処理',
    copyright: '著作権および削除要請',
  },
  downloader: {
    pageTitle: '公開Threads動画をダウンロード',
    heroCopy: '投稿URLを貼り付け、必要な確認を完了して、動画のバージョンを選択してください。',
    workflowLabel: '動画を取得',
    postUrlLabel: 'Threads投稿URL',
    postUrlPlaceholder: 'https://www.threads.com/@username/post/shortcode',
    postUrlHelp: 'threads.com と threads.net に対応しています',
    postUrlError: '有効な公開Threads投稿URLを入力してください。',
    rightsConfirmation: 'このコンテンツをダウンロードして使用する権利があることを確認します',
    rightsDetail:
      '自分がコンテンツの所有者であるか、有効な許可を得ているか、適用法に基づいて予定する利用が認められていることを確認します。学術目的または非商業目的であること自体は許可を与えるものではなく、法令およびプラットフォーム規約を遵守する責任が自分にあることを理解します。',
    rightsDetailLink: 'コンテンツ利用上の責任を確認',
    rightsError: '続行する前に、コンテンツを利用する権利を確認してください。',
    turnstileLabel: 'セキュリティ確認',
    verificationUnavailable:
      'セキュリティ確認を利用できません。再読み込みして、もう一度お試しください。',
    reloadVerification: 'セキュリティ確認を再読み込み',
    verificationRequired: 'まずセキュリティ確認を完了してください。',
    resolvingAction: '動画を取得しています…',
    resolveAction: '動画を取得',
    bootstrapStatus: '安全なセッションを確立しています…',
    resolveStatus: '公開投稿を解析しています…',
    requestReference: (requestId: string) => `参照番号：${requestId}`,
    retryBootstrap: '新しい安全なセッションを開始',
    candidateCount: (count: number) => `${count}件の動画のバージョンが見つかりました`,
    quality: '画質',
    duration: '再生時間',
    size: 'サイズ',
    candidateFallback: '動画の詳細は配信元によって異なります',
    preparingCandidate: '動画を準備しています…',
    preparingCandidateLabel: '動画を準備中',
    openOrDownload: '動画を開く／ダウンロード',
    candidateActionLabel: (action: string, index: number, filename: string) =>
      `${action}：バージョン${index}、${filename}`,
    handoffMessage:
      '動画をブラウザに引き渡しました。プレーヤーで開いた場合は、ブラウザの保存機能を使用してください。',
    resolveRequirements:
      '権利の確認内容、投稿URL、セキュリティ確認の状態を確認してから、もう一度お試しください。',
    candidateInvalid: 'この動画のバージョンは無効です。投稿をもう一度解析してください。',
    invalidDownloadId: 'ダウンロード識別子が正しくありません。',
    genericError: 'サービスを一時的に利用できません。後でもう一度お試しください。',
  },
  apiErrors: {
    HOST_NOT_ALLOWED: 'このウェブサイトからは本サービスを利用できません。',
    SESSION_INVALID: 'セッションが無効です。新しい安全なセッションを開始してください。',
    SESSION_EXPIRED: 'セッションの有効期限が切れました。新しい安全なセッションを開始してください。',
    SESSION_UNAVAILABLE: 'セッションを一時的に利用できません。後でもう一度お試しください。',
    REQUEST_INVALID: 'リクエストの形式が正しくありません。',
    REQUEST_TOO_LARGE: 'リクエストがサイズ上限を超えています。',
    URL_INVALID: '有効なThreads投稿URLを入力してください。',
    RATE_LIMITED: 'リクエストが多すぎます。後でもう一度お試しください。',
    TURNSTILE_INVALID: '確認に失敗しました。確認をやり直して、もう一度お試しください。',
    TURNSTILE_UNAVAILABLE: '確認サービスを一時的に利用できません。',
    THREADS_LOGIN_REQUIRED: 'この投稿を表示するにはThreadsへのログインが必要です。',
    THREADS_ACCESS_DENIED: 'Threadsから、この投稿へのアクセスが拒否されました。',
    THREADS_RATE_LIMITED: 'Threadsが一時的にアクセスを制限しています。後でもう一度お試しください。',
    THREADS_BOT_BLOCKED: 'Threadsにより、自動アクセスが一時的にブロックされています。',
    THREADS_JAVASCRIPT_REQUIRED: '現在、この投稿を読み込むにはJavaScriptが必要です。',
    MEDIA_NOT_FOUND: '対応している動画のバージョンが見つかりませんでした。',
    RESOLVE_UNAVAILABLE: '現在、この投稿を解析できません。後でもう一度お試しください。',
    DOWNLOAD_EXPIRED:
      'ダウンロードセッションの有効期限が切れました。新しいダウンロードを開始してください。',
    DOWNLOAD_CONCURRENT_LIMIT: '同時ダウンロード数の上限に達しました。後でもう一度お試しください。',
    DOWNLOAD_RANGE_UNAVAILABLE: '指定されたバイト範囲は利用できません。',
    DOWNLOAD_UPSTREAM_UNAVAILABLE:
      'ダウンロード元を一時的に利用できません。後でもう一度お試しください。',
    DOWNLOAD_UNAVAILABLE: 'ダウンロードを一時的に利用できません。後でもう一度お試しください。',
    NOT_FOUND: '指定されたAPIパスが見つかりません。',
    INTERNAL_ERROR: 'サーバーは現在リクエストを処理できません。',
  } satisfies Readonly<Record<ApiErrorCode, string>>,
  legalModal: {
    eyebrow: '法的情報',
    close: '閉じる',
    loading: '法的情報を読み込んでいます。',
    error: '法的情報を一時的に読み込めません。後でもう一度お試しください。',
    retry: '再読み込み',
  },
  researchPurpose: {
    title: '研究目的と法的境界',
    purpose:
      '本サービスは、技術研究および学術研究のみを目的として提供されています。運営者は、本サービスの提供によって商業的または経済的利益を得ることを目的としていません。',
    boundary:
      '上記の目的および非商業的であるとの説明は、運営者または利用者がコンテンツの許可を得ていることを意味しません。また、特定のダウンロード、保存、その他の利用が合法であること、または著作権の制限や例外に該当することを示すものではなく、適用法上の責任を免除するものでもありません。',
    authorization:
      '一般公開されていること、または研究目的もしくは非商業目的であることは、許可を与えるものではありません。利用者は、コンテンツを所有しているか、有効な許可を得ているか、実際に適用される法律に基づき、予定している利用が認められている必要があります。',
    access:
      '本サービスは、一般の利用者がログインせずにアクセスできるThreads投稿のみを処理します。非公開、ログインが必要、または制限されたコンテンツは処理せず、ログイン要件、技術的措置、その他のアクセス制限を回避しません。',
  },
  terms: {
    eyebrow: '法的情報／利用規約',
    title: '利用規約',
    introduction: '本サービスを利用する前に、技術的範囲、権利要件、法的境界を確認してください。',
    scopeTitle: 'サービス範囲',
    scopePublic:
      '本サービスは、対応ドメイン上でログインせずにアクセスできる公開Threads投稿URLのみを受け付けます。',
    scopeCredentials:
      '本サービスは、ThreadsまたはInstagramのCookie、アカウント認証情報、ログイントークンを受け付けません。非公開または制限されたコンテンツや、技術的措置の回避が必要なコンテンツの処理に使用してはなりません。',
    scopeDelivery:
      '本サービスは公開投稿の動画のバージョンを解析し、同一オリジン経由でダウンロードをブラウザに引き渡します。配信元の可用性、コンテンツの完全性、ブラウザによる最終的な保存結果は、配信元や利用環境の影響を受ける場合があります。',
    rightsTitle: '利用者の責任と権利',
    rightsBasis:
      '送信前に、利用者はコンテンツを所有しているか、有効な許可を得ているか、適用法に基づいて予定する利用が認められていることを確認する必要があります。',
    rightsOwnership:
      'コンテンツおよび関連する著作権、商標権、その他の権利は、それぞれの権利者に帰属します。本サービスは、第三者のコンテンツに関するいかなる権利も付与しません。',
    rightsUse:
      '利用者は、実際の利用方法に応じて、ダウンロードしたコンテンツを保存、編集、複製、再公開、共有、その他の方法で利用するための権利および法的根拠を確認する責任を負います。',
    rightsAbuse:
      '本サービスを利用して他者の権利を侵害したり、サービスのセキュリティを妨害したり、配信元プラットフォームのアクセス制御を回避したりしてはなりません。',
    affiliationTitle: '第三者との非提携に関する声明',
    affiliation:
      '本サービスは、Meta、Instagram、Threads、SpaceXの公式製品ではなく、これらの組織から推奨、承認、委託を受けておらず、提携関係にもありません。第三者のコンテンツおよび標章に関する権利は、それぞれの権利者に帰属します。',
    reviewTitle: '運営者と定期的な見直し',
    review:
      '本サービス運営者の表示名はPonyです。本ページは法的助言を構成せず、特定のダウンロードが合法かどうかを判断するものではありません。運営者は、実際の所在地、データフロー、サービス状況、適用法に照らして本規約を定期的に見直し、運営条件または法律が変更された場合に更新する必要があります。',
  },
  privacy: {
    eyebrow: '法的情報／プライバシー',
    title: 'プライバシーおよびデータ処理に関する通知',
    introduction:
      '本ページでは、現在のサービスが処理するデータ、処理目的、受領者、アプリケーション上の論理的な保存期間を説明します。',
    dataTitle: '処理するデータ',
    dataPost:
      '利用者が送信した公開Threads投稿URLと権利確認、解析された投稿ショートコード、バージョンのファイル名、寸法、再生時間、関連するセキュリティメタデータを処理します。',
    dataCookie:
      '本サービスは、HttpOnly、Secure、SameSite=Lax、Path=/属性を持つ匿名の__Host-td_session Cookieを設定します。サーバーは、セッションおよびCSRFトークンのハッシュ値と有効期限も処理します。',
    dataIp:
      '接続元IPアドレスは、リクエスト処理中のセキュリティ確認に使用されます。そのアドレスから生成されたサーバー側の鍵付きハッシュは、短期間のレート制限に使用されます。本通知は、本サービスがIPアドレスを一切処理しないと主張するものではありません。',
    dataTurnstile:
      'Cloudflare Turnstileの確認トークン、短期間のリプレイ防止ハッシュ、確認時刻、セキュリティリクエスト識別情報を処理します。',
    dataDownload:
      'ダウンロードジョブに必要な不透明な識別子、封印された形式で保存される配信元メディアURL、ファイルのセキュリティメタデータ、バイト範囲、ジョブ状態、一時的な実行リース、タイムスタンプを処理します。',
    purposeTitle: '処理目的',
    purpose:
      'これらのデータは、匿名セッションの確立、同一オリジンリクエストの確認、公開投稿の解析、ブラウザへのダウンロード引き渡し、再開可能な転送のサポート、リプレイ、悪用、過剰な同時実行の防止に使用されます。本サービスは、ThreadsまたはInstagramのログインCookie、アカウントパスワード、アクセストークンを利用者に要求せず、そのようなログイン認証情報を配信元サービスに渡しません。',
    recipientTitle: 'データの受領者と外部サービス',
    recipientCloudflare:
      'Cloudflare WorkersおよびDurable Objectsは、サイトのリクエスト、短期的に保持される状態、ストリーミング転送を処理します。Cloudflare Turnstileは、確認トークン、接続元IPアドレス、確認に必要なブラウザおよびリクエストデータを受け取ります。',
    recipientThreads:
      'Threadsは、利用者が送信した公開投稿を読み取るためにサーバーが送るHTTPSリクエストを受け取ります。',
    recipientInstagram:
      'Instagramのコンテンツ配信ネットワーク（CDN）は、メディアを確認して指定されたバイト範囲のコンテンツを配信するためにサーバーが送るHTTPSリクエストを受け取ります。',
    recipientBoundary:
      'したがって、本サービスは第三者がデータを処理していないとは主張しません。Cloudflareのエッジセキュリティログ、インフラストラクチャのバックアップ、その他のインフラストラクチャ記録の保存は、このアプリケーションコードによって決定されるものではなく、その時点で有効なポリシーと実際のサービス設定に照らして定期的に見直す必要があります。',
    retentionTitle: 'アプリケーション上の論理的保存',
    sessionLabel: '匿名セッション',
    sessionRetention:
      'Cookie、セッションハッシュ、CSRFハッシュは最大12時間保存されます。有効期限後、セッションストアの予約されたアラーム処理によって削除されます。',
    ipLabel: 'IPレート制限',
    ipRetention:
      '解析イベントには60秒のレート制限ウィンドウが適用され、有効な解析許可は最大30秒間続きます。匿名セッションを確立する際、サーバー側の鍵付きIPハッシュ、クォータ発行イベント、必要な不透明な予約データは最大12時間保存されます。短期予約は30秒間続き、保留中のデータがなくなるとレート制限状態が削除されます。',
    turnstileLabel: 'Turnstileリプレイ防止',
    turnstileRetention:
      '元のトークンは確認処理中にのみ処理されます。アプリケーションはリプレイ防止ハッシュを最大5分間保存します。',
    candidateLabel: '解析候補',
    candidateRetention:
      '投稿ショートコード、候補のセキュリティメタデータ、封印された形式で保存される認可情報は最大10分間保存され、その間はダウンロードジョブを再作成できます。各一時予約は30秒間続きますが、候補の保存期間は短縮されません。',
    downloadLabel: 'ダウンロードジョブ',
    downloadRetention:
      'ジョブは発行後10分以内に開始する必要があります。開始後のアイドル有効期限は10分、開始後の最長存続時間は1時間です。完了したジョブは、必要なブラウザリクエストに対応するため90秒間保存されます。ストリーミング実行リースは最大15分間続き、ジョブの存続時間を超えることはできません。',
    retentionBoundary:
      '上記の期間は、アプリケーションレベルの論理的な有効期限および削除規則です。Cloudflareのエッジセキュリティログ、インフラストラクチャのバックアップ、利用者のブラウザ記録、第三者システムの保存期間を保証するものではありません。',
    securityTitle: 'セキュリティ上の境界',
    security:
      'アプリケーションは、セッション、CSRFトークン、IP、Turnstileトークンなどの識別情報をハッシュとして処理し、配信元メディアURLを封印された形式で保存します。ただし、すべてのバージョンメタデータ、バイト範囲状態、その他のサービス状態が暗号化されるわけではありません。本通知は、すべてのデータが暗号化されていること、記録が一切保存されないこと、データが直ちに物理的に削除されることを主張するものではありません。',
    contactTitle: 'プライバシーおよびデータ処理に関する連絡先',
    contact:
      '運営者の表示名はPonyです。本サービスのプライバシーまたはデータ処理に関するお問い合わせは、次のメールアドレスまでお送りください。',
    contactLabel: 'pony@pylot.devにプライバシーおよびデータ処理に関する問い合わせを送信',
    reviewTitle: '定期的な見直しについて',
    review:
      '本ページは法的助言を構成しません。運営者は、実際の所在地、データフロー、Cloudflareの設定、その時点で有効な保存ポリシーに照らして本ページを定期的に見直し、関連条件が変更された場合に更新する必要があります。',
  },
  copyright: {
    eyebrow: '法的情報／著作権',
    title: '著作権および削除要請に関する通知',
    introduction:
      'インターネット上に公開されたコンテンツも、著作権やその他の権利で保護される場合があります。',
    rightsTitle: '権利の境界',
    rights:
      'コンテンツを一般公開で閲覧できることは、制限なくダウンロード、複製、保存、共有、その他の利用ができることを意味しません。研究目的または非商業目的であること自体は許可を与えるものではなく、いかなる法域においても著作権の制限または例外に当然に該当するものではありません。コンテンツおよび関連する権利は各権利者に帰属し、利用者は実際の利用方法に応じて権利または適法な根拠を確認する必要があります。',
    statusBadge: '現在のサービス運営情報',
    statusTitle: '運営者情報と通知先',
    statusContact:
      '運営者の表示名はPonyです。権利者または正当に権限を付与された代理人は、著作権または削除要請を次のメールアドレスに送ることができます。',
    contactLabel: 'pony@pylot.devに著作権または削除要請を送信',
    statusBoundary:
      '本ページは法的助言を構成せず、特定の法域の法定手続が適用されると主張するものでもありません。運営者は、実際の所在地、サービス状況、適用法に照らして本ページおよび通知処理手続を定期的に見直す必要があります。',
    noticeTitle: '通知に含める情報',
    noticeIntro:
      '検証可能な事実に基づく合理的な確認のため、通知には次の情報を含めることが推奨されます。',
    noticeIdentity: '通知を送る個人または組織の名称と、返信可能な連絡先。',
    noticeWork: '権利を主張する著作物と、確認可能な原典。',
    noticeLocation:
      '対象となるThreads URL、本サイトのページ、その他コンテンツを特定するために十分な情報。',
    noticeBasis: '主張する権利の根拠と、本サービスに求める対応。',
    noticeAccuracy: '通知内容の正確性および送信者の権限を確認するために十分な説明。',
    processTitle: '手続の境界',
    process:
      '本ページは一般的な権利通知の情報のみを説明します。特定の国または地域の通知・削除、セーフハーバー、異議申立通知の制度が適用されると主張するものではなく、法定の形式、処理期限、自動削除の規則、責任の判断基準、準拠法、管轄が存在するかのように示すものでもありません。',
    affiliationTitle: '公式な提携関係なし',
    affiliation:
      '本サービスは、Meta、Instagram、Threads、SpaceXの公式製品ではなく、これらの組織による推奨、承認、委託、提携の下で運営されていません。',
  },
} as const satisfies MessageCatalog;
