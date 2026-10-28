import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { WindowsHostBridge } from "./resource-paths.mts";
import type {
  ResourceCapacityOptions,
  ResourceLease,
  ResourceMetadata,
  ResourceReference,
} from "./resource-capacity.mts";
import type { HeavyProcessRecord } from "./heavy-rust-test-lock.mts";
import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage, errorCode, isRecord } from "./runtime-values.mts";
import { validWindowsHostBridge, validResourceRecoveryReference } from "./resource-paths.mts";
import { readProcessIdentity, readHeavyRustLockOwner } from "./heavy-rust-test-lock.mts";
import {
  acquireResourceCapacity,
  observeCapacity,
  resourceDomainRoot,
  reconcileExternalCapacity,
} from "./resource-capacity.mts";

const delegationName = "PORTCOVE_HOST_RESOURCE";
const wireLimit = 32 * 1024;
// This small launcher validates every staged module before evaluating any of it.
// Host and appointed Linux recovery use the same content-bound module closure.
const verifiedLauncher = [
  'const fs=await import("node:fs"), p=await import("node:path"), c=await import("node:crypto"), u=await import("node:url");',
  "const [entry,digest,action,...args]=process.argv.slice(1), root=p.dirname(p.dirname(entry));",
  'const hash=b=>c.createHash("sha256").update(b).digest("hex");',
  'const raw=fs.readFileSync(p.join(root,"bridge-manifest.json"));',
  'if(raw.length>65536||hash(raw)!==digest)throw Error("Bridge manifest identity differs");',
  'const m=JSON.parse(raw);if(m.format!==1||m.runtime!==process.version||!Array.isArray(m.files)||!m.files.length||m.files.length>256)throw Error("Invalid bridge closure");',
  'let total=0;const names=new Set();for(const f of m.files){if(typeof f.path!=="string"||names.has(f.path)||f.path.includes("\\\\")||!f.path||p.isAbsolute(f.path)||f.path.split("/").some(x=>!x||x==="."||x===".."))throw Error("Invalid bridge closure path");names.add(f.path);',
  'const file=p.join(root,f.path);let at=file;while(at!==root){if(fs.lstatSync(at).isSymbolicLink())throw Error("Linked bridge closure");at=p.dirname(at);}',
  'const s=fs.lstatSync(file);if(!s.isFile()||s.size>1048576||(total+=s.size)>8388608)throw Error("Bridge closure exceeds bound");if(hash(fs.readFileSync(file))!==f.sha256)throw Error("Bridge module identity differs");}',
  'if(!names.has(p.relative(root,entry).split(p.sep).join("/")))throw Error("Unbound bridge entry");',
  "process.argv=[process.execPath,entry,action,...args];await import(u.pathToFileURL(entry).href);",
].join("\n");

export function bridgeLaunchArguments(
  entry: string,
  digest: string,
  action: string,
  args: string[] = [],
) {
  return ["--input-type=module", "-e", verifiedLauncher, entry, digest, action, ...args];
}

/** Bound buffering before parsing; stdout is reserved for protocol records. */
export async function* bridgeMessages(
  input: Readable,
): AsyncGenerator<Record<string, unknown>, void, unknown> {
  let buffered = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buffered += String(chunk);
    if (Buffer.byteLength(buffered) > wireLimit)
      throw new Error("Host bridge message exceeds bound");
    let end: number;
    while ((end = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const value: unknown = JSON.parse(line);
      if (!isRecord(value) || value.version !== 1) throw new Error("Invalid host bridge message");
      yield value;
    }
  }
  if (buffered) throw new Error("Truncated host bridge message");
}

function send(output: Writable, value: Record<string, unknown>) {
  const bytes = JSON.stringify({ ...value, version: 1 }) + "\n";
  if (Buffer.byteLength(bytes) > wireLimit) throw new Error("Host bridge message exceeds bound");
  output.write(bytes);
}

interface Custody {
  invocation: string;
  owner: HeavyProcessRecord;
  child: HeavyProcessRecord | null;
  cleanupParent?: { dev: number; ino: number };
}

