import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import {
  NativeAccountClient,
  type NativeAccountBinding,
} from "../../../scripts/native-qualification-account-client.mts";
import {
  readNativeSessionObservation,
  readNativeProcessSnapshot,
  type CapturedNativeProcess,
  type NativeSessionMode,
  type NativeSessionObservations,
} from "./desktop-owned-native-session.mts";

interface DesktopAccountBinding extends NativeAccountBinding {
  account_sid: string;
  profile_root: string;
  work_root: string;
  controller_root: string;
  desktop_tools: {
    node: { path: string; sha256: string };
    tauri_driver: { path: string; sha256: string };
    webview_driver: { path: string; sha256: string };
  };
}
function object(raw: unknown): Record<string, unknown> {
  assert.ok(raw !== null && typeof raw === "object" && !Array.isArray(raw));
  return raw as Record<string, unknown>;
}
function bytes(file: string, limit: number) {
  const before = lstatSync(file);
  assert.ok(
    before.isFile() &&
      !before.isSymbolicLink() &&
      before.nlink === 1 &&
      before.size > 0 &&
      before.size <= limit,
  );
  const result = readFileSync(file);
  const after = lstatSync(file);
  assert.ok(
    after.ino === before.ino &&
      after.dev === before.dev &&
      after.size === before.size &&
      after.mtimeMs === before.mtimeMs &&
      result.length === before.size,
  );
  return result;
}
function sha(value: Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function within(root: string, file: string) {
  const relative = path.relative(root, file);
  assert.ok(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "Native path must remain below its configured root",
  );
}
function same(a: CapturedNativeProcess, b: CapturedNativeProcess) {
  return (
    a.pid === b.pid &&
    a.started_filetime === b.started_filetime &&
    path.resolve(a.path).toLowerCase() === path.resolve(b.path).toLowerCase()
  );
}
type NativeAccountDriverProcess = Pick<
  ChildProcess,
  "pid" | "exitCode" | "signalCode" | "stdout" | "stderr"
>;

/** A view of an actual broker root, not a local ChildProcess or acceptance receipt. */
export class AccountDriverView extends EventEmitter implements NativeAccountDriverProcess {
  readonly signalCode = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  readonly identity: CapturedNativeProcess;
  readonly rootId: string;
  readonly #session: DesktopNativeAccountSession;
  constructor(session: DesktopNativeAccountSession, id: string, identity: CapturedNativeProcess) {
    super();
    this.#session = session;
    this.rootId = id;
    this.identity = identity;
    this.pid = identity.pid;
    queueMicrotask(() => this.emit("spawn"));
  }
  get exitCode(): number | null {
    return this.#session.observeRoot(this).exit_code;
  }
}

/** Fixed harness adapter. It never creates an account or brands native acceptance. */
export class DesktopNativeAccountSession {
  readonly #client: NativeAccountClient;
  readonly #binding: DesktopAccountBinding;
  #sequence = 0;
  #current: AccountDriverView | undefined;
  readonly #stopped = new Set<string>();
  constructor(binding: DesktopAccountBinding, client = new NativeAccountClient(binding)) {
    this.#binding = structuredClone(binding);
    this.#client = client;
    assert.equal(process.platform, "win32");
    assert.equal(
      path
        .resolve(binding.controller_root, "apps/desktop/scripts/desktop-native-account-session.mts")
        .toLowerCase(),
      fileURLToPath(import.meta.url).toLowerCase(),
      "Account backend must use the protected controller root",
    );
    assert.match(binding.account_sid, /^S-1-5-21-[0-9-]+$/u);
    for (const name of ["profile_root", "work_root", "capture_root"] as const)
      assert.ok(path.isAbsolute(binding[name]));
    assert.notEqual(
      path.resolve(binding.work_root).toLowerCase(),
      path.resolve(binding.capture_root).toLowerCase(),
    );
    assert.ok(
      !path
        .resolve(binding.capture_root)
        .toLowerCase()
        .startsWith(path.resolve(binding.work_root).toLowerCase() + path.sep),
    );
    this.verifyTools();
  }
  verifyTools() {
    assert.deepEqual(
      Object.keys(this.#binding.desktop_tools).sort(),
      ["node", "tauri_driver", "webview_driver"].sort(),
    );
    for (const tool of Object.values(this.#binding.desktop_tools)) {
      assert.deepEqual(Object.keys(tool).sort(), ["path", "sha256"]);
      assert.ok(path.isAbsolute(tool.path));
      assert.match(tool.sha256, /^[a-f0-9]{64}$/u);
      assert.equal(
        sha(bytes(tool.path, 128 * 1024 * 1024)),
        tool.sha256,
        "Qualified desktop tool changed",
      );
    }
    assert.equal(
      path.resolve(this.#binding.desktop_tools.node.path).toLowerCase(),
      path.resolve(process.execPath).toLowerCase(),
      "Desktop assertion runtime differs from fixed binding",
    );
  }
  drivers() {
    this.verifyTools();
    return {
      tauri_driver: this.#binding.desktop_tools.tauri_driver.path,
      webview_driver: this.#binding.desktop_tools.webview_driver.path,
    };
  }
  static open(file: string, expected: string) {
    assert.match(expected, /^[a-f0-9]{64}$/u);
    const value = bytes(file, 16384);
    assert.equal(sha(value), expected, "Native account binding changed");
    const raw = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)));
    assert.deepEqual(
      Object.keys(raw).sort(),
      [
        "invocation_id",
        "configuration_sha256",
        "helper_sha256",
        "broker_pid",
        "broker_created_filetime",
        "capture_root",
        "account_sid",
        "profile_root",
        "work_root",
        "powershell",
        "desktop_tools",
        "controller_root",
      ].sort(),
    );
    return new DesktopNativeAccountSession(raw as unknown as DesktopAccountBinding);
  }
  runtimeRoot(output: string) {
    within(this.#binding.capture_root, output);
    return path.join(this.#binding.work_root, `desktop-${path.basename(output)}`);
  }
  environment(runtime: NodeJS.ProcessEnv): Record<string, string> {
    const binding = this.#binding,
      profile = binding.profile_root,
      drive = path.parse(profile).root;
    const system = process.env.SystemRoot;
    assert.ok(system && path.isAbsolute(system));
    const result: Record<string, string> = {
      SystemRoot: system,
      WINDIR: system,
      PATH: path.join(system, "System32"),
      USERPROFILE: profile,
      HOMEDRIVE: drive.replace(/\\$/u, ""),
      HOMEPATH: profile.slice(drive.length - 1),
      APPDATA: path.join(binding.work_root, "APPDATA"),
      LOCALAPPDATA: path.join(binding.work_root, "LOCALAPPDATA"),
      TEMP: path.join(binding.work_root, "TEMP"),
      TMP: path.join(binding.work_root, "TMP"),
    };
    const allowed = new Set([
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
    for (const [name, value] of Object.entries(runtime)) {
      assert.ok(
        allowed.has(name) && typeof value === "string",
        `Unreviewed account runtime field ${name}`,
      );
      result[name] = value;
    }
    return result;
  }
  start(executable: string, args: string[], directory: string, environment: NodeJS.ProcessEnv) {
    this.verifyTools();
    assert.equal(
      path.resolve(executable).toLowerCase(),
      path.resolve(this.#binding.desktop_tools.tauri_driver.path).toLowerCase(),
      "Only the qualified driver root may launch here",
    );
    assert.equal(args.length, 6);
    assert.equal(args[0], "--port");
    assert.match(args[1] ?? "", /^[1-9][0-9]{0,4}$/u);
    assert.equal(args[2], "--native-port");
    assert.match(args[3] ?? "", /^[1-9][0-9]{0,4}$/u);
    assert.equal(args[4], "--native-driver");
    assert.equal(args[5], this.#binding.desktop_tools.webview_driver.path);
    assert.ok(
      !this.#current || this.#stopped.has(this.#current.rootId),
      "Previous account driver must settle before restart",
    );
    within(this.#binding.work_root, directory);
    const id = `desktop-driver-${++this.#sequence}`;
    const raw = this.#client.invoke("start", id, {
      executable,
      sha256: sha(bytes(executable, 512 * 1024 * 1024)),
      arguments: args,
      directory,
      environment: this.environment(environment),
      nsis: false,
    });
    const identity = readNativeProcessSnapshot({
      captured_at: new Date().toISOString(),
      driver: raw,
      application_pid: null,
      processes: [raw],
    }).driver;
    assert.equal(path.resolve(identity.path).toLowerCase(), path.resolve(executable).toLowerCase());
    const view = new AccountDriverView(this, id, identity);
    this.#current = view;
    return view;
  }
  observeRoot(view: AccountDriverView) {
    assert.equal(view, this.#current);
    const raw = object(this.#client.invoke("observe", view.rootId));
    assert.equal(typeof raw.exited, "boolean");
    assert.ok(
      raw.exit_code === null ||
        (typeof raw.exit_code === "number" && Number.isSafeInteger(raw.exit_code)),
    );
    const snapshot = readNativeProcessSnapshot({
      captured_at: new Date().toISOString(),
      driver: view.identity,
      application_pid: null,
      processes: raw.processes,
    });
    const ids = new Set<number>();
    for (const item of snapshot.processes) {
      assert.ok(!ids.has(item.pid));
      ids.add(item.pid);
    }
    if (!raw.exited)
      assert.ok(
        snapshot.processes.some((item) => same(item, view.identity)),
        "Live account driver identity changed",
      );
    return {
      exited: raw.exited,
      exit_code: raw.exit_code,
      processes: snapshot.processes,
    };
  }
  readOwnedApplicationWindowTitle(target: CapturedNativeProcess) {
    const view = this.#current;
    assert.ok(view, "No owned account driver");
    const before = this.observeRoot(view);
    assert.ok(before.processes.some((member) => same(member, target)));
    const value = object(
      this.#client.invoke("window", view.rootId, null, {
        pid: target.pid,
        started_filetime: target.started_filetime,
      }),
    );
    assert.deepEqual(Object.keys(value), ["title"]);
    assert.ok(typeof value.title === "string" && value.title.length <= 1024);
    assert.ok(this.observeRoot(view).processes.some((member) => same(member, target)));
    return value.title;
  }
  observe<Mode extends NativeSessionMode>(
    mode: Mode,
    file: string,
    application: string,
  ): NativeSessionObservations[Mode] {
    const view = this.#current;
    assert.ok(view, "No owned account driver");
    within(this.#binding.capture_root, file);
    const now = new Date().toISOString(),
      current = this.observeRoot(view);
    const applications = current.processes.filter(
      (item) => path.resolve(item.path).toLowerCase() === path.resolve(application).toLowerCase(),
    );
    assert.ok(applications.length <= 1, "Multiple application roots cannot be guessed");
    let result: unknown;
    if (mode === "Snapshot" || mode === "SnapshotDriver" || mode === "SnapshotDriverTree") {
      if (mode === "Snapshot")
        assert.equal(applications.length, 1, "Actual account application root required");
      result = {
        captured_at: now,
        driver: view.identity,
        application_pid: applications[0]?.pid ?? null,
        processes: mode === "SnapshotDriver" ? [view.identity] : current.processes,
      };
      writeFileSync(file, JSON.stringify(result) + "\n", { flag: "wx" });
    } else {
      const retained = readNativeProcessSnapshot(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(file, 65536))),
      );
      assert.ok(same(retained.driver, view.identity), "Snapshot belongs to another account launch");
      for (const item of retained.processes) {
        const live = current.processes.find((record) => record.pid === item.pid);
        if (live) assert.ok(same(live, item), "Snapshot process identity changed");
      }
      if (mode === "Observe")
        result = {
          observed_at: now,
          processes: retained.processes.map((item) => ({
            ...item,
            state: current.processes.some((live) => same(live, item)) ? "running" : "exited",
          })),
        };
      else if (mode === "RequestClose") {
        const app = retained.processes.find((item) => item.pid === retained.application_pid);
        assert.ok(app);
        assert.ok(
          current.processes.some((item) => same(item, app)),
          "Owned application already exited before close",
        );
        const close = object(
          this.#client.invoke("close", view.rootId, null, {
            pid: app.pid,
            started_filetime: app.started_filetime,
          }),
        );
        assert.equal(close.accepted, true);
        result = {
          requested_at: now,
          application_pid: app.pid,
          started_filetime: app.started_filetime,
          method: "identity-bound-native-main-window-close-request",
          message_sent: true,
        };
      } else if (mode === "Wait") {
        const started = Date.now();
        let latest = current;
        while (
          retained.processes.some((item) => latest.processes.some((live) => same(live, item)))
        ) {
          assert.ok(
            Date.now() - started < 5000,
            "Account snapshot remains running after bounded wait",
          );
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
          latest = this.observeRoot(view);
        }
        result = {
          exited_at: new Date().toISOString(),
          observed_processes: retained.processes.length,
          wait_ms: Date.now() - started,
        };
      } else if (mode === "StopDriver") {
        const operation = this.#stopped.has(view.rootId) ? "readback" : "stop";
        this.#stopped.add(view.rootId); // latch before the effect
        const stopped = object(this.#client.invoke(operation, view.rootId));
        assert.equal(stopped.root_pid, view.pid);
        assert.equal(stopped.root_created_filetime, view.identity.started_filetime);
        assert.equal(stopped.root_exited, true);
        assert.equal(stopped.job_empty, true);
        assert.deepEqual(stopped.remaining_pids, []);
        this.verifyTools();
        result = {
          stopped_at: new Date().toISOString(),
          driver_pid: view.pid,
          method: "identity-bound-isolated-tree-termination",
          terminated_survivors: current.processes.map((item) => item.pid),
        };
      } else
        throw new Error(
          `Account backend has no reviewed ${mode} operation; owner fallback is forbidden`,
        );
    }
    return readNativeSessionObservation(mode, result);
  }
}
