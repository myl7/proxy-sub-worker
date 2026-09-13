/**
 * Error types for this Worker.
 *
 * Messages must name the problem without quoting anything that came out of a
 * subscription: no rule text, no rule target, no proxy name, no credential.
 */

/** Thrown while shaping or validating the merged subscription. */
export class MergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeError";
  }
}

/** Thrown while reading a group policy (GROUPS_JSON or the default). */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}