function parseCustody(value: unknown): Custody {
  if (
    !isRecord(value) ||
    typeof value.invocation !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.invocation) ||
    !isRecord(value.owner) ||
    !Number.isSafeInteger(value.owner.pid) ||
    typeof value.owner.identity !== "string" ||
    !value.owner.identity.startsWith("linux:") ||
    (value.child !== null &&
      (!isRecord(value.child) ||
        !Number.isSafeInteger(value.child.pid) ||
        typeof value.child.identity !== "string" ||
        !value.child.identity.startsWith("linux:") ||
        value.child.containment !== "unix-watchdog" ||
        typeof value.child.cleanup_receipt !== "string" ||
        !path.posix.isAbsolute(value.child.cleanup_receipt))) ||
    (value.child !== null &&
      (!isRecord(value.cleanupParent) ||
        !Number.isSafeInteger(value.cleanupParent.dev) ||
        !Number.isSafeInteger(value.cleanupParent.ino)))
  )
    throw new Error("Invalid Linux host-bridge custody");
  return value as unknown as Custody;
}

function regularJson(file: string) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.size > wireLimit) throw new Error("Invalid bridge evidence file");
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** The host invokes this in the appointed distro/user; no host PID is interpreted here. */
export function probeLinuxCustody(
  file: string,
  invocation: string,
  phase: string,
  expected?: unknown,
) {
  const directory = lstatSync(path.dirname(file));
  if (
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o077) !== 0
  )
    throw new Error("Linux custody directory ownership differs");
  const custody = parseCustody(regularJson(file));
  if (custody.invocation !== invocation) throw new Error("Linux invocation differs");
  if (expected !== undefined && JSON.stringify(custody) !== JSON.stringify(parseCustody(expected)))
    throw new Error("Linux registration evidence changed");
  if (phase === "prelaunch-release") {
    const settled = regularJson(path.join(path.dirname(file), "prelaunch-complete.json"));
    if (
      custody.child !== null ||
      !isRecord(settled) ||
      settled.invocation !== invocation ||
      settled.owner !== custody.owner.identity ||
      settled.outcome !== "prelaunch-complete"
    )
      throw new Error("Prelaunch setup completion is not proven; retain custody");
    return custody;
  }
  if (phase === "register") {
    if (
      !custody.child ||
      readProcessIdentity(custody.owner.pid) !== custody.owner.identity ||
      readProcessIdentity(custody.child.pid) !== custody.child.identity
    )
      throw new Error("Linux owner/supervisor is not verified live");
  } else if (phase !== "release") throw new Error("Unknown Linux bridge probe");
  if (!custody.child) throw new Error("Linux supervised registration is missing; retain custody");
  const parent = lstatSync(path.dirname(custody.child.cleanup_receipt!));
  if (
    !parent.isDirectory() ||
    parent.dev !== custody.cleanupParent?.dev ||
    parent.ino !== custody.cleanupParent?.ino ||
    parent.uid !== process.getuid?.()
  )
    throw new Error("Linux cleanup directory identity changed");
  if (phase === "release") {
    const receipt = regularJson(custody.child.cleanup_receipt!);
    if (
      !isRecord(receipt) ||
      receipt.outcome !== "quiescent" ||
      readProcessIdentity(custody.child.pid) === custody.child.identity ||
      custody.child.tree_platform !== undefined
    )
      throw new Error("Exact Linux tree cleanup is not proven; retain custody");
  }
  return custody;
}

interface ExternalCustody {
  kind: "wsl-resource";
  invocation: string;
  bridge: WindowsHostBridge;
  custodyFile: string;
  binding: string;
}

function parseExternal(value: unknown): ExternalCustody {
  if (
    !isRecord(value) ||
    value.kind !== "wsl-resource" ||
    typeof value.invocation !== "string" ||
    !/^[a-f0-9-]{36}$/u.test(value.invocation) ||
    !validWindowsHostBridge(value.bridge) ||
    typeof value.custodyFile !== "string" ||
    !path.posix.isAbsolute(value.custodyFile) ||
    typeof value.binding !== "string" ||
    value.binding !== path.join(resourceDomainRoot(), "wsl", value.invocation, "registration.json")
  )
    throw new Error("Invalid external WSL custody");
  return value as unknown as ExternalCustody;
}

function remoteProbe(external: ExternalCustody, phase: string, expected?: unknown) {
  const request = Buffer.from(
    JSON.stringify({
      custodyFile: external.custodyFile,
      invocation: external.invocation,
      phase,
      expected,
    }),
  ).toString("base64url");
  const result = execFileSync(
    "wsl.exe",
    [
      "--distribution",
      external.bridge.distribution,
      "--cd",
      "/",
      "--user",
      external.bridge.user,
      "--exec",
      external.bridge.node,
      ...bridgeLaunchArguments(external.bridge.probe, external.bridge.closureSha256, "--probe", [
        request,
      ]),
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: wireLimit, windowsHide: true },
  );
  return parseCustody(JSON.parse(result));
}

