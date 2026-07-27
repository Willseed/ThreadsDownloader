import { type ApiErrorCode } from '@threads-downloader/contracts';

import { type MessageCatalog } from './zh-TW.js';

export const en = {
  locale: {
    code: 'en',
    direction: 'ltr',
    name: 'English',
  },
  metadata: {
    description:
      'Resolve video versions from public Threads posts through a secure, same-origin browser flow. Designed for technical and academic research.',
  },
  routes: {
    home: 'Threads Downloader — Public Media Research Utility',
    terms: 'Terms of Use | Threads Downloader',
    privacy: 'Privacy and Data Processing | Threads Downloader',
    copyright: 'Copyright and Takedown Notice | Threads Downloader',
  },
  app: {
    brand: 'Threads Downloader',
    languageLabel: 'Select language',
    skipLink: 'Skip to main content',
    headerLabel: 'Site header',
    homeLabel: 'Threads Downloader home',
    primaryNavigationLabel: 'Primary navigation',
    startDownload: 'Start download',
    disclaimer:
      'This is not an official Threads service. Users must confirm their content rights and comply with applicable law and platform terms.',
    legalNavigationLabel: 'Legal information',
    terms: 'Terms of Use',
    privacy: 'Privacy and Data Processing',
    copyright: 'Copyright and Takedown Notice',
  },
  downloader: {
    pageTitle: 'Download public Threads videos',
    heroCopy: 'Paste a post URL, complete verification, and choose a video version.',
    workflowLabel: 'Get video',
    postUrlLabel: 'Threads post URL',
    postUrlPlaceholder: 'https://www.threads.com/@username/post/shortcode',
    postUrlHelp: 'Supports threads.com and threads.net',
    postUrlError: 'Enter a valid public Threads post URL.',
    rightsConfirmation: 'I confirm that I have the right to download and use this content',
    rightsDetail:
      'I confirm that I own the content, have permission, or may save it under applicable law. I understand that an academic or non-commercial purpose does not itself grant permission, and I am responsible for complying with the law and platform terms.',
    rightsDetailLink: 'Review content-use responsibilities',
    rightsError: 'Confirm your right to use the content before continuing.',
    turnstileLabel: 'Security verification',
    verificationUnavailable: 'The security check is unavailable. Reload it and try again.',
    reloadVerification: 'Reload security check',
    verificationRequired: 'Complete the security check first.',
    resolvingAction: 'Getting video…',
    resolveAction: 'Get video',
    bootstrapStatus: 'Establishing a secure session…',
    resolveStatus: 'Resolving the public post…',
    requestReference: (requestId: string) => `Reference: ${requestId}`,
    retryBootstrap: 'Start a new secure session',
    candidateCount: (count: number) =>
      `${count} video ${count === 1 ? 'version' : 'versions'} found`,
    quality: 'Quality',
    duration: 'Duration',
    size: 'Size',
    candidateFallback: 'Video details depend on the source',
    preparingCandidate: 'Preparing video…',
    preparingCandidateLabel: 'Preparing video',
    openOrDownload: 'Open or download video',
    candidateActionLabel: (action: string, index: number, filename: string) =>
      `${action}, version ${index}: ${filename}`,
    handoffMessage:
      "The video has been handed off to your browser. If it opens in a player, use your browser's save option.",
    resolveRequirements:
      'Check the rights confirmation, URL, and verification status, then try again.',
    candidateInvalid: 'The video version is invalid. Resolve the post again.',
    invalidDownloadId: 'The download identifier is not valid.',
    genericError: 'The service is temporarily unavailable. Try again later.',
  },
  apiErrors: {
    HOST_NOT_ALLOWED: 'This website is not allowed to use the service.',
    SESSION_INVALID: 'The session is invalid. Start a new secure session.',
    SESSION_EXPIRED: 'The session has expired. Start a new secure session.',
    SESSION_UNAVAILABLE: 'The session is temporarily unavailable. Try again later.',
    REQUEST_INVALID: 'The request format is not valid.',
    REQUEST_TOO_LARGE: 'The request exceeds the size limit.',
    URL_INVALID: 'Enter a valid Threads post URL.',
    RATE_LIMITED: 'Too many requests. Try again later.',
    TURNSTILE_INVALID: 'Verification failed. Complete verification again and retry.',
    TURNSTILE_UNAVAILABLE: 'The verification service is temporarily unavailable.',
    THREADS_LOGIN_REQUIRED: 'This post requires signing in to Threads.',
    THREADS_ACCESS_DENIED: 'Threads denied access to this post.',
    THREADS_RATE_LIMITED: 'Threads is temporarily limiting access. Try again later.',
    THREADS_BOT_BLOCKED: 'Threads is temporarily blocking automated access.',
    THREADS_JAVASCRIPT_REQUIRED: 'This post currently requires JavaScript to load.',
    MEDIA_NOT_FOUND: 'No supported video version was found.',
    RESOLVE_UNAVAILABLE: 'This post cannot be resolved right now. Try again later.',
    DOWNLOAD_EXPIRED: 'The download session has expired. Start a new download.',
    DOWNLOAD_CONCURRENT_LIMIT: 'The concurrent download limit has been reached. Try again later.',
    DOWNLOAD_RANGE_UNAVAILABLE: 'The requested download range is unavailable.',
    DOWNLOAD_UPSTREAM_UNAVAILABLE:
      'The download source is temporarily unavailable. Try again later.',
    DOWNLOAD_UNAVAILABLE: 'The download is temporarily unavailable. Try again later.',
    NOT_FOUND: 'The requested API route was not found.',
    INTERNAL_ERROR: 'The server is temporarily unable to process the request.',
  } satisfies Readonly<Record<ApiErrorCode, string>>,
  legalModal: {
    eyebrow: 'LEGAL / ON DEMAND',
    close: 'Close',
    loading: 'Loading legal information.',
    error: 'Legal information is temporarily unavailable. Try again later.',
    retry: 'Reload',
  },
  researchPurpose: {
    title: 'Research Purpose and Legal Boundaries',
    purpose:
      'This service is provided solely for technical and academic research. The operator does not seek commercial or economic benefit from providing it.',
    boundary:
      'That purpose and non-commercial statement do not mean that the operator or user has obtained permission for any content. They do not establish that any particular download, storage, or other use is lawful or qualifies for a copyright limitation or exception, and they do not relieve anyone of responsibilities under applicable law.',
    authorization:
      'Public visibility and a research or non-commercial purpose do not grant permission. Users must own the content, have valid permission, or be legally permitted under the law that actually applies to make the intended use.',
    access:
      'This service processes only Threads posts that the general public can access without signing in. It does not process private, sign-in-only, or restricted content, and it does not bypass sign-in, technical measures, or other access restrictions.',
  },
  terms: {
    eyebrow: 'LEGAL / TERMS',
    title: 'Terms of Use',
    introduction:
      'Before using this service, review its technical scope, rights requirements, and legal boundaries.',
    scopeTitle: 'Service scope',
    scopePublic:
      'This service accepts only public Threads post URLs on supported domains that are accessible without signing in.',
    scopeCredentials:
      'This service does not accept Threads or Instagram cookies, account credentials, or sign-in tokens. It must not be used to process private or restricted content or content that requires bypassing technical measures.',
    scopeDelivery:
      'This service resolves video versions from public posts and delivers downloads through the same origin. Source availability, content completeness, and whether the browser ultimately saves the file may still depend on the source and the user environment.',
    rightsTitle: 'User responsibilities and rights',
    rightsBasis:
      'Before submitting, users must confirm that they own the content, have valid permission, or may make the intended use under applicable law.',
    rightsOwnership:
      'The content and related copyrights, trademarks, and other rights remain with their respective rightsholders. This service grants no rights in third-party content.',
    rightsUse:
      'Users are responsible for establishing their rights and legal basis for storing, editing, copying, republishing, sharing, or otherwise using downloaded content in light of their actual use.',
    rightsAbuse:
      "Do not use this service to infringe others' rights, interfere with service security, or evade the source platform's access controls.",
    affiliationTitle: 'Third parties and non-affiliation',
    affiliation:
      'This service is not an official product of Meta, Instagram, Threads, or SpaceX and is not endorsed, authorized, commissioned, or operated in partnership with them. Rights in third-party content and marks remain with their respective owners.',
    reviewTitle: 'Operator and periodic review',
    review:
      "The operator's display name is Pony. This page is not legal advice and does not decide whether a specific download is lawful. The operator should periodically review these terms against the actual location, data flows, service conditions, and applicable law, and update them when operating conditions or law change.",
  },
  privacy: {
    eyebrow: 'LEGAL / PRIVACY',
    title: 'Privacy and Data Processing Notice',
    introduction:
      'This page describes the data processed by the current service, the purposes of processing, the recipients involved, and the application-level logical retention periods.',
    dataTitle: 'Data processed',
    dataPost:
      'The public Threads post URL and rights confirmation submitted by the user, plus the resolved post shortcode, version filename, dimensions, duration, and associated security metadata.',
    dataCookie:
      'This service sets an anonymous __Host-td_session cookie with HttpOnly, Secure, SameSite=Lax, and site-root path attributes. The server also processes hashes and expiry times for the session and CSRF token.',
    dataIp:
      'The connection IP is used for security verification while a request is processed. A keyed hash derived from it is used for short-term rate limiting. This notice does not claim that the service never processes IP addresses.',
    dataTurnstile:
      'The Cloudflare Turnstile verification token, its short-lived anti-replay hash, verification time, and security request identifiers.',
    dataDownload:
      'Opaque identifiers required for download jobs, sealed source media URLs, file security metadata, byte ranges, job status, leases, and timestamps.',
    purposeTitle: 'Purposes of processing',
    purpose:
      'This data is used to establish anonymous sessions, verify same-origin requests, resolve public posts, deliver downloads to the browser, support resumable transfers, and prevent replay, abuse, and excess concurrency. The service does not ask users for Threads or Instagram sign-in cookies, account passwords, or access tokens, and it does not pass such sign-in credentials to source services.',
    recipientTitle: 'Data recipients and external services',
    recipientCloudflare:
      'Cloudflare Workers and Durable Objects process site requests, short-lived state, and streaming transfers. Cloudflare Turnstile receives the verification token, connection IP, and browser and request data required for verification.',
    recipientThreads:
      'Threads receives HTTPS requests sent by the server to read the public post submitted by the user.',
    recipientInstagram:
      'The Instagram content delivery network (CDN) receives HTTPS requests sent by the server to verify media and deliver byte-range content.',
    recipientBoundary:
      'Accordingly, this service does not claim that no third party processes data. Retention for Cloudflare edge security logs, infrastructure backups, and other infrastructure records is not determined by this application code and should be reviewed periodically against the policies and service settings then in effect.',
    retentionTitle: 'Application-level logical retention',
    sessionLabel: 'Anonymous session',
    sessionRetention:
      "The cookie, session hash, and CSRF hash are retained for no more than 12 hours. After expiry, the session store's scheduled alarm removes them.",
    ipLabel: 'IP rate limiting',
    ipRetention:
      'Resolve events use a 60-second rate-limit window, and active resolve permits last no more than 30 seconds. When an anonymous session is established, the server-keyed IP hash, quota issuance events, and necessary opaque reservation data are retained for no more than 12 hours. Short-lived reservations last 30 seconds, and the rate-limit state is deleted once no pending data remains.',
    turnstileLabel: 'Turnstile replay prevention',
    turnstileRetention:
      'The raw token is processed only during verification. The application retains its anti-replay hash for no more than 5 minutes.',
    candidateLabel: 'Resolved candidates',
    candidateRetention:
      'The post shortcode, candidate security metadata, and sealed authorization are retained for no more than 10 minutes, during which a download job can be created again. Each temporary reservation lasts 30 seconds and does not shorten candidate retention.',
    downloadLabel: 'Download jobs',
    downloadRetention:
      'A job must start within 10 minutes of issuance. After it starts, the idle expiry is 10 minutes and the absolute lifetime is no more than 1 hour. Completed jobs remain for 90 seconds to support necessary browser requests. A streaming lease lasts no more than 15 minutes and cannot exceed the job lifetime.',
    retentionBoundary:
      'These periods are application-level logical expiry and deletion rules. They do not guarantee retention periods for Cloudflare edge security logs, infrastructure backups, user browser records, or third-party systems.',
    securityTitle: 'Security boundaries',
    security:
      'The application processes identifiers such as the session, CSRF token, IP, and Turnstile token as hashes and stores source media URLs in sealed form. This does not make all version metadata, byte-range state, or other service state encrypted. This notice does not claim that all data is encrypted, that no records are kept, or that data is physically deleted immediately.',
    contactTitle: 'Privacy and data processing contact',
    contact:
      "The operator's display name is Pony. For questions about this service's privacy or data processing, email:",
    contactLabel: 'Email privacy and data processing questions to pony@pylot.dev',
    reviewTitle: 'Periodic review reminder',
    review:
      'This page is not legal advice. The operator should periodically review it against the actual location, data flows, Cloudflare settings, and retention policies then in effect, and update it when those conditions change.',
  },
  copyright: {
    eyebrow: 'LEGAL / COPYRIGHT',
    title: 'Copyright and Takedown Notice',
    introduction:
      'Content published openly on the internet may still be protected by copyright and other rights.',
    rightsTitle: 'Rights boundaries',
    rights:
      'Public visibility does not mean that content may be downloaded, copied, stored, shared, or otherwise used without restriction. A research or non-commercial purpose does not itself grant permission or necessarily qualify for a copyright limitation or exception in any jurisdiction. Content and related rights remain with their respective rightsholders, and users must establish their rights or lawful basis in light of their actual use.',
    statusBadge: 'Production service information',
    statusTitle: 'Operator identity and notice contact',
    statusContact:
      "The operator's display name is Pony. A rightsholder or authorized representative may send a copyright or takedown notice to:",
    contactLabel: 'Email a copyright or takedown notice to pony@pylot.dev',
    statusBoundary:
      'This page is not legal advice and does not claim that a statutory process in any particular jurisdiction applies. The operator should periodically review this page and the notice-handling process against the actual location, service conditions, and applicable law.',
    noticeTitle: 'Information to include in a notice',
    noticeIntro:
      'To support a reasonable review based on verifiable facts, a notice should include:',
    noticeIdentity:
      'The name of the person or organization sending the notice and contact information for a reply.',
    noticeWork: 'The work in which rights are claimed and an original source that can be checked.',
    noticeLocation:
      'The relevant Threads URL, site page, or other information sufficient to identify the content at issue.',
    noticeBasis: 'The basis for the claimed rights and the action requested from this service.',
    noticeAccuracy:
      "A statement sufficient to confirm the notice's accuracy and the sender's authority.",
    processTitle: 'Process boundaries',
    process:
      'This page describes only general rights-notice information. It does not claim that any specific national or regional notice-and-takedown, safe-harbor, or counter-notice regime applies, and it does not invent statutory formats, processing deadlines, automatic removal rules, liability determinations, governing law, or jurisdiction.',
    affiliationTitle: 'No official affiliation',
    affiliation:
      'This service is not an official product of Meta, Instagram, Threads, or SpaceX and is not endorsed, authorized, commissioned, or operated in partnership with them.',
  },
} as const satisfies MessageCatalog;
