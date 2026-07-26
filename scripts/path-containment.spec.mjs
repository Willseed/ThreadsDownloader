import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolvePathWithinRoot } from './path-containment.mjs';

describe('path containment boundary', () => {
  it('contains missing lexical descendants and rejects path escapes', () => {
    const allowedRoot = resolve('fixtures/allowed-root');
    const outsideRoot = resolve('fixtures/outside-root');
    const missingTarget = join(allowedRoot, 'missing-parent', 'missing-target');
    const normalizedDescendant = join(allowedRoot, 'nested', '..', 'future-bundle');

    expect(resolvePathWithinRoot(allowedRoot, allowedRoot)).toBe(allowedRoot);
    expect(resolvePathWithinRoot(allowedRoot, missingTarget)).toBe(resolve(missingTarget));
    expect(resolvePathWithinRoot(allowedRoot, normalizedDescendant)).toBe(
      resolve(normalizedDescendant),
    );
    expect(resolvePathWithinRoot(allowedRoot, join(allowedRoot, '..', 'escape'))).toBeUndefined();
    expect(resolvePathWithinRoot(allowedRoot, outsideRoot)).toBeUndefined();
    expect(resolvePathWithinRoot(allowedRoot, `${allowedRoot}-sibling`)).toBeUndefined();
  });
});
