/** Source/runtime/dependency/candidate joins only. No account or GUI authority. */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { requireActualHostedNativeParentSource } from "./release-hosted-native-parent.mts";
import {
  requireActualHostedWindowsDependencies,
  requireActualHostedWindowsDependencyParent,
} from "./release-hosted-native-windows-source.mts";
import {
  acquireActualHostedNativeCandidate,
  requireActualHostedNativeCandidate,
} from "./release-hosted-native-candidate.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { assertControllerBootstrapEnvironment } from "./release-controller-job-bootstrap.mts";

const attempts = new WeakSet<object>();
const installations = new WeakMap<
  object,
  { dependencies: object; candidate: object; parent: object }
>();

export async function requireActualHostedWindowsInstallation(receipt: object) {
  assertControllerBootstrapEnvironment();
  const retained = installations.get(receipt);
  assert.ok(retained, "original hosted Windows installation required");
  try {
    const dependencies = await requireActualHostedWindowsDependencies(retained.dependencies);
    assert.equal(dependencies.parent, retained.parent);
    const parent = await requireActualHostedNativeParentSource(retained.parent);
    const candidate = await withCoordinatorDeadline(parent.deadline, () =>
      requireActualHostedNativeCandidate(retained.candidate),
    );
    assert.equal(candidate.parent_source, retained.parent);
    assert.equal(candidate.platform_label, "windows-x86_64");
    assert.equal(candidate.stage, "payload-signing");
    await requireActualHostedWindowsDependencies(retained.dependencies);
    parent.recheck();
    assertControllerBootstrapEnvironment();
    assert.ok(
      installations.get(receipt) === retained && performance.now() < parent.deadline,
      "original Windows installation stopped or expired",
    );
    return Object.freeze({
      ...dependencies,
      dependencies: retained.dependencies,
      candidate: retained.candidate,
    });
  } catch (error) {
    installations.delete(receipt);
    throw error;
  }
}

export async function prepareActualHostedWindowsInstallation(dependenciesReceipt: object) {
  const started = performance.now();
  assert.ok(process.platform === "win32" && process.arch === "x64");
  assertControllerBootstrapEnvironment();
  const original = await requireActualHostedWindowsDependencyParent(dependenciesReceipt);
  const deadline = Math.min(started + 90000, original.deadline - 210000);
  return withCoordinatorDeadline(deadline, async () => {
    const dependencies = await requireActualHostedWindowsDependencies(dependenciesReceipt);
    assert.equal(dependencies.parent, original.parent);
    const parent = await requireActualHostedNativeParentSource(dependencies.parent);
    assert.equal(parent.platform_label, "windows-x86_64");
    assert.equal(parent.stage, "payload-signing");
    assert.equal(parent.configuration.purpose, "application");
    assert.ok(!attempts.has(dependencies.parent), "one Windows candidate join; retain and recover");
    attempts.add(dependencies.parent);
    assert.ok(performance.now() < deadline, "original Windows candidate preflight expired");
    parent.recheck();
    assertControllerBootstrapEnvironment();
    const candidate = await acquireActualHostedNativeCandidate(dependencies.parent);
    const observed = await requireActualHostedNativeCandidate(candidate);
    assert.equal(observed.parent_source, dependencies.parent);
    assert.equal(observed.platform_label, parent.platform_label);
    assert.equal(observed.stage, parent.stage);
    await requireActualHostedWindowsDependencies(dependenciesReceipt);
    await requireActualHostedNativeParentSource(dependencies.parent);
    parent.recheck();
    assertControllerBootstrapEnvironment();
    assert.ok(
      performance.now() < deadline,
      "Windows candidate must preserve capture/recovery reserve",
    );
    const receipt = Object.freeze({
      kind: "original-hosted-windows-installation",
      authority: "none",
    });
    installations.set(receipt, {
      dependencies: dependenciesReceipt,
      candidate,
      parent: dependencies.parent,
    });
    return receipt;
  });
}
