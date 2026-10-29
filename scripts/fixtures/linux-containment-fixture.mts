/** Preserve the Linux containment fixture's primary and cleanup failures.
 * Self-contained so the existing isolated fixture can serialize this whole function.
 */
export async function runLinuxFixtureWithCleanup(
  operation: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let primaryFailure: { error: unknown } | undefined;
  try {
    await operation();
  } catch (error) {
    primaryFailure = { error };
  }
  let cleanupFailure: { error: unknown } | undefined;
  try {
    await cleanup();
  } catch (error) {
    cleanupFailure = { error };
  }
  if (primaryFailure && cleanupFailure) {
    throw new AggregateError(
      [primaryFailure.error, cleanupFailure.error],
      "scenario and owned fixture cleanup failed",
    );
  }
  if (primaryFailure) throw primaryFailure.error;
  if (cleanupFailure) throw cleanupFailure.error;
}
