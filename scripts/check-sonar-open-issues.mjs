import { Buffer } from 'node:buffer';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const SONAR_ORIGIN = 'https://sonarcloud.io';
const SONAR_PROJECT = 'Willseed_ThreadsDownloader';
const SONAR_BRANCH = 'main';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_SECONDS = 120;
const MAX_RESPONSE_BYTES = 1_000_000;
const ANALYSES_PAGE_SIZE = 500;
const MAX_ANALYSES_PAGES = 20;

const zeroMetrics = Object.freeze([
  'bugs',
  'vulnerabilities',
  'code_smells',
  'security_hotspots',
  'duplicated_lines',
  'duplicated_lines_density',
]);

/**
 * Evidence snapshot, 2026-07-26: SonarCloud's official
 * /api/webservices/list metadata and the public Willseed_ThreadsDownloader
 * responses confirmed every endpoint and field decoded below. The qualitygate
 * and hotspots endpoints are officially deprecated but remain the only public
 * exact-analysis gate and legacy TO_REVIEW hotspot interfaces in that snapshot.
 * Two required ask-bridge attempts were discarded because a shared concurrent
 * browser session returned unrelated Cloudflare research.
 */
export const SONAR_RULES = Object.freeze({
  analysisChanged: 'SONAR_ANALYSIS_CHANGED_DURING_VERIFICATION',
  analysesMissing: 'SONAR_ANALYSIS_MISSING',
  analysesRequest: 'SONAR_ANALYSES_REQUEST_FAILED',
  analysesResponse: 'SONAR_ANALYSES_RESPONSE_INVALID',
  argumentInvalid: 'SONAR_ARGUMENT_INVALID',
  ceRequest: 'SONAR_CE_REQUEST_FAILED',
  ceResponse: 'SONAR_CE_RESPONSE_INVALID',
  ceUnsettled: 'SONAR_CE_NOT_SETTLED',
  gateNotOk: 'SONAR_QUALITY_GATE_NOT_OK',
  gateRequest: 'SONAR_QUALITY_GATE_REQUEST_FAILED',
  gateResponse: 'SONAR_QUALITY_GATE_RESPONSE_INVALID',
  hotspotsOpen: 'SONAR_HOTSPOTS_TO_REVIEW',
  hotspotsRequest: 'SONAR_HOTSPOTS_REQUEST_FAILED',
  hotspotsResponse: 'SONAR_HOTSPOTS_RESPONSE_INVALID',
  internal: 'SONAR_INTERNAL_FAILURE',
  issuesOpen: 'SONAR_OPEN_ISSUES',
  issuesRequest: 'SONAR_ISSUES_REQUEST_FAILED',
  issuesResponse: 'SONAR_ISSUES_RESPONSE_INVALID',
  measuresNotZero: 'SONAR_MEASURES_NOT_ZERO',
  measuresRequest: 'SONAR_MEASURES_REQUEST_FAILED',
  measuresResponse: 'SONAR_MEASURES_RESPONSE_INVALID',
  revisionInvalid: 'SONAR_REVISION_INVALID',
  revisionMismatch: 'SONAR_REVISION_MISMATCH',
  timeoutInvalid: 'SONAR_TIMEOUT_INVALID',
});

export class SonarGateFailure extends Error {
  constructor(ruleId) {
    super(ruleId);
    this.name = 'SonarGateFailure';
    this.ruleId = ruleId;
  }
}

function fail(ruleId) {
  throw new SonarGateFailure(ruleId);
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isSafeIdentifier(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,200}$/u.test(value);
}

function sonarUrl(path, parameters) {
  const url = new globalThis.URL(path, SONAR_ORIGIN);
  for (const [key, value] of Object.entries(parameters)) {
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function requestJson(fetchImpl, url, timeoutMs, requestRule, responseRule) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(timeoutMs),
    });
  } catch {
    fail(requestRule);
  }

  if (!(response instanceof globalThis.Response) || !response.ok) {
    fail(requestRule);
  }
  const contentType = response.headers.get('content-type');
  if (contentType === null || !/^application\/json(?:\s*;|$)/iu.test(contentType)) {
    fail(responseRule);
  }

  let contents;
  try {
    contents = await response.text();
  } catch {
    fail(responseRule);
  }
  if (contents === '' || Buffer.byteLength(contents, 'utf8') > MAX_RESPONSE_BYTES) {
    fail(responseRule);
  }

  try {
    return JSON.parse(contents);
  } catch {
    fail(responseRule);
  }
}

