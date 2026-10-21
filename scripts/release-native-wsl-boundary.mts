/** Fixed cross-host preparation only. No parser/argv plan appoints a host,
 * account, scheduler, native invocation or qualification. */
import path from "node:path";
import { createHash } from "node:crypto";
import {
  nativeWslBootstrapArguments,
  inspectNativeWslEntryPins,
  type NativeWslEntryPins,
} from "./release-native-wsl-bootstrap.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import { inspectNativeQualificationAccount } from "./release-native-qualification-contract.mts";
function exact(value: unknown, keys: string): asserts value is Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== keys)
    throw new Error("fixed native WSL boundary differs");
}
function sha(value: unknown) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error("native WSL digest absent");
  return value;
}
function linuxPath(value: unknown) {
  if (typeof value !== "string" || !/^\/home\/[a-z][a-z0-9_-]{0,31}\/portcove-native$/u.test(value))
    throw new Error("native WSL staging must be the fixed qualification home subtree");
  return value;
}
/** The account comes from independently parsed global setup, not request JSON. */
export function inspectNativeWslBoundary(
  raw: unknown,
  rawAccount: unknown,
  controller: string,
  capture: string,
) {
  const account = inspectNativeQualificationAccount(rawAccount);
  if (account.kind !== "windows-wsl-uid" || !account.distribution)
    throw new Error(
      "native WSL requires actual Windows broker / Linux qualification identity domains",
    );
  const value: unknown = structuredClone(raw);
  exact(
    value,
    "broker_sid,capture_root,controller_root,distribution,linux_root,qualification_gid,qualification_uid,qualification_user,schema_version,supervisor_sha256,tools",
  );
  if (
    value.schema_version !== 1 ||
    value.broker_sid !== account.broker ||
    value.qualification_uid !== account.qualification ||
    digest(value.distribution) !== digest(account.distribution) ||
    value.controller_root !== controller ||
    value.capture_root !== capture ||
    typeof value.qualification_user !== "string" ||
    !/^[a-z][a-z0-9_-]{0,31}$/u.test(value.qualification_user) ||
    value.qualification_user === "root" ||
    typeof value.qualification_gid !== "string" ||
    !/^[1-9][0-9]{0,9}$/u.test(value.qualification_gid) ||
    BigInt(value.qualification_gid) > 4294967294n
  )
    throw new Error("native WSL boundary differs from appointed source/account/host");
  if (
    !path.win32.isAbsolute(controller) ||
    !path.win32.isAbsolute(capture) ||
    controller.toLowerCase() === capture.toLowerCase()
  )
    throw new Error("native WSL Windows custody paths differ");
  const linuxRoot = linuxPath(value.linux_root);
  exact(
    value.tools,
    "bwrap,git,node,python,systemctl,systemd_run,tauri_driver,webkit_driver,wsl,xvfb",
  );
  const fixed = {
    bwrap: "/usr/bin/bwrap",
    git: "/usr/bin/git",
    python: "/usr/bin/python3",
    systemctl: "/usr/bin/systemctl",
    systemd_run: "/usr/bin/systemd-run",
    xvfb: "/usr/bin/Xvfb",
    webkit_driver: "/usr/bin/WebKitWebDriver",
    node: `${linuxRoot}/tools/node`,
    tauri_driver: `${linuxRoot}/tools/tauri-driver`,
    wsl: String.raw`C:\Windows\System32\wsl.exe`,
  } as const;
  const declaredTools = value.tools;
  const tools = Object.fromEntries(
    Object.entries(fixed).map(([name, expected]) => {
      const tool = declaredTools[name];
      exact(tool, "path,sha256");
      if (tool.path !== expected) throw new Error("native WSL executable route differs");
      return [name, Object.freeze({ path: expected, sha256: sha(tool.sha256) })];
    }),
  );
  return Object.freeze({
    broker_sid: account.broker,
    account: Object.freeze({
      ...account,
      distribution: Object.freeze({ ...account.distribution }),
    }),
    distribution: Object.freeze({ ...account.distribution }),
    linux_root: linuxRoot,
    qualification_gid: value.qualification_gid,
    qualification_user: value.qualification_user,
    controller_root: controller,
    capture_root: capture,
    supervisor_sha256: sha(value.supervisor_sha256),
    tools: Object.freeze(tools),
    authority: "none" as const,
  });
}
export function nativeWslInvocationCommands(
  boundary: ReturnType<typeof inspectNativeWslBoundary>,
  invocation: string,
  requestSha256: string,
  rawPins: NativeWslEntryPins,
) {
  sha(invocation);
  sha(requestSha256);
  const pins = inspectNativeWslEntryPins(rawPins);
  if (pins.supervisor_sha256 !== boundary.supervisor_sha256)
    throw new Error("appointed guest source differs");
  const unit = `portcove-native-${invocation}.service`;
  const command = (kind: "outer" | "transfer", operation: readonly string[]) =>
    Object.freeze({
      executable: boundary.tools.wsl!.path,
      arguments: Object.freeze([
        "--distribution",
        boundary.distribution.name,
        "--user",
        boundary.qualification_user,
        "--exec",
        boundary.tools.python!.path,
        ...nativeWslBootstrapArguments(
          boundary.linux_root,
          boundary.account.qualification,
          boundary.qualification_gid,
          kind,
          pins,
          boundary.tools.python!.sha256,
          boundary.tools.git!.sha256,
          operation,
        ),
      ]),
      credential_input: "none" as const,
      authority: "none" as const,
    });
  const invoke = (mode: "run" | "readback" | "settle") =>
    command("outer", [
      "--mode",
      mode,
      "--invocation",
      invocation,
      "--request-sha256",
      requestSha256,
    ]);
  return Object.freeze({
    stage(entry: "request" | "plan" | "application", bytes: number, sha256: string) {
      if (
        !["request", "plan", "application"].includes(entry) ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > (entry === "application" ? 512 * 1024 * 1024 : 128 * 1024)
      )
        throw new Error("fixed native input transfer differs");
      sha(sha256);
      const header = JSON.stringify({
        schema_version: 1,
        invocation_id: invocation,
        entry,
        bytes,
        sha256,
      });
      return Object.freeze({
        ...command("transfer", [
          "--mode",
          "stage",
          "--invocation",
          invocation,
          "--header-sha256",
          createHash("sha256").update(header).digest("hex"),
        ]),
        header: header + "\n",
      });
    },
    capture: command("transfer", ["--mode", "capture", "--invocation", invocation]),
    host: command("transfer", ["--mode", "host", "--invocation", invocation]),
    run: invoke("run"),
    readback: invoke("readback"),
    settle: invoke("settle"),
    unit,
    tasks_max: 64 as const,
    timeout_seconds: 1800 as const,
    stop_seconds: 15 as const,
    required_candidate_absence: Object.freeze([
      "/init",
      "/mnt",
      "/run/WSL",
      "/run/user",
      "WSL_INTEROP",
    ]),
    scope:
      "prepared fixed routes only; actual UID/cgroup/namespaces/private display and teardown still unobserved" as const,
    authority: "none" as const,
  });
}
