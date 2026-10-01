/**
 * Cosine similarity of two vectors, in [-1, 1]. Returns 0 when either
 * vector has zero norm (nothing to compare against), throws when the
 * lengths disagree because that is always a programming error, never a
 * data condition.
 */
export function cosineSimilarity(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length !== b.length) {
    throw new RangeError(
      `cosineSimilarity: vectors must have the same length (got ${a.length} and ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}