export async function verifyHostReference(value: unknown) {
  if (
    !isRecord(value) ||
    !isRecord(value.reference) ||
    value.reference.root !== resourceDomainRoot() ||
    !Array.isArray(value.reference.slots) ||
    !value.reference.slots.length ||
    typeof value.invocation !== "string"
  )
    throw new Error("Invalid host resource delegation");
  const suppliedSlots: unknown[] = value.reference.slots;
  const suppliedExclusive: unknown[] = Array.isArray(value.reference.exclusive)
    ? value.reference.exclusive
    : [];
  const slots: unknown[] = [...suppliedSlots, ...suppliedExclusive];
  const names = new Set<string>();
  for (const slot of slots) {
    if (
      !isRecord(slot) ||
      typeof slot.name !== "string" ||
      !/^(?:slot-[0-7]|exclusive-[a-f0-9]{64})$/u.test(slot.name) ||
      typeof slot.token !== "string"
    )
      throw new Error("Invalid delegated host slot");
    if (names.has(slot.name)) throw new Error("Repeated delegated host slot");
    names.add(slot.name);
    const owner = await readHeavyRustLockOwner(path.join(resourceDomainRoot(), slot.name));
    const external = parseExternal(owner.external);
    if (owner.token !== slot.token || external.invocation !== value.invocation)
      throw new Error("Original host reservation no longer exists");
  }
}

interface HostDependencies {
  acquire?: typeof acquireResourceCapacity;
  probe?: typeof remoteProbe;
  root?: string;
}

/** A per-invocation adapter to the existing host pool, never another scheduler. */
export async function serveHostBridge(
  input: Readable,
  output: Writable,
  dependencies: HostDependencies = {},
) {
  const cancellation = new AbortController();
  const lost = () => cancellation.abort(new Error("WSL bridge connection closed"));
  input.once("end", lost);
  input.once("error", lost);
  let lease: ResourceLease | undefined;
  let external: ExternalCustody | undefined;
  let binding: Custody | undefined;
  let released = false;
  try {
    for await (const message of bridgeMessages(input)) {
      if (message.action === "acquire" && !lease) {
        if (
          !validWindowsHostBridge(message.bridge) ||
          typeof message.invocation !== "string" ||
          !/^[a-f0-9-]{36}$/u.test(message.invocation) ||
          typeof message.custodyFile !== "string" ||
          !path.posix.isAbsolute(message.custodyFile) ||
          typeof message.profile !== "string" ||
          !Number.isInteger(message.waitMs) ||
          Number(message.waitMs) < 0 ||
          Number(message.waitMs) > 3_600_000 ||
          (message.recoveryReceipt !== undefined &&
            !validResourceRecoveryReference(message.recoveryReceipt))
        )
          throw new Error("Invalid host lease request");
        lease = await (dependencies.acquire ?? acquireResourceCapacity)(
          message.profile,
          {
            workspace: typeof message.workspace === "string" ? message.workspace : null,
            command:
              "WSL " +
              message.bridge.distribution +
              ": " +
              (typeof message.command === "string" ? message.command.slice(0, 512) : "heavy phase"),
          },
          {
            environment: {},
            waitMs: Number(message.waitMs),
            signal: cancellation.signal,
            ...(validResourceRecoveryReference(message.recoveryReceipt)
              ? { recoveryReceipt: message.recoveryReceipt }
              : {}),
          },
        );
        external = {
          kind: "wsl-resource",
          bridge: message.bridge,
          invocation: message.invocation,
          custodyFile: message.custodyFile,
          binding: path.join(
            dependencies.root ?? resourceDomainRoot(),
            "wsl",
            message.invocation,
            "registration.json",
          ),
        };
        if (!lease.reference || !lease.registerExternal)
          throw new Error("Host lease cannot retain external custody");
        await lease.registerExternal(external);
        send(output, { action: "admitted", reference: lease.reference, queueMs: lease.queueMs });
      } else if (message.action === "register" && lease && external && !binding && !released) {
        binding = (dependencies.probe ?? remoteProbe)(external, "register");
        await mkdir(path.dirname(external.binding), { recursive: true });
        await writeFile(external.binding, JSON.stringify(binding), { flag: "wx", mode: 0o600 });
        send(output, { action: "registered" });
      } else if (message.action === "release" && lease && external && !released) {
        if (binding) (dependencies.probe ?? remoteProbe)(external, "release", binding);
        else (dependencies.probe ?? remoteProbe)(external, "prelaunch-release");
        // No registration ACK means the local payload gate was never authorized.
        await lease.release();
        released = true;
        send(output, { action: "released" });
        return;
      } else throw new Error("Unexpected host bridge lifecycle message");
    }
    if (lease && !released) throw new Error("Lost WSL bridge; external reservation retained");
  } catch (error) {
    send(output, {
      action: "error",
      code: errorCode(error) ?? "PORTCOVE_HOST_BRIDGE_FAILED",
      message: errorMessage(error).slice(0, 512),
    });
    throw error;
  } finally {
    input.off("end", lost);
    input.off("error", lost);
    // Never release on EOF/error: the original token and external record retain custody.
  }
}

