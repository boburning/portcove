import assert from "node:assert/strict";
import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface NativeAccountBinding {
  invocation_id: string;
  configuration_sha256: string;
  helper_sha256: string;
  broker_pid: number;
  broker_created_filetime: string;
  capture_root: string;
  powershell: { path: string; sha256: string };
}
export interface NativeAccountLaunch {
  executable: string;
  sha256: string;
  arguments: string[];
  directory: string;
  environment: Record<string, string>;
  nsis: boolean;
}
type Operation = "start" | "observe" | "window" | "close" | "stop" | "readback" | "finish";
export type NativeAccountTransport = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;
const client = fileURLToPath(new URL("./native-qualification-account-client.ps1", import.meta.url));
function object(raw: unknown): Record<string, unknown> {
  assert.ok(raw !== null && typeof raw === "object" && !Array.isArray(raw));
  return raw as Record<string, unknown>;
}
function digest(raw: unknown): asserts raw is string {
  assert.ok(typeof raw === "string" && /^[a-f0-9]{64}$/u.test(raw));
}
function bytes(file: string, bound: number) {
  const before = lstatSync(file);
  assert.ok(before.isFile() && !before.isSymbolicLink() && before.nlink === 1);
  assert.ok(before.size > 0 && before.size <= bound);
  const result = readFileSync(file);
  const after = lstatSync(file);
  assert.ok(result.length === before.size && after.dev === before.dev && after.ino === before.ino);
  assert.ok(after.size === before.size && after.mtimeMs === before.mtimeMs);
  return result;
}
function hash(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}

/** IPC plumbing only. This object never brands native acceptance or a report. */
export class NativeAccountClient {
  readonly #binding: NativeAccountBinding;
  readonly #spawn: NativeAccountTransport;
  #ambiguous = false;
  readonly #failures: { operation: Operation; id: string; sequence: number; message: string }[] =
    [];
  get failures() {
    return structuredClone(this.#failures);
  }
  constructor(binding: NativeAccountBinding, transport: NativeAccountTransport = spawnSync) {
    const retained = structuredClone(binding);
    digest(retained.invocation_id);
    digest(retained.configuration_sha256);
    digest(retained.helper_sha256);
    digest(retained.powershell.sha256);
    assert.ok(Number.isSafeInteger(retained.broker_pid) && retained.broker_pid > 0);
    assert.match(retained.broker_created_filetime, /^[1-9][0-9]+$/u);
    assert.ok(path.isAbsolute(retained.capture_root) && path.isAbsolute(retained.powershell.path));
    this.#binding = retained;
    this.#spawn = transport;
  }
  /** Retained owner state is recovery evidence, never imported stage acceptance. */
  readState() {
    const binding = this.#binding;
    const state = object(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes(path.join(binding.capture_root, "bridge-state.json"), 65536),
        ),
      ),
    );
    assert.equal(state.schema_version, 1);
    assert.equal(state.authority, "none");
    assert.equal(state.invocation_id, binding.invocation_id);
    assert.equal(state.configuration_sha256, binding.configuration_sha256);
    assert.equal(state.broker_pid, binding.broker_pid);
    assert.equal(state.broker_created_filetime, binding.broker_created_filetime);
    assert.ok(Number.isSafeInteger(state.sequence) && Number(state.sequence) >= 0);
    assert.ok(["prepared", "running", "failed", "settled"].includes(String(state.phase)));
    return structuredClone(state);
  }
  invoke(
    operation: Operation,
    id: string,
    launch: NativeAccountLaunch | null = null,
    target: { pid: number; started_filetime: string } | null = null,
  ): unknown {
    assert.match(id, /^[a-z][a-z0-9-]{0,63}$/u);
    assert.equal(operation === "start", launch !== null);
    if (launch) {
      const names = new Set([
        "SystemRoot",
        "WINDIR",
        "PATH",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "APPDATA",
        "LOCALAPPDATA",
        "TEMP",
        "TMP",
        "PORTCOVE_LIBRARY",
        "PORTCOVE_PREFERENCES",
        "PORTCOVE_APPLICATION_UPDATE_PREFERENCES",
        "PORTCOVE_APPLICATION_UPDATE_SCHEDULE",
        "PORTCOVE_APPLICATION_UPDATE_STAGING",
        "WEBVIEW2_USER_DATA_FOLDER",
        "PORTCOVE_QUALIFICATION_CATALOG",
        "PORTCOVE_QUALIFICATION_CHECKPOINT",
        "PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL",
        "TAURI_WEBDRIVER_PORT",
        "PORTCOVE_QUALIFICATION_STEAM_CLIENT_STATE",
      ]);
      assert.ok(
        Object.keys(launch.environment).every((name) => names.has(name)),
        "Forbidden native environment field before transport",
      );
    }
    assert.ok(
      !this.#ambiguous || ["observe", "readback", "finish"].includes(operation),
      "Native recovery required; no repeated effect",
    );
    const state = this.readState();
    assert.ok(
      state.phase === "prepared" || state.phase === "running",
      "Native attempt already terminal",
    );
    const sequence = Number(state.sequence) + 1;
    assert.ok(sequence <= 512, "Native command limit reached");
    const request = JSON.stringify({
      schema_version: 1,
      invocation_id: this.#binding.invocation_id,
      sequence,
      operation,
      id,
      launch,
      target,
    });
    assert.ok(Buffer.byteLength(request) <= 24000, "Native request exceeds client bound");
    const binding = this.#binding;
    assert.equal(
      hash(bytes(binding.powershell.path, 128 * 1024 * 1024)),
      binding.powershell.sha256,
      "Native client runtime changed",
    );
    try {
      const result = this.#spawn(
        binding.powershell.path,
        [
          "-NoProfile",
          "-NonInteractive",
          "-File",
          client,
          "-InvocationId",
          binding.invocation_id,
          "-BrokerPid",
          String(binding.broker_pid),
          "-BrokerCreatedFileTime",
          binding.broker_created_filetime,
          "-ExpectedHelperSha256",
          binding.helper_sha256,
          "-RequestBase64",
          Buffer.from(request).toString("base64"),
        ],
        {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 128 * 1024,
          windowsHide: true,
          env: {
            SystemRoot: process.env.SystemRoot,
            WINDIR: process.env.SystemRoot,
            PATH: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
            TEMP: process.env.TEMP,
            TMP: process.env.TMP,
          },
        },
      );
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.status, 0, String(result.stderr));
      const reply = object(JSON.parse(String(result.stdout)));
      assert.equal(reply.schema_version, 1);
      assert.equal(reply.invocation_id, binding.invocation_id);
      assert.equal(reply.sequence, sequence);
      assert.equal(reply.broker_pid, binding.broker_pid);
      return structuredClone(reply.value);
    } catch (error) {
      this.#ambiguous = true;
      this.#failures.push({ operation, id, sequence, message: String(error) });
      throw new Error(
        "Native command outcome ambiguous; retained evidence and explicit recovery required",
        { cause: error },
      );
    }
  }
}
