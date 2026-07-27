const SESSION_COORDINATOR_ORIGIN = 'https://session.internal';

export const SESSION_COORDINATOR_METHOD = 'POST';

export const SESSION_COORDINATOR_ROUTES = {
  session: {
    create: '/create',
    resume: '/resume',
    authorize: '/authorize',
  },
  resolvePermits: {
    acquire: '/resolve-permits/acquire',
    release: '/resolve-permits/release',
  },
  downloadPermits: {
    acquire: '/download-permits/acquire',
    renew: '/download-permits/renew',
    release: '/download-permits/release',
  },
  resolveVault: {
    store: '/resolve-vault/store',
    claim: '/resolve-vault/claim',
    settle: '/resolve-vault/settle',
  },
} as const;

type SessionCoordinatorRoutes = typeof SESSION_COORDINATOR_ROUTES;

export type SessionCoordinatorPath = {
  [
    Group in keyof SessionCoordinatorRoutes
  ]: SessionCoordinatorRoutes[Group][keyof SessionCoordinatorRoutes[Group]];
}[keyof SessionCoordinatorRoutes];

export function createSessionCoordinatorRequest(
  path: SessionCoordinatorPath,
  body: object,
): Request {
  return new Request(`${SESSION_COORDINATOR_ORIGIN}${path}`, {
    method: SESSION_COORDINATOR_METHOD,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