function openBridge(config: WindowsHostBridge) {
  return spawn(
    config.executable,
    bridgeLaunchArguments(config.script, config.closureSha256, "--host"),
    {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    },
  );
}

async function reply(
  messages: AsyncGenerator<Record<string, unknown>, void, unknown>,
  action: string,
  timeout: number,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      messages.next(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Host bridge response timed out; retain custody")),
          timeout,
        );
      }),
    ]);
    if (!result.done && result.value.action === "error")
      throw Object.assign(new Error(String(result.value.message)), { code: result.value.code });
    if (result.done || result.value.action !== action)
      throw new Error("Host bridge did not acknowledge " + action + "; retain custody");
    return result.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function oneShot(config: WindowsHostBridge, action: string, value: unknown) {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  return execFileSync(
    config.executable,
    bridgeLaunchArguments(config.script, config.closureSha256, action, [encoded]),
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: wireLimit,
      windowsHide: true,
    },
  );
}

export async function verifyBridgedCapacity(
  config: WindowsHostBridge,
  environment: NodeJS.ProcessEnv,
) {
  if (!environment[delegationName])
    throw new Error("Nested Linux work lacks host resource delegation");
  await oneShot(config, "--verify", JSON.parse(environment[delegationName]));
}

export async function observeBridgedCapacity(config: WindowsHostBridge) {
  return JSON.parse(await oneShot(config, "--status", {})) as unknown;
}