function decodePaging(value, expectedPage, responseRule) {
  if (
    !isRecord(value) ||
    value['pageIndex'] !== expectedPage ||
    !isNonnegativeInteger(value['pageSize']) ||
    !isNonnegativeInteger(value['total'])
  ) {
    fail(responseRule);
  }
  return { pageSize: value['pageSize'], total: value['total'] };
}

async function currentAnalysisId(fetchImpl, timeoutMs) {
  const payload = await requestJson(
    fetchImpl,
    sonarUrl('/api/ce/component', { component: SONAR_PROJECT }),
    timeoutMs,
    SONAR_RULES.ceRequest,
    SONAR_RULES.ceResponse,
  );
  if (!isRecord(payload) || !Array.isArray(payload['queue'])) {
    fail(SONAR_RULES.ceResponse);
  }
  if (payload['queue'].length !== 0) {
    fail(SONAR_RULES.ceUnsettled);
  }

  const current = payload['current'];
  if (
    !isRecord(current) ||
    current['componentKey'] !== SONAR_PROJECT ||
    current['branch'] !== SONAR_BRANCH ||
    current['status'] !== 'SUCCESS' ||
    !isSafeIdentifier(current['analysisId'])
  ) {
    fail(SONAR_RULES.ceResponse);
  }
  return current['analysisId'];
}

function decodeAnalysesPage(payload, page, expectedTotal) {
  if (!isRecord(payload) || !Array.isArray(payload['analyses'])) {
    fail(SONAR_RULES.analysesResponse);
  }
  const paging = decodePaging(payload['paging'], page, SONAR_RULES.analysesResponse);
  const total = expectedTotal ?? paging.total;
  if (
    paging.pageSize !== ANALYSES_PAGE_SIZE ||
    paging.total !== total ||
    total > MAX_ANALYSES_PAGES * ANALYSES_PAGE_SIZE
  ) {
    fail(SONAR_RULES.analysesResponse);
  }
  return { analyses: payload['analyses'], total };
}

function findAnalysisRevision(analyses, analysisId) {
  for (const analysis of analyses) {
    if (!isRecord(analysis) || !isSafeIdentifier(analysis['key'])) {
      fail(SONAR_RULES.analysesResponse);
    }
    if (analysis['key'] === analysisId) {
      const revision = analysis['revision'];
      if (typeof revision !== 'string' || !/^[\da-f]{40}$/u.test(revision)) {
        fail(SONAR_RULES.analysesResponse);
      }
      return revision;
    }
  }
  return undefined;
}

async function analysisRevision(fetchImpl, timeoutMs, analysisId) {
  let expectedTotal;
  for (let page = 1; page <= MAX_ANALYSES_PAGES; page += 1) {
    const payload = await requestJson(
      fetchImpl,
      sonarUrl('/api/project_analyses/search', {
        branch: SONAR_BRANCH,
        p: page,
        project: SONAR_PROJECT,
        ps: ANALYSES_PAGE_SIZE,
      }),
      timeoutMs,
      SONAR_RULES.analysesRequest,
      SONAR_RULES.analysesResponse,
    );
    const decoded = decodeAnalysesPage(payload, page, expectedTotal);
    expectedTotal = decoded.total;
    const revision = findAnalysisRevision(decoded.analyses, analysisId);
    if (revision !== undefined) {
      return revision;
    }

    if (page * ANALYSES_PAGE_SIZE >= expectedTotal) {
      break;
    }
  }
  fail(SONAR_RULES.analysesMissing);
}

async function verifyQualityGate(fetchImpl, timeoutMs, analysisId) {
  const payload = await requestJson(
    fetchImpl,
    sonarUrl('/api/qualitygates/project_status', { analysisId }),
    timeoutMs,
    SONAR_RULES.gateRequest,
    SONAR_RULES.gateResponse,
  );
  const projectStatus = isRecord(payload) ? payload['projectStatus'] : undefined;
  const status = isRecord(projectStatus) ? projectStatus['status'] : undefined;
  if (typeof status !== 'string' || !['ERROR', 'NONE', 'OK', 'WARN'].includes(status)) {
    fail(SONAR_RULES.gateResponse);
  }
  if (status !== 'OK') {
    fail(SONAR_RULES.gateNotOk);
  }
}

function decodeZeroSearch(payload, collectionKey, responseRule, openRule) {
  if (!isRecord(payload) || !Array.isArray(payload[collectionKey])) {
    fail(responseRule);
  }
  const paging = decodePaging(payload['paging'], 1, responseRule);
  if (collectionKey === 'issues' && payload['total'] !== paging.total) {
    fail(responseRule);
  }
  if (paging.total !== 0) {
    fail(openRule);
  }
  if (payload[collectionKey].length !== 0) {
    fail(responseRule);
  }
}

