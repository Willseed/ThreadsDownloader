import type { HeaderSource } from './browser-session.js';
import type { KeyedIdentifierHasher } from './cryptography.js';

const maximumClientIpLength = 64;
const clientIpContext = 'resolve-ip';
const ipv4Octet = /^(?:0|[1-9]\d{0,2})$/u;
const ipv6Hextet = /^[0-9A-Fa-f]{1,4}$/u;

export type ClientIpErrorCode = 'CLIENT_IP_HASH_FAILED' | 'CLIENT_IP_INVALID';

export class ClientIpError extends Error {
  constructor(readonly code: ClientIpErrorCode) {
    super(code);
    this.name = 'ClientIpError';
  }
}

function fail(code: ClientIpErrorCode): never {
  throw new ClientIpError(code);
}

function isIpv4(value: string): boolean {
  const octets = value.split('.');
  return (
    octets.length === 4 && octets.every((octet) => ipv4Octet.test(octet) && Number(octet) <= 255)
  );
}

function ipv6SectionCount(value: string, mayContainIpv4: boolean): number | null {
  if (value === '') {
    return 0;
  }
  const sections = value.split(':');
  if (sections.some((section) => section === '')) {
    return null;
  }
  const last = sections.at(-1)!;
  if (last.includes('.')) {
    if (
      !mayContainIpv4 ||
      !isIpv4(last) ||
      sections.slice(0, -1).some((part) => part.includes('.'))
    ) {
      return null;
    }
    return sections.length + 1;
  }
  return sections.every((section) => ipv6Hextet.test(section)) ? sections.length : null;
}

function isIpv6(value: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/u.test(value)) {
    return false;
  }
  const separator = value.indexOf('::');
  if (separator !== value.lastIndexOf('::')) {
    return false;
  }
  if (separator === -1) {
    return ipv6SectionCount(value, true) === 8;
  }
  const left = value.slice(0, separator);
  const right = value.slice(separator + 2);
  const leftCount = ipv6SectionCount(left, false);
  const rightCount = ipv6SectionCount(right, true);
  return leftCount !== null && rightCount !== null && leftCount + rightCount < 8;
}

export function extractClientIp(headers: HeaderSource): string {
  const value = headers.get('CF-Connecting-IP');
  if (
    value === null ||
    value === '' ||
    value.length > maximumClientIpLength ||
    value.trim() !== value ||
    (!isIpv4(value) && !isIpv6(value))
  ) {
    return fail('CLIENT_IP_INVALID');
  }
  return value;
}

export async function hashClientIp(
  headers: HeaderSource,
  hasher: KeyedIdentifierHasher,
): Promise<string> {
  const value = extractClientIp(headers);
  try {
    return await hasher.hash(clientIpContext, value);
  } catch {
    return fail('CLIENT_IP_HASH_FAILED');
  }
}
