// Bounded real-package qualification through upstream's local Sail protocol.
// No daemon, background job, command interpreter or production authority.
import { createHash, randomInt, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { lstat, readFile, writeFile, realpath, mkdir, open } from "node:fs/promises";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { resolve, relative, join, isAbsolute, dirname, toNamespacedPath } from "node:path";
import { promisify, isDeepStrictEqual } from "node:util";

import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";

const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Native settings probe reached its finite deadline.")),
          Math.max(1, ms),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function contained(root: string, file: string) {
  const part = relative(root, file);
  return (
    part !== "" &&
    !isAbsolute(part) &&
    part !== ".." &&
    !part.startsWith("../") &&
    !part.startsWith("..\\")
  );
}
async function bounded(file: string, limit = 1024 * 1024) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new Error("Native settings evidence must be a bounded regular file.");
  const bytes = await readFile(file);
  if (bytes.length > limit) throw new Error("Native settings evidence grew beyond its bound.");
  return bytes;
}
export async function readSettingsProbeConfiguration(file: string) {
  const info = await lstat(file);
  if (info.nlink !== 1)
    throw new Error("Mutable settings qualification configuration must have one link.");
  return bounded(file);
}

export async function writeSettingsProbeConfiguration(file: string, bytes: Buffer | string) {
  if (Buffer.byteLength(bytes) > 1024 * 1024)
    throw new Error("Settings probe document exceeds its bound.");
  const before = await lstat(file, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1n ||
    before.size > 1024n * 1024n
  )
    throw new Error(
      "Mutable settings qualification configuration must be an unlinked regular file.",
    );
  const held = await open(file, "r+");
  try {
    const current = await held.stat({ bigint: true });
    if (
      !current.isFile() ||
      current.nlink !== 1n ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw new Error("Mutable settings qualification configuration changed identity.");
    await held.truncate(0);
    await held.writeFile(bytes);
  } finally {
    await held.close();
  }
}

/** Exact locations come from Core's retained editor context, never a JS runtime-root rule. */
export async function settingsProbePaths(
  root: string,
  scope: unknown,
  fileId: string,
  installId: string,
) {
  if (
    !object(scope) ||
    scope.install_id !== installId ||
    !sha(scope.definition_sha256) ||
    !Array.isArray(scope.files) ||
    scope.files.length > 8
  )
    throw new Error("Settings probe scope lacks the exact retained installation.");
  const files: unknown[] = scope.files;
  const matching = files.filter((file) => object(file) && file.file_id === fileId);
  const file = matching[0];
  if (
    matching.length !== 1 ||
    !object(file) ||
    typeof file.canonical_path !== "string" ||
    !(file.runtime_path === null || typeof file.runtime_path === "string")
  )
    throw new Error("Settings probe file scope is absent or ambiguous.");
  root = toNamespacedPath(await realpath(root));
  const canonical = await assertOwnedUnlinkedPath(
    root,
    toNamespacedPath(file.canonical_path),
    "Canonical settings probe configuration",
  );
  const runtime =
    file.runtime_path === null
      ? canonical
      : await assertOwnedUnlinkedPath(
          root,
          toNamespacedPath(file.runtime_path),
          "Runtime settings probe configuration",
        );
  return { canonical, runtime, paths: [...new Set([canonical, runtime])] };
}

export async function initializeSettingsProbeFiles(
  root: string,
  scope: unknown,
  fileId: string,
  installId: string,
  sample: string,
) {
  const result = await settingsProbePaths(root, scope, fileId, installId);
  let document: Buffer | undefined;
  const absent: string[] = [];
  for (const file of result.paths) {
    try {
      const bytes = await readSettingsProbeConfiguration(file);
      if (document && !document.equals(bytes))
        throw new Error("Retained settings mirrors differ; preserve both before qualification.");
      document = bytes;
    } catch (error) {
      if (!object(error) || error.code !== "ENOENT") throw error;
      absent.push(file);
    }
  }
  document ??= Buffer.from(sample);
  if (document.length > 1024 * 1024) throw new Error("Settings probe seed exceeds its bound.");
  for (const file of absent) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, document, { flag: "wx" });
  }
  return result;
}

