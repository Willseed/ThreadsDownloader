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
  const actualKeys = Object.keys(record).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
    ? (record as Record<Keys[number], unknown>)
    : null;
}
