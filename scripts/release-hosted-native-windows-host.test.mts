import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectHostedNativeWindowsHost,
  inspectHostedWindowsOperatingSystem,
} from "./release-hosted-native-windows-host.mts";
import { hostedWindowsContinuityPlatform } from "./release-native-qualification-contract.mts";
const server = {
  caption: "Microsoft Windows Server 2022 Datacenter",
  version: "10.0.20348.4000",
  build_number: "20348",
  display_version: "21H2",
  product_type: 3,
};
const client = {
  caption: "Microsoft Windows 11 Pro",
  version: "10.0.26200.1000",
  build_number: "26200",
  display_version: "26H2",
  product_type: 1,
};
const nonce = "a".repeat(64);
const host = (os: typeof server) => ({
  schema_version: 1,
  nonce,
  architecture: "x86_64",
  broker_sid: "S-1-5-21-1-2-3-1001",
  machine_id_sha256: "b".repeat(64),
  os,
});
void test("Windows host observations keep Server continuity distinct from the client floor", () => {
  const observed = inspectHostedNativeWindowsHost(
    host(server),
    nonce,
    hostedWindowsContinuityPlatform,
    "10.0.26200",
  );
  assert.equal(observed.os.version, server.version);
  assert.equal(observed.authority, "none");
  assert.ok(Object.isFrozen(observed) && Object.isFrozen(observed.os));
  assert.throws(() =>
    inspectHostedNativeWindowsHost(host(server), nonce, "windows-11-26h2-x64", "10.0.26200"),
  );
  assert.throws(() =>
    inspectHostedNativeWindowsHost(
      host(client),
      nonce,
      hostedWindowsContinuityPlatform,
      "10.0.26200",
    ),
  );
  for (const version of ["11.0.26200", "10.26200"]) {
    const malformed = host({ ...client, version });
    assert.throws(() =>
      inspectHostedNativeWindowsHost(malformed, nonce, "windows-11-26h2-x64", "10.0.26200"),
    );
  }
  assert.equal(
    inspectHostedNativeWindowsHost(host(client), nonce, "windows-11-26h2-x64", "10.0.26200").os
      .version,
    client.version,
  );
  assert.throws(() =>
    inspectHostedNativeWindowsHost(host(client), nonce, "windows-11-26h2-x64", "10.0.26300"),
  );
});
void test("Windows host nonce, principal, machine, architecture and closed OS evidence cannot drift", () => {
  for (const change of [
    (value: ReturnType<typeof host>) => {
      value.nonce = "c".repeat(64);
    },
    (value: ReturnType<typeof host>) => {
      value.machine_id_sha256 = "unknown";
    },
    (value: ReturnType<typeof host>) => {
      value.broker_sid = "S-1-5-18";
    },
    (value: ReturnType<typeof host>) => {
      value.broker_sid = "S-1-5-21-1-2-3-4294967296";
    },
    (value: ReturnType<typeof host>) => {
      value.broker_sid = "S-1-5-21-01-2-3-1001";
    },
    (value: ReturnType<typeof host>) => {
      value.architecture = "arm64";
    },
    (value: ReturnType<typeof host>) => {
      value.os.product_type = 1;
    },
    (value: ReturnType<typeof host>) => {
      value.os.build_number = "26200";
    },
    (value: ReturnType<typeof host>) => {
      value.os.caption = "Microsoft Windows Server 2025 Datacenter";
    },
    (value: ReturnType<typeof host>) => {
      value.os.display_version = "26H2";
    },
  ]) {
    const input = host({ ...server });
    change(input);
    assert.throws(() =>
      inspectHostedNativeWindowsHost(input, nonce, hostedWindowsContinuityPlatform, "10.0.26200"),
    );
  }
  assert.throws(() =>
    inspectHostedWindowsOperatingSystem(
      { ...server, extra: true },
      hostedWindowsContinuityPlatform,
      server.version,
      "10.0.26200",
    ),
  );
  assert.throws(() =>
    inspectHostedWindowsOperatingSystem(
      server,
      hostedWindowsContinuityPlatform,
      "10.0.20348.1",
      "10.0.26200",
    ),
  );
  assert.throws(() =>
    inspectHostedWindowsOperatingSystem(
      server,
      hostedWindowsContinuityPlatform,
      server.version,
      "unknown",
    ),
  );
});