function at(value: unknown, key: readonly string[]): unknown {
  let current = value;
  for (const part of key)
    current = object(current) && Object.hasOwn(current, part) ? current[part] : undefined;
  return current;
}
function set(value: Record<string, unknown>, key: readonly string[], next: unknown) {
  let current = value;
  for (const part of key.slice(0, -1)) {
    if (current[part] === undefined) current[part] = {};
    if (!object(current[part])) throw new Error("Native settings sample has a conflicting parent.");
    current = current[part];
  }
  current[key.at(-1)!] = next;
}
interface Probe {
  file_id: string;
  setting_id: string;
  key: string[];
  values: number[];
}

/** Refuse vacuous, contradictory or foreign immutable-verification receipts. */
export function requireSettingsVerification(report: unknown, installId: unknown) {
  if (
    typeof installId !== "string" ||
    installId.length === 0 ||
    !object(report) ||
    report.install_id !== installId ||
    report.valid !== true ||
    !Number.isSafeInteger(report.checked_files) ||
    Number(report.checked_files) <= 0 ||
    !Array.isArray(report.failures) ||
    report.failures.length !== 0
  )
    throw new Error("Native settings package lacks positive exact-install immutable verification.");
  return report;
}

/** Own every accepted socket, including rejected reconnects. Socket failures are
 * observations consumed by the bounded owner, never uncaught event errors. */
