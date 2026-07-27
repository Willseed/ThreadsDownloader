import { createApiError, type HealthResponse } from '@threads-downloader/contracts';
import { Hono } from 'hono';

import { createOpaqueId } from './security/cryptography.js';
import type { DownloadSessionNamespace } from './security/download-session-client.js';
import type { SessionNamespace } from './security/session-client.js';
import {
  createBrowserSessionRenderedPagePort,
  type BrowserSessionCleanupScheduler,
} from './resolver/browser-session-renderer.js';
import { IpRateLimiter } from './ip-rate-limiter.js';
import { TurnstileReplay } from './turnstile-replay.js';
import {
  createResolvePublicMediaHandler,
  serializeResolveFailureEvent,
  type ResolvePublicMediaBindings,
} from './workflows/resolve-public-media.js';
import { createPublicDownloadApiHandler } from './workflows/public-download-api.js';
import { createSessionWorkflowHandler } from './workflows/session.js';

export {
  acquireSessionResolvePermit,
  authorizeSession,
  releaseSessionResolvePermit,
  SessionResolvePermitError,
} from './security/session-client.js';
export type {
  BrowserSessionIdentity,
  SessionNamespace,
  SessionResolvePermit,
} from './security/session-client.js';
export type { DownloadSessionNamespace } from './security/download-session-client.js';
export { DownloadSession } from './download-session.js';
export { SessionCoordinator } from './session-coordinator.js';

export interface Env {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  readonly BROWSER?: BrowserRun;
  readonly DOWNLOAD_ENCRYPTION_KEY: string;
  readonly DOWNLOAD_SESSIONS: DownloadSessionNamespace;
  readonly EXPECTED_HOST: string;
  readonly EXPECTED_ORIGIN: string;
  readonly IP_RATE_LIMITS: DurableObjectNamespace<IpRateLimiter>;
  readonly RESOLVED_MEDIA_GRANT_KEY: string;
  readonly SESSION_SIGNING_KEY: string;
  readonly SESSIONS: SessionNamespace;
  readonly TURNSTILE_REPLAYS: DurableObjectNamespace<TurnstileReplay>;
  readonly TURNSTILE_SECRET: string;
  readonly TURNSTILE_SITE_KEY: string;
}

const securityHeaders = {
  'content-security-policy': [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "style-src 'self'",
    'frame-src https://challenges.cloudflare.com',
    "connect-src 'self'",
    "media-src 'self' https://cdninstagram.com https://*.cdninstagram.com https://*.fna.fbcdn.net",
  ].join('; '),
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), geolocation=(), microphone=()',
  'referrer-policy': 'no-referrer',
  'strict-transport-security': 'max-age=31536000',
  'x-content-type-options': 'nosniff',
} as const;

const agentDiscoveryLinks =
  '</.well-known/api-catalog>; rel="api-catalog", ' +
  '</.well-known/mcp.json>; rel="service-desc", ' +
  '</.well-known/agent-skills/index.json>; rel="describedby"';

const robotText = `# Threads Downloader
User-agent: *
Allow: /
Content-Signal: ai-train=yes, search=yes, ai-input=yes

Sitemap: https://threads.pylot.dev/sitemap.xml
`;

const markdownLanding = `# Threads Downloader

This endpoint provides a Markdown representation for AI agents.

- Site: https://threads.pylot.dev
- Health: https://threads.pylot.dev/api/health
- API: /api/session, /api/resolve, /api/download/*
`;

const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://threads.pylot.dev/</loc>
  </url>
  <url>
    <loc>https://threads.pylot.dev/privacy</loc>
  </url>
  <url>
    <loc>https://threads.pylot.dev/terms</loc>
  </url>
  <url>
    <loc>https://threads.pylot.dev/copyright</loc>
  </url>