async function verifyOpenIssues(fetchImpl, timeoutMs) {
  const payload = await requestJson(
    fetchImpl,
    sonarUrl('/api/issues/search', {
      branch: SONAR_BRANCH,
      componentKeys: SONAR_PROJECT,
      p: 1,
      ps: 1,
      resolved: false,
    }),
    timeoutMs,
    SONAR_RULES.issuesRequest,
    SONAR_RULES.issuesResponse,
  );
  decodeZeroSearch(payload, 'issues', SONAR_RULES.issuesResponse, SONAR_RULES.issuesOpen);
}

async function verifyMeasures(fetchImpl, timeoutMs) {
  const payload = await requestJson(
    fetchImpl,
    sonarUrl('/api/measures/component', {
      branch: SONAR_BRANCH,
      component: SONAR_PROJECT,
      metricKeys: zeroMetrics.join(','),
    }),
    timeoutMs,
    SONAR_RULES.measuresRequest,
    SONAR_RULES.measuresResponse,
  );
  const component = isRecord(payload) ? payload['component'] : undefined;
  const measures = isRecord(component) ? component['measures'] : undefined;
  if (component?.['key'] !== SONAR_PROJECT || !Array.isArray(measures)) {
    fail(SONAR_RULES.measuresResponse);
  }

  const values = new Map();
  for (const measure of measures) {
    const metric = isRecord(measure) ? measure['metric'] : undefined;
    const value = isRecord(measure) ? measure['value'] : undefined;
    if (
      typeof metric !== 'string' ||
      !zeroMetrics.includes(metric) ||
      values.has(metric) ||
      typeof value !== 'string' ||
      !/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)
    ) {
      fail(SONAR_RULES.measuresResponse);
    }
    values.set(metric, value);
  }
  if (values.size !== zeroMetrics.length) {
    fail(SONAR_RULES.measuresResponse);
  }
  if ([...values.values()].some((value) => Number(value) !== 0)) {
    fail(SONAR_RULES.measuresNotZero);
  }
}

async function verifyHotspots(fetchImpl, timeoutMs) {
  const payload = await requestJson(
    fetchImpl,
    sonarUrl('/api/hotspots/search', {
      p: 1,
      projectKey: SONAR_PROJECT,
      ps: 1,
      status: 'TO_REVIEW',
    }),
    timeoutMs,
    SONAR_RULES.hotspotsRequest,
    SONAR_RULES.hotspotsResponse,
  );
  decodeZeroSearch(payload, 'hotspots', SONAR_RULES.hotspotsResponse, SONAR_RULES.hotspotsOpen);
}

export function parseSonarTimeout(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (!/^[1-9]\d*$/u.test(value)) {
    fail(SONAR_RULES.timeoutInvalid);
  }
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_TIMEOUT_SECONDS) {
    fail(SONAR_RULES.timeoutInvalid);
  }
  return seconds * 1000;
}

export async function verifySonarOpenIssues({
  expectedRevision,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (typeof expectedRevision !== 'string' || !/^[\da-f]{40}$/u.test(expectedRevision)) {
    fail(SONAR_RULES.revisionInvalid);
  }
  if (typeof fetchImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    fail(SONAR_RULES.internal);
  }

  const analysisId = await currentAnalysisId(fetchImpl, timeoutMs);
  const revision = await analysisRevision(fetchImpl, timeoutMs, analysisId);
  if (revision !== expectedRevision) {
    fail(SONAR_RULES.revisionMismatch);
  }
  await verifyQualityGate(fetchImpl, timeoutMs, analysisId);
  await verifyOpenIssues(fetchImpl, timeoutMs);
  await verifyMeasures(fetchImpl, timeoutMs);
  await verifyHotspots(fetchImpl, timeoutMs);
  if ((await currentAnalysisId(fetchImpl, timeoutMs)) !== analysisId) {
    fail(SONAR_RULES.analysisChanged);
  }
}

async function main() {
  if (process.argv.length !== 2) {
    fail(SONAR_RULES.argumentInvalid);
  }
  await verifySonarOpenIssues({
    expectedRevision: process.env['GITHUB_SHA'],
    timeoutMs: parseSonarTimeout(process.env['SONAR_OPEN_ISSUES_TIMEOUT_SECONDS']),
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    const ruleId = error instanceof SonarGateFailure ? error.ruleId : SONAR_RULES.internal;
    process.stderr.write(`${ruleId}\n`);
    process.exitCode = 1;
  }
}