export async function openSettingsProbeListener() {
  const sockets = new Set<Socket>();
  let first: Socket | undefined;
  let fault: Error | undefined;
  let receivedBytes = 0;
  let acceptFirst!: (socket: Socket) => void;
  let rejectFirst!: (error: Error) => void;
  const connection = new Promise<Socket>((accept, reject) => {
    acceptFirst = accept;
    rejectFirst = reject;
  });
  void connection.catch(() => {});
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", (error) => {
      if (socket === first) fault = error;
    });
    socket.once("close", () => sockets.delete(socket));
    if (first) {
      socket.destroy();
      return;
    }
    first = socket;
    socket.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > 1024 * 1024) {
        fault = new Error("Native settings protocol exceeded its bounded response allowance.");
        socket.destroy();
      }
    });
    acceptFirst(socket);
  });
  server.on("error", (error) => {
    fault = error;
    rejectFirst(error);
  });
  await new Promise<void>((done, reject) => {
    const failed = (error: Error) => reject(error);
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", failed);
      done();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Native settings listener identity is unavailable.");
  return {
    port: address.port,
    connection: (milliseconds: number) => within(connection, milliseconds),
    check() {
      if (fault) throw fault;
      if (first?.destroyed)
        throw new Error("Native settings consumer closed its probe connection.");
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await within(
        new Promise<void>((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
        }),
        5000,
      );
    },
  };
}

/** Uses a pre-provisioned, marked disposable library. Candidate declarations
 * remain qualification-only until this result and ordinary acceptance pass. */
export async function qualifySettingsConsumer(options: {
  cli: string;
  library: string;
  output: string;
  caseFile: string;
  qualificationCatalog?: string | undefined;
}) {
  if (process.platform !== "win32")
    throw new Error("This native Libultraship consumer probe requires Windows x86-64.");
  const value: unknown = JSON.parse((await bounded(options.caseFile)).toString("utf8"));
  if (
    !object(value) ||
    value.format_version !== 1 ||
    value.protocol !== "libultraship-sail-v1" ||
    typeof value.isolation_root !== "string" ||
    typeof value.isolation_token !== "string" ||
    typeof value.port_id !== "string" ||
    !/^[a-z0-9-]+$/u.test(value.port_id) ||
    typeof value.source_commit !== "string" ||
    !/^[a-f0-9]{40}$/u.test(value.source_commit) ||
    !sha(value.archive_sha256) ||
    !sha(value.cli_sha256) ||
    !sha(value.executable_sha256) ||
    typeof value.configuration_path !== "string" ||
    !Array.isArray(value.probes) ||
    value.probes.length !== 1
  )
    throw new Error("Native settings case lacks exact source/package/client and isolated scope.");
  const probe: unknown = value.probes[0];
  if (
    !object(probe) ||
    typeof probe.file_id !== "string" ||
    typeof probe.setting_id !== "string" ||
    !Array.isArray(probe.key) ||
    probe.key.length < 1 ||
    probe.key.length > 8 ||
    !probe.key.every(
      (key) =>
        typeof key === "string" &&
        /^[A-Za-z0-9_-]+$/u.test(key) &&
        !["__proto__", "constructor", "prototype"].includes(key),
    ) ||
    !Array.isArray(probe.values) ||
    probe.values.length < 2 ||
    probe.values.length > 4 ||
    !probe.values.every(
      (number) => Number.isSafeInteger(number) && Math.abs(Number(number)) <= 1_000_000_000,
    ) ||
    new Set(probe.values).size < 2
  )
    throw new Error("Native settings case needs one bounded integer JSON probe.");
  const selected = probe as unknown as Probe;
  const root = toNamespacedPath(await realpath(value.isolation_root));
  const library = toNamespacedPath(await realpath(options.library));
  const configuration = toNamespacedPath(await realpath(value.configuration_path));
  const output = toNamespacedPath(resolve(options.output));
  const outputParent = toNamespacedPath(await realpath(dirname(output)));
  const cli = toNamespacedPath(await realpath(options.cli));
  const marker: unknown = JSON.parse(
    (await bounded(join(root, ".portcove-settings-qualification.json"), 4096)).toString("utf8"),
  );
  if (
    !object(marker) ||
    marker.owner !== "portcove-settings-qualification" ||
    marker.token !== value.isolation_token ||
    !contained(root, library) ||
    !contained(root, configuration) ||
    !contained(root, output) ||
    (outputParent !== root && !contained(root, outputParent)) ||
    !(await lstat(join(library, "portcove.sqlite3"))).isFile() ||
    hash(await bounded(cli, 512 * 1024 * 1024)) !== value.cli_sha256
  )
    throw new Error(
      "Native settings case is outside its marked disposable scope or changed client.",
    );
  const environment: Record<string, string | undefined> = {
    ...process.env,
    PORTCOVE_PREFERENCES: join(root, "preferences.json"),
    PORTCOVE_APPLICATION_RUNTIME_LOCK: join(root, "application-runtime"),
  };
  for (const name of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "PORTCOVE_QUALIFICATION_CATALOG",
  ])
    delete environment[name];
  let qualificationCatalog: { path: string; sha256: string } | undefined;
  if (options.qualificationCatalog !== undefined) {
    const file = toNamespacedPath(await realpath(options.qualificationCatalog));
    if (!contained(root, file))
      throw new Error("Native settings qualification catalog escaped its marked disposable scope.");
    qualificationCatalog = { path: file, sha256: hash(await bounded(file, 16 * 1024 * 1024)) };
    environment.PORTCOVE_QUALIFICATION_CATALOG = file;
  }
  await mkdir(output);
  await writeFile(join(output, "case.json"), JSON.stringify(value), { flag: "wx" });
  const evidence: Record<string, unknown>[] = [];
  const checkInputs = async () => {
    if (hash(await bounded(cli, 512 * 1024 * 1024)) !== value.cli_sha256)
      throw new Error("Native settings client changed.");
    if (
      qualificationCatalog &&
      hash(await bounded(qualificationCatalog.path, 16 * 1024 * 1024)) !==
        qualificationCatalog.sha256
    )
      throw new Error("Native settings qualification catalog changed.");
  };
  const run = async (args: string[]) => {
    await checkInputs();
    const result = await execute(
      cli,
      ["--library", library, "--json", "--non-interactive", ...args],
      {
        env: environment,
        encoding: "utf8",
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const envelope: unknown = JSON.parse(result.stdout);
    evidence.push({ args, stdout: result.stdout, stderr: result.stderr });
    if (!object(envelope) || envelope.ok !== true)
      throw new Error("Native settings management call failed.");
    return envelope.data;
  };
  const status = await run(["status", value.port_id]);
  if (
    !object(status) ||
    !object(status.active) ||
    !object(status.active.artifact) ||
    status.active.artifact.sha256 !== value.archive_sha256 ||
    typeof status.active.id !== "string" ||
    typeof status.active.path !== "string" ||
    typeof status.active.selected_executable !== "string"
  )
    throw new Error("Native settings install differs from the selected package.");
  const executable = toNamespacedPath(
    await realpath(join(status.active.path, status.active.selected_executable)),
  );
  if (
    !contained(root, executable) ||
    hash(await bounded(executable, 512 * 1024 * 1024)) !== value.executable_sha256
  )
    throw new Error("Native settings executable is outside the selected exact package.");
  const retainedScope = await run(["game-settings", "qualification-scope", value.port_id]);
  const mutable = await settingsProbePaths(root, retainedScope, selected.file_id, status.active.id);
  if ((await realpath(mutable.canonical)).toLowerCase() !== configuration.toLowerCase())
    throw new Error("Native settings case differs from Core's retained canonical file.");
  const initial = await readSettingsProbeConfiguration(configuration);
  for (const file of mutable.paths) {
    if (!(await readSettingsProbeConfiguration(file)).equals(initial))
      throw new Error("Native retained settings mirrors differ before qualification.");
  }
  const preservationKey = "PortcoveQualification_" + randomUUID().replaceAll("-", "");
  const preservationValue = {
    text: "keep this unrelated value",
    flag: true,
    array: [3, false, "unknown"],
  };
  const observedValues: number[] = [];
  const producerSha256 = hash(await readFile(new URL(import.meta.url)));
  const { acquireNativeSessionLock } = await import("./native-session-lock.mts");
  const nativeLock = await acquireNativeSessionLock({
    workspace: process.cwd(),
    command: "settings-consumer-qualification",
  });
  let unsettled = false;
  let failure: unknown;
  let failed = false;
  try {
    for (const requested of selected.values) {
      const listener = await openSettingsProbeListener();
      let socket: Socket | undefined;
      let ownerVerified = false;
      let child: ReturnType<typeof spawn> | undefined;
      let terminal: Promise<{ code: number | null; signal: string | null }> | undefined;
      const requestId = randomUUID();
      const deadline = performance.now() + 120000;
      try {
        const beforeBytes = await readSettingsProbeConfiguration(configuration);
        for (const file of mutable.paths) {
          if (!(await readSettingsProbeConfiguration(file)).equals(beforeBytes))
            throw new Error("Retained settings mirrors changed before the next quiescent probe.");
        }
        const before: unknown = JSON.parse(beforeBytes.toString("utf8"));
        if (!object(before)) throw new Error("Native settings configuration must be an object.");
        before[preservationKey] = preservationValue;
        set(before, ["CVars", "gRemote", "Sail"], {
          Enabled: 1,
          Host: "127.0.0.1",
          Port: listener.port,
        });
        for (const file of mutable.paths)
          await writeSettingsProbeConfiguration(file, JSON.stringify(before));
        const intent = [
          value.port_id,
          selected.file_id,
          selected.setting_id,
          "--value",
          String(requested),
        ];
        const review = await run(["game-settings", "review", ...intent]);
        if (!object(review) || !sha(review.review_sha256) || review.proposed_value !== requested)
          throw new Error("Native settings review differs from the requested integer.");
        await run(["game-settings", "apply", ...intent, "--expected-review", review.review_sha256]);
        const applied: unknown = JSON.parse(
          (await readSettingsProbeConfiguration(configuration)).toString("utf8"),
        );
        const expected = structuredClone(before);
        set(expected, selected.key, requested);
        if (!isDeepStrictEqual(applied, expected))
          throw new Error("Native service changed unrelated configuration values.");
        await checkInputs();
        child = spawn(
          cli,
          [
            "--library",
            library,
            "--non-interactive",
            "exec",
            value.port_id,
            "--request-id",
            requestId,
          ],
          { env: environment, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
        );
        unsettled = true;
        let streams = "";
        for (const stream of [child.stdout, child.stderr])
          stream?.on("data", (chunk: Buffer) => {
            streams = (streams + chunk.toString("utf8")).slice(-1024 * 1024);
          });
        terminal = new Promise((done, reject) => {
          child!.once("error", reject);
          child!.once("exit", (code, signal) => done({ code, signal }));
        });
        socket = await within(
          Promise.race([
            listener.connection(deadline - performance.now()),
            terminal.then(() => {
              throw new Error("Native consumer exited before its local probe connection.");
            }),
          ]),
          deadline - performance.now(),
        );
        listener.check();
        const session = await run(["launch", "show", requestId]);
        if (
          !object(session) ||
          session.supervisor_pid !== child.pid ||
          !Number.isSafeInteger(session.child_pid) ||
          typeof session.child_identity !== "string"
        )
          throw new Error("Native consumer session identity is unavailable.");
        const script =
          "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$c=@(Get-NetTCPConnection -LocalPort " +
          Number(socket.remotePort) +
          " -RemotePort " +
          listener.port +
          " -State Established -ErrorAction Stop);if($c.Count -ne 1){throw 'ambiguous peer'};$p=Get-Process -Id $c[0].OwningProcess -ErrorAction Stop;[ordered]@{pid=$p.Id;identity=('windows-filetime:'+$p.StartTime.ToFileTimeUtc());path=$p.Path}|ConvertTo-Json -Compress";
        const peer = await execute("powershell.exe", ["-NoProfile", "-Command", script], {
          encoding: "utf8",
          timeout: 30000,
          windowsHide: true,
          maxBuffer: 8192,
        });
        const identity: unknown = JSON.parse(peer.stdout);
        if (
          !object(identity) ||
          identity.pid !== session.child_pid ||
          identity.identity !== session.child_identity ||
          typeof identity.path !== "string" ||
          toNamespacedPath(await realpath(identity.path)).toLowerCase() !== executable.toLowerCase()
        )
          throw new Error("Native probe peer is not the exact Core game process.");
        ownerVerified = true;
        const onDisk: unknown = JSON.parse(
          (await readSettingsProbeConfiguration(mutable.runtime)).toString("utf8"),
        );
        if (!object(onDisk)) throw new Error("Native configuration changed format.");
        // The game's next Save must restore its loaded X over test-only disk Y.
        const alternate = selected.values.find((number) => number !== requested)!;
        set(onDisk, selected.key, alternate);
        await writeSettingsProbeConfiguration(mutable.runtime, JSON.stringify(onDisk));
        const alternateBytes = await readSettingsProbeConfiguration(mutable.runtime);
        const alternateDocument: unknown = JSON.parse(alternateBytes.toString("utf8"));
        if (at(alternateDocument, selected.key) !== alternate)
          throw new Error(
            "Actual runtime path did not retain the deliberate test-only disk value.",
          );
        evidence.push({
          requested_value: requested,
          deliberate_runtime_value: alternate,
          runtime_before_save_sha256: hash(alternateBytes),
        });
        const nonce = randomInt(1, 1_000_000_000);
        socket.write(
          JSON.stringify({
            id: nonce,
            type: "command",
            command: "set portcoveQualificationSentinel " + nonce,
          }) + "\0",
        );
        let consumed = false;
        while (performance.now() < deadline) {
          listener.check();
          const disk: unknown = JSON.parse(
            (await readSettingsProbeConfiguration(mutable.runtime)).toString("utf8"),
          );
          if (at(disk, ["CVars", "portcoveQualificationSentinel"]) === nonce) {
            if (at(disk, selected.key) !== requested)
              throw new Error("Actual packaged consumer did not retain the requested setting.");
            if (!isDeepStrictEqual(at(disk, [preservationKey]), preservationValue))
              throw new Error("Actual packaged consumer changed unrelated JSON evidence.");
            consumed = true;
            break;
          }
          await wait(50);
        }
        if (!consumed)
          throw new Error("Actual consumer did not publish its loaded value before the deadline.");
        observedValues.push(requested);
        socket.write(JSON.stringify({ id: nonce + 1, type: "command", command: "quit" }) + "\0");
        const outcome = await within(terminal, deadline - performance.now());
        const retained = await run(["launch", "show", requestId]);
        evidence.push({
          requested,
          session,
          peer: identity,
          outcome,
          retained,
          streams,
          unrelated_json_preserved: true,
        });
        if (
          outcome.code !== 0 ||
          outcome.signal ||
          !object(retained) ||
          retained.outcome !== "succeeded" ||
          retained.exit_code !== 0
        )
          throw new Error("Native consumer did not produce positive Core exit evidence.");
        unsettled = false;
        const canonicalAfter = await readSettingsProbeConfiguration(configuration);
        const runtimeAfter = await readSettingsProbeConfiguration(mutable.runtime);
        if (
          !canonicalAfter.equals(runtimeAfter) ||
          at(JSON.parse(canonicalAfter.toString("utf8")), selected.key) !== requested
        )
          throw new Error(
            "Normal Core launch completion did not synchronize the actual saved settings.",
          );
        evidence.push({
          synchronized_canonical_sha256: hash(canonicalAfter),
          runtime_sha256: hash(runtimeAfter),
        });
      } finally {
        if (child) {
          if (child.exitCode === null && ownerVerified && socket && !socket.destroyed) {
            socket.write(JSON.stringify({ id: 1, type: "command", command: "quit" }) + "\0");
          }
          if (!child.pid) unsettled = false;
          else if (terminal) {
            try {
              const exit = await within(terminal, 10000);
              const retained = await run(["launch", "show", requestId]);
              if (
                (exit.code !== null || exit.signal !== null) &&
                object(retained) &&
                typeof retained.outcome === "string" &&
                ["succeeded", "failed", "cancelled"].includes(retained.outcome) &&
                typeof retained.finished_at === "number"
              )
                unsettled = false;
            } catch {
              /* Original failure and unfinished ownership remain retained. */
            }
          }
          if (unsettled)
            evidence.push({
              request_id: requestId,
              unfinished_child: child.pid,
              owner_verified: ownerVerified,
            });
          child.unref();
          child.stdout?.destroy();
          child.stderr?.destroy();
        }
        await listener.close();
      }
    }
    const reset = await run([
      "game-settings",
      "review",
      value.port_id,
      selected.file_id,
      selected.setting_id,
      "--reset",
    ]);
    if (!object(reset) || !sha(reset.review_sha256) || !Number.isSafeInteger(reset.proposed_value))
      throw new Error("Native default reset review is unavailable.");
    await run([
      "game-settings",
      "apply",
      value.port_id,
      selected.file_id,
      selected.setting_id,
      "--reset",
      "--expected-review",
      reset.review_sha256,
    ]);
    const resetBytes = await readSettingsProbeConfiguration(configuration);
    if (!(await readSettingsProbeConfiguration(mutable.runtime)).equals(resetBytes))
      throw new Error("Reset left different canonical and runtime settings mirrors.");
    const resetDocument: unknown = JSON.parse(resetBytes.toString("utf8"));
    if (
      at(resetDocument, selected.key) !== reset.proposed_value ||
      !isDeepStrictEqual(at(resetDocument, [preservationKey]), preservationValue)
    )
      throw new Error("Native settings reset readback or unrelated JSON preservation differs.");
    const verification = requireSettingsVerification(
      await run(["verify", value.port_id]),
      status.active.id,
    );
    evidence.push({
      reset_value: reset.proposed_value,
      unrelated_json_preserved: true,
      verification,
    });
    if (hash(await bounded(executable, 512 * 1024 * 1024)) !== value.executable_sha256)
      throw new Error("Native executable changed during qualification.");
  } catch (error) {
    failure = error;
    failed = true;
  }
  const raw = Buffer.from(
    JSON.stringify({
      format_version: 1,
      scope: "actual packaged CVar load/save; not audible amplitude or gameplay",
      input: value,
      initial_sha256: hash(initial),
      qualification_catalog: qualificationCatalog,
      retained_settings_scope: retainedScope,
      preservation: { key: preservationKey, expected: preservationValue },
      observed_values: observedValues,
      evidence,
      unsettled_owned_process: unsettled,
      producer_sha256: producerSha256,
      failure: failed ? (failure instanceof Error ? failure.message : String(failure)) : null,
    }),
  );
  try {
    await writeFile(join(output, "native-settings-evidence.json"), raw, { flag: "wx" });
  } catch (error) {
    failure = failed
      ? new AggregateError(
          [failure, error],
          "Native settings probe and evidence persistence failed.",
        )
      : error;
    failed = true;
  } finally {
    if (!unsettled) await nativeLock.release();
  }
  if (failed || unsettled) {
    const error =
      failure instanceof Error
        ? failure
        : new Error(
            "Native settings probe failed or its owned process has not settled; inspect the retained evidence.",
          );
    if (unsettled) Object.assign(error, { code: "PORTCOVE_NATIVE_OWNER_UNSETTLED" });
    throw error;
  }
  const observation = {
    archive_sha256: value.archive_sha256,
    source_commit: value.source_commit,
    client_sha256: value.cli_sha256,
    executable_sha256: value.executable_sha256,
    evidence_sha256: hash(raw),
    observations: [
      {
        file_id: selected.file_id,
        setting_id: selected.setting_id,
        requested_values: selected.values,
        observed_values: observedValues,
      },
    ],
  };
  await writeFile(join(output, "settings-consumer.json"), JSON.stringify(observation), {
    flag: "wx",
  });
  return observation;
}