</urlset>
`;

const apiCatalog = {
  linkset: [
    {
      anchor: 'https://threads.pylot.dev/api/health',
      'service-doc': [
        {
          href: 'https://threads.pylot.dev/llms.txt',
          type: 'text/plain',
        },
      ],
      'service-desc': [
        {
          href: 'https://threads.pylot.dev/.well-known/mcp.json',
          type: 'application/json',
        },
      ],
      status: [
        {
          href: 'https://threads.pylot.dev/api/health',
        },
      ],
    },
  ],
};

const oauthDiscovery = {
  issuer: 'https://threads.pylot.dev',
  authorization_endpoint: 'https://threads.pylot.dev/oauth/authorize',
  token_endpoint: 'https://threads.pylot.dev/oauth/token',
  jwks_uri: 'https://threads.pylot.dev/.well-known/jwks.json',
  registration_endpoint: 'https://threads.pylot.dev/auth/agent/register',
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  identity_types_supported: ['agent_uri'],
  id_token_signing_alg_values_supported: ['RS256'],
  identity_assertion: 'https://threads.pylot.dev/.well-known/agent-card.json',
  agent_auth: {
    register_uri: 'https://threads.pylot.dev/auth/agent/register',
    identity_endpoint: 'https://threads.pylot.dev/.well-known/agent-card.json',
    claim_endpoint: 'https://threads.pylot.dev/.well-known/agent-skills/index.json',
    revocation_endpoint: 'https://threads.pylot.dev/oauth/revoke',
    identity_types_supported: ['agent_uri'],
  },
};

const oauthProtectedResource = {
  resource: 'https://threads.pylot.dev',
  authorization_servers: ['https://threads.pylot.dev'],
  scopes_supported: ['public:read'],
};

const mcpServerCard = {
  serverInfo: {
    name: 'Threads Downloader',
    version: '1.0.0',
  },
  description: 'Threads media resolution and download service used by Threads Downloader.',
  url: 'https://threads.pylot.dev/mcp',
  transport: {
    type: 'streamable-http',
  },
  capabilities: {
    tools: true,
  },
};

const agentCard = {
  name: 'Threads Downloader',
  version: '1.0.0',
  description: 'Agent discovery and media download capabilities for Threads public posts.',
  skills: [
    {
      id: 'threads-public-download',
      name: 'threads-public-download',
      description: 'Resolve and download public Threads post media.',
    },
  ],
  supportedInterfaces: [
    {
      url: 'https://threads.pylot.dev',
      protocol: 'https',
    },
  ],
  capabilities: {
    skills: [
      {
        id: 'threads-public-download',
        name: 'threads-public-download',
        description: 'Resolve and download public Threads post media.',
      },
    ],
  },
};

const skillDocument = `# Threads Downloader API Skills

## resolve-public-post

## Description

Allows an AI agent to request resolution metadata for a public Threads post URL.

