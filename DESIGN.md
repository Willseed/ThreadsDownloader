# Threads Downloader Design Record

## Purpose and boundaries

This document records the intended Worker, Durable Object, and Angular design.
It is a decision record, not an API contract for an upstream Threads service.
No undocumented upstream field, event, sequence, subscription result, or market
state is assumed by this design.

The service resolves an allowed public download target and hands a browser a
short-lived, same-origin download capability. The frontend application and API
JSON never receive a CDN URL, and the service never logs one. Download content
normally streams statelessly through the Worker. If the Worker cannot establish
the outbound media fetch, the capability may return a temporary redirect whose
`Location` exposes the exact vaulted CDN URL to the browser; durable state
remains limited to authorization, transfer accounting, and lifecycle control.

## Architecture vocabulary

### Deep modules

A deep module presents a small interface while owning substantial policy,
state, and operational complexity. Its callers should not duplicate its
invariants. A shallow module merely moves arguments around and is avoided.

An interface is the stable set of inputs, outputs, errors, and guarantees a
consumer can depend on. A seam is the intentional boundary at which a module
can be independently tested or replaced. An adapter translates an external
protocol into a local interface, containing vendor-specific behavior.

| Module | Interface / responsibility | Seam |
| --- | --- | --- |
| `WorkerApplication` | dispatch `fetch`, asset serving, request policy | Worker `fetch` event |
| `SessionWorkflow` | `bootstrap` then `authorize` a browser session | session and CSRF adapter |
| `ResolveWorkflow` | resolve approved input into an internal target | resolver adapter |
| `RenderedThreadsMediaResolver` | opt-in, bounded `/media` rendering into one untrusted candidate | Browser Run `scrape` port |
| `DownloadWorkflow` | `issue`, `head`, `stream`, and `status` | HTTP/range and origin adapter |
| Angular `DownloaderModel` | typed UI state, commands, errors | Angular service/model boundary |

`WorkerApplication` is deliberately thin: it chooses a workflow and injects
adapters. Policy remains in workflows. Each external service, including a
resolver, CDN, Turnstile, browser headers, and SQLite, is behind an adapter so
tests can supply reproducible fakes.

## Browser, session, and security behavior

The exact request host is guarded before any route, redirect, asset, or API
work. CORS is not enabled. Assets and APIs are same-origin only.

The server issues a signed `__Host-` cookie with Secure, Path=/, and no Domain
attribute. State-changing requests require that cookie, a CSRF token, and an
exact allowed `Origin`; missing, malformed, or mismatched values fail closed.
Turnstile verification is one-time: its replay identifier is stored and a
second use is rejected.

All user and upstream URLs pass explicit allowlists. Redirects are handled
manually, each hop is validated, and fetches use bounded timeouts and response
size limits. CDN targets are independently validated before streaming. No
redirect policy delegates validation to a browser or default fetch behavior.

The rendered fallback is a narrower exception at an external browser
adapter whose Quick Action response does not expose its navigation redirect
chain. Production binds exactly one `BROWSER` Browser Run binding after explicit
approval and a credential-free remote proof. The adapter restricts every
browser subrequest with anchored patterns, returns allowed canonically
deduplicated candidates in scrape/DOM order, and sends them through the central
CDN policy and ordinary media probe. A rendered candidate whose probe ends in
the exact transport-unavailable state is retained with explicitly unverified
metadata. The Wrangler exposure gate rejects a missing,
renamed, remote-development, non-object, or extended browser configuration.

Encrypted resolver credentials or tokens live only in a server vault using
AES-GCM. Keys and plaintext do not enter source, frontend bundles, logs, or
error messages. CDN URLs never enter Angular state, API JSON, or logs; the
download response may disclose one only as the transport-fallback `Location`.

