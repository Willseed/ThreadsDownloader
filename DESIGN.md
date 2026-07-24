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

SQLite Durable Object exports are: `Session`, `IpRateLimit`,
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

## Deployment inventory and decisions

GitHub is public with default branch `main`, zero open pull requests, no rules,
workflows, or secrets. Pages has had its custom CNAME removed; its source
remains and HTTPS enforcement changed automatically from false to true.

Cloudflare is active on Free. The `threads` CNAME continues to target
`willseed.github.io` and remains proxied. Existing wildcard header-rule and
tools link-header routes are preserved. There is no target Worker, public
endpoint, custom domain, Pages deployment, Turnstile configuration, or
dedicated token. Durable Objects are available.

SonarCloud has project `Willseed_ThreadsDownloader` in organization
`uukbr6yqj4o8tuefbjxkmceuwcvkyrdk`, bound to GitHub. Automatic analysis is
off; its quality gate is Sonar way, baseline is `previous_version`, and only
`main` is configured. No analysis, token, or workflow exists.

Approved changes: Pages unlinking is complete; preserve wildcard routes and add
any future exact `threads` route without replacing them; introduce initial
SQLite lifecycle exports with fixed storage; do not automatically roll back
across lifecycle transitions. No secret or private account alias is stored.

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
