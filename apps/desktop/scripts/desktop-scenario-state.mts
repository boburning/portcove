import type { SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import type { PortStatus } from "../src/transport-types.generated.js";
import { errorMessage, isRecord } from "../../../scripts/runtime-values.mts";
export interface OwnedFixtureContext {
  cli: string;
  library: string;
  output: string;
  catalogPath?: string;
}
interface FixtureProcessResult {
  status: number | null;
  signal?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: unknown;
}
export type FixtureSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => FixtureProcessResult;
export type FixtureCommand = (
  args: readonly string[],
  selectedLibrary?: string,
  options?: { timeoutMs?: number },
) => unknown;
// Owned native fixture state shared across scenario orderings.
import assert from "node:assert/strict";
import path from "node:path";
import { spawnCommand } from "../../../scripts/dev-storage.mts";

export function fixtureObject(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value));
  return value;
}

export function requiredFixtureValue<Value>(value: Value | null | undefined): Value {
  assert.ok(value !== null && value !== undefined);
  return value;
}

export function fixtureSuccess(value: unknown) {
  const reply = fixtureObject(value);
  assert.equal(reply.ok, true, JSON.stringify(reply));
  return reply.value;
}

// Optional native fixtures use their own CLI/library, never the application's adapter.
export function ownedFixtureCommand(
  { cli, library, output, catalogPath }: OwnedFixtureContext,
  spawn: FixtureSpawn = spawnCommand,
): FixtureCommand {
  return (args: readonly string[], selectedLibrary = library, { timeoutMs } = {}) => {
    const timeout =
      timeoutMs === undefined
        ? args[0] === "adopt" || args[0] === "remove"
          ? 60_000
          : 15_000
        : timeoutMs;
    assert.ok(
      Number.isSafeInteger(timeout) && timeout > 0,
      "Fixture timeout must be a finite positive integer",
    );
    const started = performance.now();
    let result: FixtureProcessResult | undefined;
    try {
      result = spawn(cli, ["--library", selectedLibrary, "--json", "--non-interactive", ...args], {
        encoding: "utf8",
        windowsHide: true,
        timeout,
        // The complete embedded catalog exceeds Node's default 1 MiB buffer.
        ...(args[0] === "catalog" && args[1] === "list" ? { maxBuffer: 8 * 1024 * 1024 } : {}),
        env: {
          ...process.env,
          ...(catalogPath === undefined ? {} : { PORTCOVE_QUALIFICATION_CATALOG: catalogPath }),
          PORTCOVE_PREFERENCES: path.join(output, "preferences.json"),
        },
      });
      if (result.error) throw new Error(errorMessage(result.error), { cause: result.error });
    } catch (error) {
      const observation = {
        family: args[0],
        timeout_ms: timeout,
        elapsed_ms: Math.round(performance.now() - started),
        status: result?.status,
        signal: result?.signal,
        stdout: result?.stdout?.slice(0, 1_000),
        stderr: result?.stderr?.slice(0, 1_000),
        process_result_available: result !== undefined,
      };
      throw new Error(
        `Owned fixture CLI failed: ${errorMessage(error)}; ${JSON.stringify(observation)}`,
        {
          cause: result?.error ?? error,
        },
      );
    }
    assert.equal(result.status, 0, result.stderr || result.stdout || undefined);
    assert.equal(typeof result.stdout, "string", "Owned CLI response must contain JSON text");
    assert(typeof result.stdout === "string");
    const response: unknown = JSON.parse(result.stdout);
    assert(isRecord(response), "Owned CLI response must be an object");
    assert.equal(response.ok, true);
    return response.data;
  };
}

export function installedPreservationWitness(command: (args: readonly string[]) => PortStatus) {
  for (const portId of ["opengoal-jak1", "opengoal-jak2"]) {
    const install = command(["status", portId]).active;
    if (install) return { portId, install };
  }
  assert.fail("an installed owned game is required for preservation proof");
}