Resolve failure telemetry is emitted when the public response is a 5xx, plus a
narrow diagnostic exception for `MEDIA_NOT_FOUND` at the `resolve` stage. Its
schema is the existing opaque `requestId`, one bounded workflow stage (`prepare`,
`admission`, or `resolve`), and one code from the internal closed error-code
union. When every candidate in an all-failed typed media-probe batch belongs to
one policy-validated CDN family, the event may also contain the closed
`candidateFamily` value `cdninstagram` or `instagram-fna`; mixed families and
every non-probe failure omit it. The serialized event is rebuilt from these
exact fields and bounded to 256 characters. It never includes request or
upstream URLs, hostnames, subdomains, shortcode, session or IP material,
headers, tokens, candidate data, exception messages, stacks, or cause objects.
Reporting is best-effort and cannot change the public response; other 4xx
outcomes and successful resolves emit no event.

## Durable Object lifecycle model

SQLite Durable Object exports are: `SessionCoordinator`, `IpRateLimiter`,
`TurnstileReplay`, and `DownloadSession`. These names describe fixed storage
records, not public HTTP resources. The initial lifecycle uses SQLite exports
and fixed storage; automatic rollback across lifecycle transitions is not
approved.

`DownloadSession` states are `ISSUED`, `ACTIVE`, `INTERRUPTED`,
`COMPLETE_PENDING`, and `EXPIRED`.

A resolved candidate batch and its sealed grant remain usable from their
server-issued timestamp up to, but not including, the ten-minute expiry. The
same candidate may issue multiple independent download sessions during that
window. A 30-second reservation only serializes one in-flight issuance;
`consume` is a non-destructive acknowledgement that releases the exact current
reservation. A late or repeated acknowledgement succeeds while the same
session-owned candidate still exists but never clears a newer reservation.
Missing, corrupt, undecryptable, or expired candidates remain unavailable.
This internal window does not extend an upstream CDN URL's own validity; an
earlier upstream expiry remains an honest origin failure.

| Limit or lease | Value | Meaning |
| --- | ---: | --- |
| Start deadline | 600 seconds | issued download must begin |
| Idle deadline | 600 seconds | active transfer may not go silent |
| Absolute lifetime | 3600 seconds | upper bound for a download session |
| Completion grace | 90 seconds | verify completion after final activity |
| Active lease | 900 seconds | ownership expires without renewal |
| Concurrent ranges | 4 | maximum active range leases |
| Stored intervals | 64 | maximum merged interval records |

Alarms enforce start, idle, lease, grace, and expiry checks. Expired sessions,
replay records, and obsolete rate-limit entries are deleted by lifecycle
cleanup. A lease is renewed only by its holder; stale holders cannot mutate
transfer state.

Completion requires all of the following: normal EOF, exact byte count, a full
union of received ranges, one consistent reliable validator, and no active
lease. Otherwise the state remains interrupted or expires; it is not complete.

## HTTP range and streaming policy

`DownloadWorkflow.issue` creates a same-origin capability after authorization.
`head` returns the stored metadata, `stream` first proxies a single allowed
range, and `status` returns only safe lifecycle information. It never persists
the content body and can resume after an isolate restart from validated state.

Only one byte range is accepted. Multi-range requests are rejected. Valid
single ranges produce correct `206`, `Content-Range`, `Content-Length`,
and `Accept-Ranges` behavior; invalid or unsatisfiable ranges fail safely.
`If-Range` is honored only when a reliable, consistent ETag or Last-Modified
validator matches. ETag and Last-Modified are captured from validated origin
metadata and prevent joining bytes from different representations.

Streaming is stateless with respect to bytes: the Worker pipes origin bytes to
the response while updating bounded accounting through the DO. It does not
buffer full files. Only when an origin fetch throws or reaches the existing
header timeout does delivery interrupt its acquired lease, release admission,
and return a no-store `307` to the exact policy-validated URL already held in
the encrypted session. Invalid status, redirect, content type, and transfer
metadata still fail without this fallback. The redirected browser may open its
media player instead of producing a download event because the final
cross-origin response is authoritative; the intermediate same-origin
`Content-Disposition` cannot guarantee attachment behavior.

## Angular application

The client is an Angular standalone application. `DownloaderModel` uses
signals for view state, typed reactive forms for input and validation, and
`OnPush` components. It calls only same-origin endpoints and consumes safe
status/errors rather than origin details.

