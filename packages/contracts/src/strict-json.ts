/**
 * Narrows non-array objects by their exact own enumerable string keys.
 * Symbol, non-enumerable, and inherited properties do not participate in the match.
 */
export function decodeExactRecord<const Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys,
): Record<Keys[number], unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record);
  const expectedKeySet = new Set<string>(expectedKeys);
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeySet.has(key))
    ? (record as Record<Keys[number], unknown>)
    : null;
}
