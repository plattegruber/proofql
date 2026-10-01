/**
 * Structural subset of the Workers AI binding (`env.AI`): the one method
 * this package calls. Workers pass the real binding; unit tests pass a
 * plain object. Declared as a method (not a function property) so the
 * real, overloaded `Ai.run` is assignable without this package importing
 * `@cloudflare/workers-types`.
 */
export interface WorkersAiBinding {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

/** Base class for every error this package throws. */
export class AiProviderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * Workers AI answered, but not in the shape the model is documented to
 * return. A drift in the binding must surface as one typed error, not as
 * `undefined is not a function` three layers down.
 */
export class AiResponseError extends AiProviderError {
  readonly model: string;

  constructor(model: string, detail: string) {
    super(`Workers AI ${model} returned an unexpected response: ${detail}`);
    this.model = model;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  );
}