The form exposes clear labels, validation summaries, keyboard operation,
visible focus, semantic status updates, and sufficient contrast to meet WCAG
expectations. The final handoff starts from a same-origin download anchor. On
transport fallback the browser, but not Angular state, follows the vaulted CDN
location and may display the media. Legal notices, acceptable-use text, and a
reporting path are part of handoff and error surfaces.

### Primary success-path interaction budget

From a ready page through browser download handoff, the application-controlled
happy path must require no more than ten high-level user actions. The MVP uses
five: fill the post URL, confirm content rights, complete Turnstile at a high
level, submit resolution, and choose a candidate for browser download. Page
loading, session bootstrap, and browser download-manager behavior are not user
actions.

The Turnstile completion counts as one high-level action even when the E2E fake
completes automatically. Interactions inside a real third-party challenge are
externally controlled and therefore cannot be guaranteed by this application.
The application must not add wizard pages or redundant confirmations to this
path; any necessary application-owned gate must preserve the ten-action limit
and update the semantic E2E action list.

## Test matrix

| Layer | Primary checks |
| --- | --- |
| Pure Vitest | parsers, URL policy, range arithmetic, validators, crypto helpers |
| Workflow tests | bootstrap/authorize, resolution, issue/head/stream/status errors |
| Workerd DO tests | SQLite transitions, leases, alarms, cleanup, interval union |
| Angular tests | signals, typed forms, OnPush rendering, accessible errors |
| Playwright | same-origin user flow, resume, expiry, legal handoff |
| axe | keyboard and automated accessibility checks |
| Security tests | host/Origin/CSRF/cookie, Turnstile replay, SSRF, redirects, limits |

Tests protect state transitions, data integrity, URL containment, and HTTP
contracts. They should not expand into coverage-only fixtures.

## Approved toolchain versions

| Tool | Exact version |
| --- | --- |
| Node | 24.18.0 |
| npm | 11.16.0 |
| Angular, CLI, build, compiler-cli | 22.0.8 |
| TypeScript | 6.0.3 |
| RxJS | 7.8.2 |
| Hono | 4.12.32 |
| Vitest | 4.1.10 |
| Cloudflare pool | 0.18.8 |
| Playwright | 1.61.1 |
| Wrangler | 4.114.0 |
| ESLint | 10.7.0 |
| angular-eslint | 22.1.0 |
| Prettier | 3.9.6 |
| Sonar scanner | 5.0.0 |

## Research record

An ask-bridge request did not return a complete result. Research stopped and
was not retried. Official npm, Angular, and Cloudflare sources were used for
recorded versions and platform facts. No Web Search was used. This record does
not establish any undocumented upstream Threads API semantics.

### Worker subrequest budget for public resolution (2026-07-25)

- Question: how many candidate probes can one public resolve safely issue on
  Cloudflare Workers Free while retaining capacity for redirects and internal
  bindings?
