import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  NativeAccountClient,
  type NativeAccountTransport,
} from "./native-qualification-account-client.mts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "native-account-client-"));
  const runtime = path.join(root, "inert-runtime.exe");
  writeFileSync(runtime, "not an executable; injected transport only");
  const binding = {
    invocation_id: "a".repeat(64),
    configuration_sha256: "b".repeat(64),
    helper_sha256: "c".repeat(64),
    broker_pid: 123,
    broker_created_filetime: "134000000000000000",
    capture_root: root,
    powershell: {
      path: runtime,
      sha256: createHash("sha256")
        .update("not an executable; injected transport only")
        .digest("hex"),
    },
  };
  const state = {
    schema_version: 1,
    authority: "none",
    invocation_id: binding.invocation_id,
    configuration_sha256: binding.configuration_sha256,
    broker_pid: binding.broker_pid,
    broker_created_filetime: binding.broker_created_filetime,
    sequence: 0,
    phase: "prepared",
  };
  const save = () => writeFileSync(path.join(root, "bridge-state.json"), JSON.stringify(state));
  save();
  return {
    root,
    binding,
    state,
    save,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

void test("native client binds exact owner state and scrubs subprocess credentials", () => {
  const f = fixture();
  try {
    let calls = 0;
    const transport: NativeAccountTransport = (command, args, options) => {
      calls++;
      assert.equal(command, f.binding.powershell.path);
      assert.ok(
        Object.keys(options.env ?? {}).every((key) =>
          ["SystemRoot", "WINDIR", "PATH", "TEMP", "TMP"].includes(key),
        ),
      );
      const encoded = args[args.indexOf("-RequestBase64") + 1];
      const request = JSON.parse(Buffer.from(String(encoded), "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
      assert.equal(request.operation, "observe");
      assert.equal(request.sequence, 1);
      return {
        pid: 1,
        output: [],
        status: 0,
        signal: null,
        stderr: "",
        stdout: JSON.stringify({
          schema_version: 1,
          invocation_id: f.binding.invocation_id,
          sequence: 1,
          broker_pid: f.binding.broker_pid,
          value: { scope: "fixture only" },
        }),
      };
    };
    const client = new NativeAccountClient(f.binding, transport);
    assert.deepEqual(client.invoke("observe", "driver"), { scope: "fixture only" });
    f.state.configuration_sha256 = "d".repeat(64);
    f.save();
    assert.throws(() => client.invoke("observe", "driver"));
    assert.equal(calls, 1);
  } finally {
    f.dispose();
  }
});

void test("lost native command response remains ambiguous and cannot repeat effects", () => {
  const f = fixture();
  try {
    let calls = 0;
    const transport: NativeAccountTransport = () => {
      calls++;
      return {
        pid: 1,
        output: [],
        status: 1,
        signal: null,
        stdout: "",
        stderr: "retained ambiguous response",
      };
    };
    const client = new NativeAccountClient(f.binding, transport);
    assert.throws(() => client.invoke("stop", "driver"), /outcome ambiguous/u);
    assert.throws(() => client.invoke("stop", "driver"), /recovery required/u);
    assert.equal(calls, 1);
    assert.equal(client.failures.length, 1);
    const detached = client.failures;
    detached.length = 0;
    assert.equal(client.failures.length, 1);
    assert.throws(() => client.invoke("readback", "driver"), /outcome ambiguous/u);
    assert.equal(calls, 2);
  } finally {
    f.dispose();
  }
});

void test("changed native runtime and forbidden environment refuse before subprocess", () => {
  const f = fixture();
  try {
    const transport: NativeAccountTransport = () => {
      throw new Error("must not invoke subprocess");
    };
    const client = new NativeAccountClient(f.binding, transport);
    assert.throws(
      () =>
        client.invoke("start", "driver", {
          executable: f.binding.powershell.path,
          sha256: f.binding.powershell.sha256,
          arguments: [],
          directory: f.root,
          environment: { GH_TOKEN: "inert-forbidden" },
          nsis: false,
        }),
      /Forbidden native environment/u,
    );
    writeFileSync(f.binding.powershell.path, "changed");
    assert.throws(() => client.invoke("observe", "driver"), /runtime changed/u);
  } finally {
    f.dispose();
  }
});
