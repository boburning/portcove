/** Data-only error boundary shared by remote snapshot reads and journal writes. */
export class CoordinatorRemoteError extends Error {
  readonly evidence: unknown;
  constructor(message: string, evidence: unknown) {
    super(message);
    this.name = "CoordinatorRemoteError";
    this.evidence = evidence;
  }
}
