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
export function startupNetworkReply(reply) {
  assert.equal(typeof reply?.ok, "boolean", "Native response coverage is missing");
  if (reply.ok) return { ok: true };
  return { ok: false, code: codes.has(reply.error?.code) ? reply.error.code : "unknown" };
}

export async function observeStartupNetwork({ invoke, readAlerts }) {
  const report = {
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
    assert.equal(bootstrap.value.ready, true);
    assert.equal(bootstrap.value.error, null);
    assert.ok(Number.isSafeInteger(bootstrap.value.generation) && bootstrap.value.generation > 0);
    const identity = await invoke("get_library_identity", {
      generation: bootstrap.value.generation,
    });
    assert.equal(identity.ok, true);
    assert.ok(typeof identity.value?.id === "string" && identity.value.id.length > 0);
    assert.equal(typeof identity.value.root, "string");
    assert.equal(typeof bootstrap.value.library_root, "string");
    assert.equal(
      path.toNamespacedPath(path.resolve(identity.value.root)),
      path.toNamespacedPath(path.resolve(bootstrap.value.library_root)),
    );
    return { bootstrap: bootstrap.value, identity: identity.value };
  }
  async function alerts() {
    const count = await readAlerts();
    assert.ok(Number.isSafeInteger(count) && count >= 0);
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
