import { isRecord } from "../../../scripts/runtime-values.mts";
import type { TransportOutputs, LibraryIdentity } from "../src/transport-types.generated.d.ts";
interface DiagnosticLibrary {
  bootstrap: Pick<
    TransportOutputs["desktop_bootstrap_status"],
    "ready" | "error" | "generation" | "library_root"
  >;
  identity: Pick<LibraryIdentity, "id" | "root">;
}
interface StartupNetworkReport {
  completed: boolean;
  explicit_auth_calls: number;
  scope: string;
  limitations: string;
  before_alert_count?: number;
  after_alert_count?: number;
  auth_status?: { ok: true } | { ok: false; code: string };
  auth_duration_ms?: number;
  library?: DiagnosticLibrary;
  coverage_failure?: string;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isRecord(value), "Native response coverage is missing");
  return value;
}
import assert from "node:assert/strict";
import path from "node:path";

const codes = new Set([
  "usage",
  "unsupported",
  "not_found",
  "source_invalid",
  "network",
  "verification",
  "install",
  "state",
  "launch",
  "conflict",
  "cancelled",
]);

// Never retain success payloads, credentials, raw errors or extensible context.
function startupNetworkReply(value: unknown): NonNullable<StartupNetworkReport["auth_status"]> {
  const reply = object(value);
  assert.equal(typeof reply?.ok, "boolean", "Native response coverage is missing");
  if (reply.ok) return { ok: true };
  const code = isRecord(reply.error) ? reply.error.code : undefined;
  return { ok: false, code: typeof code === "string" && codes.has(code) ? code : "unknown" };
}

export async function observeStartupNetwork({
  invoke: invokeRaw,
  readAlerts,
}: {
  invoke: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  readAlerts: () => Promise<unknown>;
}) {
  const invoke = async (name: string, args?: Record<string, unknown>) =>
    object(await invokeRaw(name, args));
  const report: StartupNetworkReport = {
    completed: false,
    explicit_auth_calls: 0,
    scope: "Current read-only diagnostic; unchanged background startup requests remain distinct.",
    limitations:
      "No historical banner attribution, causal repair, healthy-network or product acceptance.",
  };
  let phase = "before-library";
  async function libraryState() {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    const bootstrapValue = object(bootstrap.value);
    assert.equal(bootstrapValue.ready, true);
    assert.equal(bootstrapValue.error, null);
    const generation = bootstrapValue.generation;
    assert.ok(typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0);
    const identity = await invoke("get_library_identity", {
      generation,
    });
    assert.equal(identity.ok, true);
    const identityValue = object(identity.value);
    const id = identityValue.id;
    const root = identityValue.root;
    const libraryRoot = bootstrapValue.library_root;
    assert.ok(typeof id === "string" && id.length > 0);
    assert.ok(typeof root === "string");
    assert.ok(typeof libraryRoot === "string");
    assert.equal(
      path.toNamespacedPath(path.resolve(root)),
      path.toNamespacedPath(path.resolve(libraryRoot)),
    );
    return {
      bootstrap: {
        ...bootstrapValue,
        ready: true,
        error: null,
        generation,
        library_root: libraryRoot,
      },
      identity: { ...identityValue, id, root },
    };
  }
  async function alerts() {
    const count = await readAlerts();
    assert.ok(typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
    return count;
  }
  try {
    const before = await libraryState();
    phase = "before-alerts";
    report.before_alert_count = await alerts();
    phase = "explicit-auth-status";
    report.explicit_auth_calls = 1;
    const started = performance.now();
    report.auth_status = startupNetworkReply(await invoke("get_github_auth_status"));
    report.auth_duration_ms = performance.now() - started;
    phase = "after-alerts";
    report.after_alert_count = await alerts();
    phase = "after-library";
    const after = await libraryState();
    assert.deepEqual(after, before, "Read-only observation changed the ready library");
    report.library = before;
    report.completed = true;
  } catch {
    // The phase identifies missing coverage without copying a transport secret.
    report.coverage_failure = phase;
  }
  return report;
}
