import { describe, expect, expectTypeOf, it } from 'vitest';

import { decodeExactRecord } from '../src/strict-json.js';

describe('decodeExactRecord', () => {
  it('narrows an exact record without depending on insertion order', () => {
    const input = { second: 2, first: 1 };
    const decoded = decodeExactRecord(input, ['first', 'second'] as const);

    expect(decoded).toBe(input);
    expectTypeOf(decoded).toEqualTypeOf<Record<'first' | 'second', unknown> | null>();
  });

  it('matches collation-equivalent Unicode keys independently of insertion order', () => {
    const composed = '\u00e9';
    const decomposed = 'e\u0301';
    const input = { [composed]: 'composed', [decomposed]: 'decomposed' };

    expect(decodeExactRecord(input, [decomposed, composed] as const)).toBe(input);
  });

  it.each([
    null,
    undefined,
    'record',
    1,
    Object.assign([], { first: 1, second: 2 }),
    { first: 1 },
    { first: 1, second: 2, extra: true },
  ])('rejects non-record, missing-key, and extra-key input: %j', (input) => {
    expect(decodeExactRecord(input, ['first', 'second'])).toBeNull();
  });

  it('checks only own enumerable string keys and preserves the input prototype', () => {
    const symbol = Symbol('ignored');
    const prototype = { inherited: true };
    const input = Object.assign(Object.create(prototype) as Record<PropertyKey, unknown>, {
      own: true,
      [symbol]: 'ignored',
    });
    Object.defineProperty(input, 'hidden', { value: 'ignored' });

    const decoded = decodeExactRecord(input, ['own'] as const);

    expect(decoded).toBe(input);
    expect(Object.getPrototypeOf(decoded)).toBe(prototype);
    expect(decodeExactRecord(input, ['inherited', 'own'])).toBeNull();
    expect(decodeExactRecord(input, ['hidden', 'own'])).toBeNull();
  });

  it('does not mutate the expected-key list', () => {
    const expectedKeys = ['second', 'first'] as const;

    expect(decodeExactRecord({ first: 1, second: 2 }, expectedKeys)).not.toBeNull();
    expect(expectedKeys).toEqual(['second', 'first']);
  });
});
