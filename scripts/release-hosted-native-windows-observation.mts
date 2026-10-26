import { createHash } from "node:crypto";
import { readNativeCapturedStream } from "./release-native-capture-files.mts";

/** Captured streams may honestly be empty. This grants no executable custody or
 * capture provenance; retain operation and readback failures independently. */
export async function observeWindowsAccountCommand(
  directory: string,
  status: number | undefined,
  operationError: unknown,
  readbackFailures: readonly string[],
) {
  const base = {
    status: status ?? null,
    resource_error:
      operationError instanceof Error
        ? operationError.message.slice(0, 1024)
        : operationError === undefined
          ? null
          : "resource operation refused",
    readback_failures: [...readbackFailures],
    authority: "none",
  };
  try {
    const bytes = await readNativeCapturedStream(directory, "account.stderr.bin");
    return {
      ...base,
      stderr: {
        observation: "read" as const,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        prefix_base64: bytes.subarray(0, 16384).toString("base64"),
        truncated: bytes.length > 16384,
      },
    };
  } catch (error) {
    return {
      ...base,
      stderr: {
        observation: "refused" as const,
        error:
          error instanceof Error ? error.message.slice(0, 1024) : "captured stderr read refused",
      },
    };
  }
}