`;

const agentSkillsIndex = {
  $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
  skills: [
    {
      name: 'agent-card',
      type: 'skill-md',
      description: 'Retrieve Threads Downloader A2A and service metadata.',
      url: '/.well-known/agent-skills/agent-card/SKILL.md',
      digest: 'sha256:6a8f4fcbf0a8d4f3c5e4f4ef2a0d8e3f8fd1234c9d7e3c4a7c1b5f2a1b3c6d7e',
    },
  ],
};

function requestId(): string {
  return createOpaqueId();
}

const resolvePublicMedia = createResolvePublicMediaHandler({
  fetcher: fetch,
  now: Date.now,
  reportFailure(event) {
    console.error(serializeResolveFailureEvent(event));
  },
  requestId,
});

function resolveBindings(
  env: Env,
  cleanupScheduler: BrowserSessionCleanupScheduler,
): ResolvePublicMediaBindings {
  return {
    EXPECTED_HOST: env.EXPECTED_HOST,
    EXPECTED_ORIGIN: env.EXPECTED_ORIGIN,
    IP_RATE_LIMITS: env.IP_RATE_LIMITS,
    SESSION_SIGNING_KEY: env.SESSION_SIGNING_KEY,
    SESSIONS: env.SESSIONS,
    TURNSTILE_REPLAYS: env.TURNSTILE_REPLAYS,
    TURNSTILE_SECRET: env.TURNSTILE_SECRET,
    ...(env.BROWSER === undefined
      ? {}
      : {
          BROWSER: createBrowserSessionRenderedPagePort(env.BROWSER, undefined, cleanupScheduler),
        }),
  };
}

const publicDownloadApi = createPublicDownloadApiHandler({
  fetcher: (request) => fetch(request),
  now: Date.now,
  requestId,
});

const sessionWorkflow = createSessionWorkflowHandler({
  now: Date.now,
  requestId,
});

function applyResponsePolicy(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  for (const name of response.headers.keys()) {
    if (name.startsWith('access-control-')) {
      headers.delete(name);
    }
  }

  const requestPath = new URL(request.url).pathname;
  if (requestPath === '/') {
    headers.set('link', agentDiscoveryLinks);
  }

  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }

  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

function markdownResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/markdown',
    },
  });
}

function robotsResponse(): Response {
  return new Response(robotText, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain',
    },
  });
}

function sitemapResponse(): Response {
  return new Response(sitemapXml, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/xml',
    },
  });
}

function notFoundApi(id: string): Response {
  return Response.json(createApiError('NOT_FOUND', '找不到請求的 API 路徑。', id), {
    status: 404,
    headers: { 'cache-control': 'no-store' },
  });
}

function internalServerError(): Response {
  return Response.json(createApiError('INTERNAL_ERROR', '伺服器暫時無法處理請求。', requestId()), {
    status: 500,
    headers: { 'cache-control': 'no-store' },
  });
}

export const app = new Hono<{ Bindings: Env }>();

app.onError(() => internalServerError());

app.get('/api/health', (context) => {
  const response: HealthResponse = { status: 'ok', requestId: requestId() };
  return context.json(response, 200, { 'cache-control': 'no-store' });
});

app.get('/api/session', (context) => sessionWorkflow(context.req.raw, context.env));

app.post('/api/resolve', (context) => {
  const cleanupScheduler: BrowserSessionCleanupScheduler = (cleanup) => {
    context.executionCtx.waitUntil(cleanup);
  };
  return resolvePublicMedia(context.req.raw, resolveBindings(context.env, cleanupScheduler));
});

app.get('/robots.txt', () => robotsResponse());
app.get('/sitemap.xml', () => sitemapResponse());
app.get('/auth.md', () =>
  markdownResponse(
    `# auth.md\n\nThis site supports manual agent registration discovery metadata.\n\n` +
      `## Agent registration\n\n` +
      `This service supports AI agent registration via the endpoint metadata below.\n\n` +
      `## Discovery metadata\n` +
      `- Agent card: https://threads.pylot.dev/.well-known/agent-card.json\n` +
      `- A2A card: https://threads.pylot.dev/.well-known/agent-skills/index.json\n` +
      `- OAuth discovery: https://threads.pylot.dev/.well-known/oauth-authorization-server\n\n` +
      '```json\n' +
      '{\n' +
      '  "agent_auth": {\n' +
      '    "register_uri": "https://threads.pylot.dev/auth/agent/register",\n' +
      '    "identity_endpoint": "https://threads.pylot.dev/.well-known/agent-card.json",\n' +
      '    "claim_endpoint": "https://threads.pylot.dev/.well-known/agent-skills/index.json",\n' +
      '    "identity_types_supported": ["agent_uri"],\n' +
      '    "identity_assertion": "https://threads.pylot.dev/.well-known/agent-card.json"\n' +
      '  }\n' +
      '}\n' +
      '```\n',
  ),
);
app.get('/.well-known/api-catalog', () => Response.json(apiCatalog));
app.get('/.well-known/openid-configuration', () => Response.json(oauthDiscovery));
app.get('/.well-known/oauth-authorization-server', () => Response.json(oauthDiscovery));
app.get('/.well-known/oauth-protected-resource', () => Response.json(oauthProtectedResource));
app.get('/.well-known/mcp/server-card.json', () => Response.json(mcpServerCard));
app.get('/.well-known/mcp/cards.json', () => Response.json(mcpServerCard));
app.get('/.well-known/mcp.json', () => Response.json(mcpServerCard));
app.get('/.well-known/mcp/server-cards.json', () => Response.json(mcpServerCard));
app.get('/.well-known/agent-card.json', () => Response.json(agentCard));
app.get('/.well-known/agent-skills/index.json', () => Response.json(agentSkillsIndex));
app.get('/.well-known/agent-skills/agent-card/SKILL.md', () => markdownResponse(skillDocument));
app.get('/.well-known/http-message-signatures-directory', () =>
  Response.json({
    keys: [
      {
        crv: 'Ed25519',
        kty: 'OKP',
        kid: 'threads-downloader-agent',
        x: 'vxre-2F8HMwk0SCSHFzXLK8unyikmcX_4R4IO5VDAlw',
        use: 'sig',
      },
    ],
  }),
);

app.get('/', async (context) => {
  const request = context.req.raw;
  const accept = request.headers.get('accept') ?? '';
  if (accept.includes('text/markdown')) {
    return markdownResponse(markdownLanding);
  }
  const response = await context.env.ASSETS.fetch(request);
  return applyResponsePolicy(request, response);
});

app.all('/api', () => notFoundApi(requestId()));
app.all('/api/*', (context) => publicDownloadApi(context.req.raw, context.env));
app.all('*', async (context) => {
  const response = await context.env.ASSETS.fetch(context.req.raw);
  return applyResponsePolicy(context.req.raw, response);
});

const worker = {
  async fetch(request: Request, env: Env, executionContext: ExecutionContext): Promise<Response> {
    const hostname = new URL(request.url).hostname;
    if (hostname !== env.EXPECTED_HOST) {
      return applyResponsePolicy(request, new Response('Not Found', { status: 404 }));
    }

    const response = await app.fetch(request, env, executionContext);
    return applyResponsePolicy(request, response);
  },
};

export default worker;
export { IpRateLimiter, TurnstileReplay };
