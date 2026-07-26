import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  parseSonarTimeout,
  SONAR_RULES,
  verifySonarOpenIssues,
} from './check-sonar-open-issues.mjs';

const scriptPath = fileURLToPath(new URL('./check-sonar-open-issues.mjs', import.meta.url));
const expectedRevision = 'a'.repeat(40);
const analysisId = 'analysis-current';
const metrics = [
  'bugs',
  'vulnerabilities',
  'code_smells',
  'security_hotspots',
  'duplicated_lines',
  'duplicated_lines_density',
];

function jsonResponse(body, init = {}) {
  return new globalThis.Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    ...init,
  });
}

function successPayload(url) {
  switch (url.pathname) {
    case '/api/ce/component':
      return {
        current: {
          analysisId,
          branch: 'main',
          componentKey: 'Willseed_ThreadsDownloader',
          status: 'SUCCESS',
        },
        queue: [],
      };
    case '/api/project_analyses/search':
      return {
        analyses: [{ key: analysisId, revision: expectedRevision }],
        paging: { pageIndex: 1, pageSize: 500, total: 1 },
      };
    case '/api/qualitygates/project_status':
      return { projectStatus: { conditions: [], status: 'OK' } };
    case '/api/issues/search':
      return {
        issues: [],
        paging: { pageIndex: 1, pageSize: 1, total: 0 },
        total: 0,
      };
    case '/api/measures/component':
      return {
        component: {
          key: 'Willseed_ThreadsDownloader',
          measures: metrics.map((metric) => ({
            metric,
            value: metric === 'duplicated_lines_density' ? '0.0' : '0',
          })),
        },
      };
    case '/api/hotspots/search':
      return {
        hotspots: [],
        paging: { pageIndex: 1, pageSize: 1, total: 0 },
      };
    default:
      throw new Error('unexpected endpoint');
  }
}

function sonarFetch(overrides = {}) {
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ init, url });
    const override = overrides[url.pathname];
    if (override instanceof globalThis.Response) {
      return override;
    }
    const body =
      typeof override === 'function'
        ? await override(url, init)
        : (override ?? successPayload(url));
    return body instanceof globalThis.Response ? body : jsonResponse(body);
  };
  return { fetchImpl, requests };
}

async function expectRule(ruleId, overrides, revision = expectedRevision) {
  const { fetchImpl } = sonarFetch(overrides);
  await expect(
    verifySonarOpenIssues({ expectedRevision: revision, fetchImpl, timeoutMs: 1000 }),
  ).rejects.toMatchObject({ ruleId });
}