- Research order: ask-bridge was attempted first; the platform limits were then
  verified against Cloudflare's official
  [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
  and
  [2026-02-11 subrequest-limit changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/).
- Evidence: a Free invocation permits 50 external subrequests and 1,000
  internal subrequests; every redirect hop counts as another subrequest; at
  most six outgoing connections may wait on response headers simultaneously.
- Scope and decision: this applies to the Worker public resolve path. Probe only
  the first eight ordered candidates concurrently. The conservative worst case
  is one Turnstile request, four Threads requests including redirects, and five
  requests for each of eight media probes, totalling 45 external subrequests
  and retaining a five-request buffer. Redirect-converged final CDN URLs are
  deduplicated canonically before vault storage.
- Unconfirmed: whether an ASSETS binding request consumes the internal
  subrequest bucket remains unconfirmed and is not relied upon by this decision.

### SQLite Durable Object declarative exports (2026-07-25)

- Question: how should the initial `DownloadSession` SQLite Durable Object be
  declared in Wrangler 4.114.0 without introducing a legacy migration path?
- Research order and evidence: ask-bridge first completed the research with the
  required ChatGPT provider, high model, 1,500-second timeout, and headless
  execution. The result was then checked against Cloudflare's official
  [Durable Object migrations reference](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/),
  [Wrangler configuration reference](https://developers.cloudflare.com/workers/wrangler/configuration/),
  [declarative class exports changelog](https://developers.cloudflare.com/changelog/post/2026-06-30-declarative-do-class-exports/),
  and [legacy class migrations reference](https://developers.cloudflare.com/durable-objects/reference/durable-object-class-migrations-legacy/).
  The ask-bridge thread link is not recorded because it is sensitive and not
  needed to reproduce the decision. No Web Search was used.
- Evidence and decision: Wrangler 4.107.0 and later support declarative class
  exports. This repository uses Wrangler 4.114.0. An export declared as
  `{ type: "durable-object", storage: "sqlite" }` replaces the legacy migration
  declaration for the class and must not be combined with `migrations` in the
  same configuration. Production, development, and test configurations bind
  `DOWNLOAD_SESSIONS` to the `DownloadSession` SQLite export.
- Scope: on first deployment, the declaration provisions a persistent Durable
  Object namespace. A normal Worker version rollback cannot cross that lifecycle
  change. Removing the class requires an explicit `deleted` tombstone and is a
  destructive lifecycle operation; this task does not perform that operation.
- Unconfirmed: documentation consistency for `wrangler versions upload` remains
  unconfirmed and this implementation does not depend on that command. Real
  runtime secret presence and values are outside repository evidence; the
  current Wrangler configuration records only their required names, while tests
  inject controlled ephemeral values through Miniflare.

### Opt-in rendered Threads media fallback (2026-07-27)

- Question: can the resolver support a public Threads post whose initial HTML
  is only a JavaScript application shell, without accepting a client-supplied
  CDN URL or silently enabling a metered browser service?
- Research order and evidence: ask-bridge found no public contract that
  establishes Browser Run Quick Action `addScriptTag` ordering. CSP and timing
  are both possible explanations for a missing injected marker, but neither is
  confirmed. It also confirmed that the `scrape` response exposes no final URL.
  Bounded credential-free HTTP reproduction showed that both the canonical post
  and its `/media` route return HTML rather than media bytes or a CDN redirect.
  A browser observation found a playable `currentSrc` under the exact shape
  `instagram.<single-label>.fna.fbcdn.net`; this is observational evidence, not
  an official hostname contract. The installed Cloudflare types establish the
  `quickAction('scrape', ...)` input and response shape. No new Web Search was
  used for this implementation.
- Scope and decision: the server discards the input query while normalizing the
  post, appends `/media` itself, and never accepts a CDN URL from the client.
  Browser rendering is an optional injected port. It can run only after session
  and IP admission, CSRF validation, and one-time Turnstile success, and only
  after the cheaper markup resolver returns JavaScript-required, media-missing,
  response-invalid, response-too-large, upstream-unavailable, or the dedicated
  `THREADS_POST_REDIRECT_AMBIGUOUS` result. That dedicated result can arise only
  from the initial canonical request's first response with exact status 302 and
  a Location whose raw value and parsed URL are exactly
  `https://www.threads.com/?error=invalid_post`; any variant, later hop, or other
  redirect remains non-fallback. Upstream-unavailable covers a credential-free
  public Threads markup transport failure; login, access, bot, rate, all other
  redirects, and policy failures never use rendering as a bypass.
- Browser containment: the Quick Action has empty cookies, does not forward
  client headers or cookies or set an explicit referrer, uses zero cache TTL,
  and supplies a four-second provider navigation limit, an eight-second action
  limit, a fixed five-second hydration delay, and anchored request patterns for
  exact `www.threads.com`, the existing `cdninstagram.com` family, and the observed
  exact Instagram FNA hostname shape. The request deliberately omits
  `waitForSelector`: fresh provider evidence showed that the field returned before
  its requested deadline and before delayed carousel videos hydrated. The
  provider-side browser budget is twelve seconds, followed by a separate
  two-second absolute response-read budget.
  Its streamed JSON response, selectors, element records, attributes, values,
  and candidate count are all bounded and decoded exactly. Exactly one
  `link[rel="canonical"]` `href` and exactly one `meta[property="og:url"]`
  `content` must agree. Both normally equal the normalized canonical post; the
  only alternate identity is the literal
  `https://www.threads.com/@/post/<same-shortcode>` username-redacted form for
  both fields. Scheme, host, port, query, fragment, path, shortcode case, and
  percent-encoding remain exact, fail-closed comparisons. Candidates come only
  from full-page `video[src]` and
  `video source[src]`; zero canonically deduplicated CDN candidates is not found
  and every allowed unique candidate is retained in scrape/DOM order. A URL
  repeated across `video` and `source` is represented once at its first
  occurrence. The workflow applies its existing eight-candidate probe bound and
  retains later successful probes when an earlier candidate fails. These
  upstream-authored DOM identity declarations are not described as proof of the
  browser's final location.
- Downstream enforcement: the observed FNA hostname shape was added to the one
  central CDN parser without allowing the `fbcdn.net` apex, broad subdomains,
  extra labels, non-default ports, credentials, fragments, or lookalikes.
  Rendered candidates still attempt the existing HEAD/range media probe. Exact
  probe transport unavailability stores a strict unverified descriptor in the
  encrypted vault; other probe failures remain blocking. Download delivery then
  attempts the same-origin proxy before its transport-only browser redirect.
- Media probe transport evidence: after the rendered-video timing fix, a fresh
  production resolve reached the probe and returned the typed
  `MEDIA_PROBE_UNAVAILABLE` code, while a direct remote proof against the same
  public candidate completed HEAD successfully. No sensitive request or media
  identifier was retained. This establishes only a transient Worker fetch
  transport failure, not a CDN contract. The probe therefore makes one bounded
  `Range: bytes=0-0` attempt against the original revalidated candidate only
  when the initial HEAD throws that exact typed unavailable error. It reuses the
  same eight-second AbortSignal and existing request, redirect, CDN, identity
  encoding, status, and metadata policies; abort, policy, status, and metadata
  failures do not trigger another probe path. If both attempts end in exact
  transport unavailability for a rendered candidate, the URL is retained as
  `unverified` with assumed `video/mp4`, null length and validators, unknown
  range support, and unreliable completion metadata. None of those assumptions
  are returned as verified facts.
- CDN request compatibility: the shared media-probe and download-delivery
  policy uses the fixed Chromium 119 user agent documented as the installed
  Browser Run default instead of the application-specific bot-like user agent.
  This aligns the two credential-free Worker fetches with the renderer that can
  load the same public candidate. It is a bounded compatibility header, not
  credential impersonation: Cookie, Origin, Referer, client headers, and
  browser `sec-*` headers remain absent, and requests retain `credentials:
  'omit'`, an empty referrer, and `no-referrer`. The compatibility header did not
  eliminate repeated production transport failures, which motivates the
  explicit unverified-vault and browser-redirect degradation described above.
- Lease decision: session and IP resolve permits are both 60 seconds. Deadline
  gates require at least 40 seconds before rendering, 26 seconds before probing,
  and 18 seconds before vault storage. These budgets cover the twelve-second
  provider browser options, a two-second absolute response-body read limit, an
  eight-second media probe, two sequential eight-second vault operations, and a
  two-second margin. If and only if the first renderer result has matching
  canonical identity but no allowed media candidate, the workflow may make one
  fresh request for the same canonical post when at least another 40 seconds
  remain. The worst case after that gate is fourteen seconds for the second
  rendered response plus the existing 26-second probe, vault, and margin
  budget, so it remains within the fixed 60-second permit. A successful first
  render and every unavailable, invalid-identity, or other invalid response are
  never retried. Compared with the former 30-second
  lease, a crashed resolve can occupy its session/IP concurrency slot for at
  most 30 additional seconds; successful and handled failures still release
  immediately.
- Production state and cost decision: after the account holder explicitly
  approved the metered Browser Run service and confirmed the paid Workers plan,
  production now declares exactly `{ "binding": "BROWSER" }`. `Env.BROWSER`
  remains optional in code so local and controlled tests can omit the external
  port, but the production exposure checker requires that exact binding and
  rejects `remote` or any additional field. Every rendered fallback consumes
  metered Browser Run capacity. Operators must monitor Browser Run Overview and
  Runs for total sessions, browser hours, Quick Action requests, failures, and
  current quota before and after releases; repository configuration is not
  evidence of current dashboard inventory, usage, or limits.
- Anonymous remote evidence: the first bounded proof against the exact public
  single-video post `DbPp-bqiQEB` returned Quick Action HTTP 200 and hydrated one
  `video[src]`, but the configured `addScriptTag` did not leave its marker or
  location attributes. The marker-based selectors therefore returned no
  candidates and that contract was removed rather than widened. A second proof
  made one credential-free Quick Action request using only scrape selectors. It
  completed in 3.583 seconds with one canonical link and one Open Graph URL,
  both equal to the normalized post, one full-page `video[src]`, and one unique
  allowed CDN candidate under `scontent-nrt6-1.cdninstagram.com`. Neither
  `article video[src]` nor `main video[src]` matched, the exact shortcode was
  present in body HTML but not visible text, and no Twitter URL metadata was
  present. Therefore article/main scope, visible-text identity, and Twitter
  metadata are not requirements.
- Post-fix direct-import evidence: at local revision `9c09651`, the production
  resolver module made exactly one credential-free remote Quick Action request
  for that same normalized post and returned HTTP 200 in 3,379 ms with exactly
  one `rendered-video` candidate on an allowed CDN hostname. This verifies the
  production code seam selected for activation, but it does not expose or prove
  the browser's final URL or redirect chain.
- Production failure evidence: the exact failed resolve was reported at the
  `resolve` stage with code `THREADS_UPSTREAM_UNAVAILABLE`; its request ID is
  intentionally not recorded. Since a direct remote run of the same anonymous
  resolver and post succeeded, that typed transport failure now joins the
  bounded fallback allowset. This is not an access-control bypass: both paths
  access the same public Threads origin without cookies, forwarded headers, or
  credentials; the server still constructs the canonical `/media` URL, requires
  matching canonical and Open Graph identity with at least one allowed candidate, and
  applies the existing media probe or its exact transport-unavailable
  degradation, encrypted vault, and same-origin-first download
  boundary. Login, access-denied, rate-limited, bot-blocked, ordinary redirect,
  and policy failures remain non-fallback; the sole redirect exception is the
  exact dedicated ambiguous-post signature above.
- Delayed-carousel timing evidence: fresh anonymous Browser Run sessions for
  public three-video carousel `DbR4-cwgSwC` exposed three distinct `video[src]`
  elements only after about 4.52--4.56 seconds, both on clean `/media` and when
  retaining the input `xmt` query. The same production Quick Action shape with
  `waitForSelector` returned HTTP 200 after about 2.35--2.68 seconds with valid,
  mutually matching redacted canonical/Open Graph identity but zero candidates.
  In those executions the provider field did not enforce the intended five-second
  wait. A fixed five-second hydration delay therefore replaces it. The matching
  clean/query observations also show that retaining `xmt` was not required, so
  normalized query stripping remains unchanged. These measurements do not
  establish a universal Threads hydration time.
- Carousel candidate evidence: all three hydrated videos were distinct while
  their observed dimensions, classes, and safe attributes matched; there was no
  evidenced single-video selector or ranking rule. The decoder therefore keeps
  every allowed canonical-deduplicated candidate in scrape/DOM order instead of
  discarding the second and third carousel entries. The workflow's existing
  eight-candidate probe cap remains the bounded downstream seam and preserves
  later successful candidates when earlier probes fail. The existing one-time
  retry still applies only to an exact valid zero-candidate response; provider,
  transport, identity, malformed-response, and policy failures are not retried.
- Evidence boundary and remaining limitations: the delayed multi-video evidence
  covers that exact public carousel, fresh anonymous runs, and the observed
  execution region. Other carousel shapes, images, private or deleted posts,
  login or challenge pages, redirect behavior beyond the exact ambiguous-post
  signature, cross-post DOM stability, and long-term CDN hostname stability
  remain unconfirmed. The
  canonical and Open Graph values are fail-closed upstream-authored identity
  evidence, not a direct final-location proof. `quickAction()` exposes no final
  URL or redirect chain and accepts no AbortSignal; request patterns contain
  each browser request's origin but do not prove every redirect hop. With no
  stable post-scoped selector, canonical identity plus full-page video results
  cannot by itself prove that every candidate is post-owned. A late
  provider response is rejected by the subsequent lease deadline gate, not
  locally hard-cancelled. Activation changes only the reviewed binding and
  exposure gate; failure must not cause automatic host, cookie, header, or
  origin widening.

## Deployment inventory and decisions

Repository evidence as of 2026-07-26 establishes the following deployment
model:

- `.github/workflows/main.yml` is the sole workflow. Pushes to `main` and manual
  dispatches run the ordered `verify -> sonar -> deploy` jobs against an
  immutable commit SHA. `verify` performs the pinned secret scan, dependency
  audit, formatting, lint, type checks, coverage, Durable Object, Range,
  security, end-to-end and accessibility tests, production builds, bundle and
  Wrangler exposure scans, and a Wrangler dry run.
- `sonar` consumes the four LCOV artifacts from that same SHA, runs the
  SonarQube Cloud scan with the repository secret named `SONAR_TOKEN`, waits for
  the Quality Gate, and runs `security:sonar` to require the exact revision and
  zero open findings. Remote Automatic Analysis and Quality Gate administration
  are not inferred from repository files.
- `deploy` depends on both preceding jobs and targets the GitHub `production`
  environment. It rebuilds the web bundle, repeats the bundle and Wrangler
  exposure scans, requires the approved legal production marker, verifies that
  the event SHA is still remote `main`, deploys with the repository secret names
  `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, then probes the production
  homepage and health endpoint.
- `wrangler.jsonc` disables `workers_dev` and preview URLs, omits route and
  custom-domain declarations, binds the production static assets and exact
  `BROWSER` Browser Run port, declares the expected host and origin, and exports
  four SQLite Durable Objects. It requires
  exactly the Worker secret names `DOWNLOAD_ENCRYPTION_KEY`,
  `RESOLVED_MEDIA_GRANT_KEY`, `SESSION_SIGNING_KEY`, and `TURNSTILE_SECRET`; no
  secret value is stored in the file.
- Turnstile configuration keeps the public `TURNSTILE_SITE_KEY` variable
  separate from the `TURNSTILE_SECRET` Worker binding. The Worker verifier
  requires the configured hostname, fixed `resolve` action, bounded challenge
  age, and one-time use through `TURNSTILE_REPLAYS`. The repository does not
  establish the remote widget mode, remote hostname allowlist, credential
  values, DNS state, or whether a credential is currently provisioned.

Evidence sources for this snapshot are `.github/workflows/main.yml`,
`wrangler.jsonc`, `package.json`, `scripts/check-bundle-secrets.mjs`,
`scripts/check-wrangler-exposure.mjs`, `scripts/check-deploy-readiness.mjs`,
`scripts/check-sonar-open-issues.mjs`, and
`apps/worker/src/security/turnstile.ts`. These sources define configuration and
gates, not remote control-plane state. No secret value, account identifier, or
token is recorded here.

## Atomic implementation order

1. Workspace
2. Errors and crypto
3. URL and CDN policy
4. Range support
5. Worker entry and assets
6. Session
7. Rate limit and Turnstile
8. Resolver
9. Vault
10. Download Durable Object
11. Streaming
12. Angular
13. Legal and accessibility
14. Integration and end-to-end tests
15. CI and documentation

Each item is a separately buildable, directly tested Conventional Commit.
The repository is pushed after each completed atomic commit under normal
process; this design-record commit is intentionally local because the
delegated task explicitly excludes pushing.
