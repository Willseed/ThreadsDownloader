# Threads Downloader Design Record

## Purpose and boundaries

This document records the intended Worker, Durable Object, and Angular design.
It is a decision record, not an API contract for an upstream Threads service.
No undocumented upstream field, event, sequence, subscription result, or market
state is assumed by this design.

The service resolves an allowed public download target and hands a browser a
short-lived, same-origin download. The frontend never receives a CDN URL and
the service never logs one. Download content is streamed statelessly by the
Worker; durable state is limited to authorization, transfer accounting, and
lifecycle control.

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

Encrypted resolver credentials or tokens live only in a server vault using
AES-GCM. Keys and plaintext do not enter source, frontend bundles, logs, or
error messages. CDN URLs likewise never enter the frontend or logs.

## Durable Object lifecycle model

SQLite Durable Object exports are: `SessionCoordinator`, `IpRateLimiter`,
`TurnstileReplay`, and `DownloadSession`. These names describe fixed storage
records, not public HTTP resources. The initial lifecycle uses SQLite exports
and fixed storage; automatic rollback across lifecycle transitions is not
approved.

`DownloadSession` states are `ISSUED`, `ACTIVE`, `INTERRUPTED`,
`COMPLETE_PENDING`, and `EXPIRED`.

| Limit or lease | Value | Meaning |
| --- | ---: | --- |
| Start deadline | 120 seconds | issued download must begin |
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
`head` obtains and validates metadata. `stream` proxies a single allowed
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
buffer full files, construct a client-visible CDN redirect, or rely on a
frontend retry to enforce safety.

## Angular application

The client is an Angular standalone application. `DownloaderModel` uses
signals for view state, typed reactive forms for input and validation, and
`OnPush` components. It calls only same-origin endpoints and consumes safe
status/errors rather than origin details.

The form exposes clear labels, validation summaries, keyboard operation,
visible focus, semantic status updates, and sufficient contrast to meet WCAG
expectations. The final handoff is a same-origin download anchor; it avoids
opening or displaying the CDN location. Legal notices, acceptable-use text,
and a reporting path are part of handoff and error surfaces.

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
  custom-domain declarations, binds the production static assets, declares the
  expected host and origin, and exports four SQLite Durable Objects. It requires
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