/** Keep a local proxy lease for native identity/output checks and nested ownership. */
export async function acquireBridgedCapacity(
  config: WindowsHostBridge,
  profile: string,
  metadata: ResourceMetadata,
  options: ResourceCapacityOptions,
  acquireLocal: (remaining: number) => Promise<ResourceLease>,
): Promise<ResourceLease> {
  const started = performance.now();
  const waitMs = options.waitMs ?? 900_000;
  const invocation = randomUUID();
  const directory = mkdtempSync(path.join(tmpdir(), "pc-host-"));
  const custodyFile = path.join(directory, "custody.json");
  const identity = readProcessIdentity(process.pid);
  if (!identity) throw new Error("Cannot identify Linux bridge owner");
  const custody: Custody = { invocation, owner: { pid: process.pid, identity }, child: null };
  writeFileSync(custodyFile, JSON.stringify(custody), { flag: "wx", mode: 0o600 });
  const child: ChildProcess = openBridge(config);
  if (!child.stdin || !child.stdout) throw new Error("Host bridge streams unavailable");
  const input = child.stdin,
    messages = bridgeMessages(child.stdout);
  // Always observe spawn failure; a missing bridge never authorizes local fallback.
  child.once("error", () => input.destroy());
  const abort = () => input.end();
  options.signal?.addEventListener("abort", abort, { once: true });
  let local: ResourceLease | undefined;
  let admittedHost = false;
  let finished = false;
  let releasePromise: Promise<void> | undefined;
  try {
    options.signal?.throwIfAborted();
    send(input, {
      action: "acquire",
      bridge: config,
      invocation,
      custodyFile,
      profile,
      workspace: metadata.workspace,
      command: metadata.command,
      waitMs,
      ...(options.hostRecoveryReceipt ? { recoveryReceipt: options.hostRecoveryReceipt } : {}),
    });
    const admitted = await reply(messages, "admitted", Math.max(5_000, waitMs + 30_000));
    admittedHost = true;
    options.signal?.removeEventListener("abort", abort);
    const remaining = Math.max(0, Math.floor(waitMs - (performance.now() - started)));
    local = await acquireLocal(remaining);
    const delegation = JSON.stringify({ reference: admitted.reference, invocation });
    const owned = local;
    return {
      ...owned,
      queueMs: Math.round(performance.now() - started),
      childEnvironment: { ...owned.childEnvironment, [delegationName]: delegation },
      registerChild: async (processChild, registration) => {
        try {
          const record = await owned.registerChild(processChild, registration);
          if (!record || !record.cleanup_receipt)
            throw new Error("Linux supervised registration unavailable");
          const parent = lstatSync(path.dirname(record.cleanup_receipt));
          custody.child = record;
          custody.cleanupParent = { dev: parent.dev, ino: parent.ino };
          // This private file is published once, before the host ACK and local gate.
          writeFileSync(custodyFile, JSON.stringify(custody), { mode: 0o600 });
          send(input, { action: "register" });
          await reply(messages, "registered", 35_000);
          return record;
        } catch (error) {
          input.end();
          throw error;
        }
      },
      release: () =>
        (releasePromise ??= (async () => {
          try {
            if (finished) return;
            if (custody.child) probeLinuxCustody(custodyFile, invocation, "release", custody);
            else
              writeFileSync(
                path.join(directory, "prelaunch-complete.json"),
                JSON.stringify({
                  invocation,
                  owner: identity,
                  outcome: "prelaunch-complete",
                }),
                { flag: "wx", mode: 0o600 },
              );
            send(input, { action: "release" });
            await reply(messages, "released", 35_000);
            await owned.release();
            finished = true;
            options.signal?.removeEventListener("abort", abort);
            input.end();
            rmSync(directory, { recursive: true });
          } catch (error) {
            input.end();
            throw error;
          }
        })()),
    };
  } catch (error) {
    if (!local && admittedHost) {
      // Release only through the connected host's explicit pre-launch path.
      try {
        writeFileSync(
          path.join(directory, "prelaunch-complete.json"),
          JSON.stringify({
            invocation,
            owner: identity,
            outcome: "prelaunch-complete",
          }),
          { flag: "wx", mode: 0o600 },
        );
        send(input, { action: "release" });
        await reply(messages, "released", 35_000);
      } catch {
        /* retain external evidence */
      }
    }
    input.end();
    throw error;
  } finally {
    if (!local) options.signal?.removeEventListener("abort", abort);
  }
}

async function main() {
  const [action, encoded] = process.argv.slice(2);
  if (action === "--probe") {
    if (process.platform !== "linux" || !encoded || encoded.length > wireLimit)
      throw new Error("Linux bridge probe requires a bounded request");
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (
      !isRecord(value) ||
      typeof value.custodyFile !== "string" ||
      typeof value.invocation !== "string" ||
      typeof value.phase !== "string"
    )
      throw new Error("Invalid Linux probe request");
    console.log(
      JSON.stringify(
        probeLinuxCustody(value.custodyFile, value.invocation, value.phase, value.expected),
      ),
    );
    return;
  }
  if (process.platform !== "win32") throw new Error("Host bridge authority requires Windows");
  if (action === "--host") await serveHostBridge(process.stdin, process.stdout);
  else if (action === "--status") {
    const { collectHostObservation } = await import("./resource-observations.mts");
    console.log(
      JSON.stringify({ capacity: await observeCapacity(), host: collectHostObservation() }),
    );
  } else {
    if (!encoded || encoded.length > wireLimit) throw new Error("Bounded bridge request required");
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (action === "--verify") await verifyHostReference(value);
    else if (action === "--recover") {
      if (!isRecord(value)) throw new Error("Invalid recovery request");
      await verifyHostReference(value);
      const reference = value.reference as ResourceReference;
      const owner = await readHeavyRustLockOwner(
        path.join(resourceDomainRoot(), reference.slots[0]!.name),
      );
      const external = parseExternal(owner.external);
      try {
        const binding: unknown = JSON.parse(await readFile(external.binding, "utf8"));
        remoteProbe(external, "release", binding);
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
        remoteProbe(external, "prelaunch-release");
      }
      console.log(await reconcileExternalCapacity(reference, external, () => true));
    } else throw new Error("Unknown host bridge action");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main().catch((error: unknown) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