describe('Sonar open findings gate', () => {
  it('binds every zero-finding check to the latest successful main analysis', async () => {
    const { fetchImpl, requests } = sonarFetch();

    await expect(
      verifySonarOpenIssues({ expectedRevision, fetchImpl, timeoutMs: 1000 }),
    ).resolves.toBeUndefined();

    expect(requests.map(({ url }) => url.pathname)).toEqual([
      '/api/ce/component',
      '/api/project_analyses/search',
      '/api/qualitygates/project_status',
      '/api/issues/search',
      '/api/measures/component',
      '/api/hotspots/search',
      '/api/ce/component',
    ]);
    expect(requests[0]?.url.searchParams.get('component')).toBe('Willseed_ThreadsDownloader');
    expect(requests[1]?.url.searchParams.get('branch')).toBe('main');
    expect(requests[2]?.url.searchParams.get('analysisId')).toBe(analysisId);
    expect(requests[2]?.url.searchParams.has('projectKey')).toBe(false);
    expect(requests[3]?.url.searchParams.get('resolved')).toBe('false');
    expect(requests[4]?.url.searchParams.get('metricKeys')?.split(',')).toEqual(metrics);
    expect(requests[5]?.url.searchParams.get('status')).toBe('TO_REVIEW');
    expect(requests[5]?.url.searchParams.has('branch')).toBe(false);
    for (const { init, url } of requests) {
      expect(url.origin).toBe('https://sonarcloud.io');
      expect(new globalThis.Headers(init?.headers).get('authorization')).toBeNull();
      expect(new globalThis.Headers(init?.headers).get('accept')).toBe('application/json');
      expect(init?.redirect).toBe('error');
    }
  });

  it('finds the CE analysis by id without assuming analysis result order', async () => {
    const pageOne = Array.from({ length: 500 }, (_, index) => ({
      key: `older-${String(index)}`,
      revision: 'b'.repeat(40),
    }));
    const { fetchImpl, requests } = sonarFetch({
      '/api/project_analyses/search': (url) => {
        const page = Number(url.searchParams.get('p'));
        return page === 1
          ? {
              analyses: pageOne,
              paging: { pageIndex: 1, pageSize: 500, total: 501 },
            }
          : {
              analyses: [{ key: analysisId, revision: expectedRevision }],
              paging: { pageIndex: 2, pageSize: 500, total: 501 },
            };
      },
    });

    await verifySonarOpenIssues({ expectedRevision, fetchImpl, timeoutMs: 1000 });

    expect(
      requests.filter(({ url }) => url.pathname === '/api/project_analyses/search'),
    ).toHaveLength(2);
  });

  it.each([
    [
      SONAR_RULES.ceUnsettled,
      { '/api/ce/component': { current: null, queue: [{ status: 'IN_PROGRESS' }] } },
    ],
    [
      SONAR_RULES.ceResponse,
      {
        '/api/ce/component': {
          current: {
            analysisId,
            branch: 'feature',
            componentKey: 'Willseed_ThreadsDownloader',
            status: 'SUCCESS',
          },
          queue: [],
        },
      },
    ],
    [
      SONAR_RULES.gateNotOk,
      { '/api/qualitygates/project_status': { projectStatus: { status: 'ERROR' } } },
    ],
    [
      SONAR_RULES.issuesOpen,
      {
        '/api/issues/search': {
          issues: [{ key: 'issue' }],
          paging: { pageIndex: 1, pageSize: 1, total: 1 },
          total: 1,
        },
      },
    ],
    [
      SONAR_RULES.hotspotsOpen,
      {
        '/api/hotspots/search': {
          hotspots: [{ key: 'hotspot' }],
          paging: { pageIndex: 1, pageSize: 1, total: 1 },
        },
      },
    ],
  ])('rejects unsafe analysis state with fixed rule %s', async (ruleId, overrides) => {
    await expectRule(ruleId, overrides);
  });

  it('rejects a valid but different analysis revision', async () => {
    await expectRule(SONAR_RULES.revisionMismatch, {}, 'b'.repeat(40));
  });

  it('fails closed if the current analysis changes while current metrics are checked', async () => {
    let currentRequestCount = 0;
    await expectRule(SONAR_RULES.analysisChanged, {
      '/api/ce/component': () => {
        currentRequestCount += 1;
        return {
          current: {
            analysisId: currentRequestCount === 1 ? analysisId : 'analysis-replaced',
            branch: 'main',
            componentKey: 'Willseed_ThreadsDownloader',
            status: 'SUCCESS',
          },
          queue: [],
        };
      },
    });
  });

  it.each(metrics)('rejects nonzero metric %s', async (nonzeroMetric) => {
    await expectRule(SONAR_RULES.measuresNotZero, {
      '/api/measures/component': {
        component: {
          key: 'Willseed_ThreadsDownloader',
          measures: metrics.map((metric) => ({
            metric,
            value: metric === nonzeroMetric ? '1' : '0',
          })),
        },
      },
    });
  });

  it.each([
    metrics.slice(1).map((metric) => ({ metric, value: '0' })),
    [...metrics.map((metric) => ({ metric, value: '0' })), { metric: 'bugs', value: '0' }],
    metrics.map((metric) => ({ metric, value: metric === 'bugs' ? 'zero' : '0' })),
  ])('fails closed for missing, duplicate, or malformed measures %#', async (measures) => {
    await expectRule(SONAR_RULES.measuresResponse, {
      '/api/measures/component': {
        component: { key: 'Willseed_ThreadsDownloader', measures },
      },
    });
  });

  it.each([
    [SONAR_RULES.ceRequest, async () => Promise.reject(new Error('private transport detail'))],
    [SONAR_RULES.ceRequest, new globalThis.Response('private server detail', { status: 503 })],
    [
      SONAR_RULES.ceResponse,
      new globalThis.Response('{"queue":[]}', {
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      SONAR_RULES.ceResponse,
      new globalThis.Response('{invalid', {
        headers: { 'content-type': 'application/json' },
      }),
    ],
  ])('fails closed for transport and decoding boundary %s', async (ruleId, response) => {
    await expectRule(ruleId, { '/api/ce/component': response });
  });

  it('validates timeout boundaries without coercion', () => {
    expect(parseSonarTimeout(undefined)).toBe(15_000);
    expect(parseSonarTimeout('1')).toBe(1000);
    expect(parseSonarTimeout('120')).toBe(120_000);
    for (const value of ['', '0', '001', '121', '1.5', '-1', 'private']) {
      expect(() => parseSonarTimeout(value)).toThrowError(
        expect.objectContaining({ ruleId: SONAR_RULES.timeoutInvalid }),
      );
    }
  });

  it('prints only a fixed rule for invalid CLI input', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: { GITHUB_SHA: 'private-revision-value' },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('SONAR_REVISION_INVALID\n');
    expect(result.stderr).not.toContain('private-revision-value');
  });
});
