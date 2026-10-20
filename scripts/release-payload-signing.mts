/** Fixed offline payload signer. Expected facts come from independent admission;
 * this module authenticates bytes/signatures, never qualification or publication. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { artifactName, loadPackagePolicy } from "./release-package-policy.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[a-f0-9]{64}$/;
const commit = /^[a-f0-9]{40}$/;
const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export interface PinnedSigningTool {
  path: string;
  sha256: string;
}
export interface PayloadSigningRequest {
  schema_version: 1;
  repository: "boburning/portcove";
  version: string;
  source_commit: string;
  platform_label: "windows-x86_64" | "linux-x86_64";
  filename: string;
  sha256: string;
  bytes: number;
  public_key_sha256: string;
  qualification_inventory_sha256: string;
  producer: { run_id: string; run_attempt: number; job_id: string; artifact_id: string };
}
export interface SignPayloadOptions {
  projectRoot: string;
  request: PayloadSigningRequest;
  payload: string;
  publicKey: string;
  output: string;
  tools: { node: PinnedSigningTool; tauriAddon: PinnedSigningTool; verifier: PinnedSigningTool };
}

export function inspectPayloadSigningRequest(value: unknown): PayloadSigningRequest {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    value.repository !== "boburning/portcove" ||
    typeof value.version !== "string" ||
    !versionPattern.test(value.version) ||
    typeof value.source_commit !== "string" ||
    !commit.test(value.source_commit) ||
    !["windows-x86_64", "linux-x86_64"].includes(String(value.platform_label)) ||
    typeof value.filename !== "string" ||
    value.filename !== path.basename(value.filename) ||
    /[\\/]/.test(value.filename) ||
    Array.from(value.filename).some((character) => character.charCodeAt(0) < 32) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1 ||
    Number(value.bytes) > 2 * 1024 ** 3 ||
    !isRecord(value.producer) ||
    !["run_id", "job_id", "artifact_id"].every((key) => {
      const producer = value.producer;
      return (
        isRecord(producer) &&
        typeof producer[key] === "string" &&
        /^[1-9]\d{0,19}$/.test(producer[key])
      );
    }) ||
    !Number.isSafeInteger(value.producer.run_attempt) ||
    Number(value.producer.run_attempt) < 1 ||
    !["sha256", "public_key_sha256", "qualification_inventory_sha256"].every(
      (key) => typeof value[key] === "string" && digest.test(value[key]),
    )
  )
    throw new Error("invalid independently admitted payload signing request");
  // Freeze a detached snapshot before any asynchronous work.
  return JSON.parse(JSON.stringify(value)) as PayloadSigningRequest;
}

/** Open nonblocking/no-follow before inspecting type; never buffer a package. */
async function copyBounded(source: string, destination: string, max: number, trustedTool = false) {
  const input = await open(
    source,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await input.stat();
    if (
      !before.isFile() ||
      (!trustedTool && before.nlink !== 1) ||
      before.size < 1 ||
      before.size > max
    )
      throw new Error("signing input must be a bounded unlinked regular file");
    const output = await open(destination, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      for (;;) {
        const result = await input.read(buffer);
        if (!result.bytesRead) break;
        bytes += result.bytesRead;
        if (bytes > max) throw new Error("signing input exceeds limit");
        const chunk = buffer.subarray(0, result.bytesRead);
        hash.update(chunk);
        let offset = 0;
        while (offset < chunk.length)
          offset += (await output.write(chunk.subarray(offset))).bytesWritten;
      }
      const after = await input.stat();
      if (
        bytes !== before.size ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs
      )
        throw new Error("signing input changed during acquisition");
      return { bytes, sha256: hash.digest("hex") };
    } finally {
      await output.close();
    }
  } finally {
    await input.close();
  }
}

function cleanEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

export function assertSignedPayloadVersion(signature: string, filename: string, version: string) {
  if (signature.length > 16 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature))
    throw new Error("invalid Tauri signature encoding");
  const decoded = Buffer.from(signature, "base64");
  if (decoded.toString("base64") !== signature) throw new Error("noncanonical Tauri signature");
  const lines = decoded.toString("utf8").trimEnd().split("\n");
  if (
    lines.length !== 4 ||
    !/^trusted comment: timestamp:[0-9]+\tfile:/.test(lines[2] ?? "") ||
    lines[2] !==
      `trusted comment: ${lines[2]?.slice("trusted comment: ".length).split("\t")[0]}\tfile:${filename}\tversion:${version}`
  )
    throw new Error("signature does not bind the expected filename and version");
}

export async function signReleasePayload(options: SignPayloadOptions) {
  options = structuredClone(options);
  const request = inspectPayloadSigningRequest(options.request);
  const tools = structuredClone(options.tools);
  if (Object.keys(tools).sort().join(",") !== "node,tauriAddon,verifier")
    throw new Error("only fixed signing tools are allowed");
  const root = path.resolve(options.projectRoot);
  const policy = await loadPackagePolicy(root);
  const identity = updaterIdentity(policy, request.platform_label, request.version);
  const entry = policy.packages.find((item) => item.id === identity.id);
  if (
    !entry ||
    artifactName(entry, request.version) !== request.filename ||
    identity.filename !== request.filename
  )
    throw new Error("payload is not the exact policy NSIS/AppImage identity");
  const output = await assertOwnedUnlinkedPath(root, options.output, "signature output");
  const payload = await assertOwnedUnlinkedPath(root, options.payload, "admitted payload");
  const publicKey = await assertOwnedUnlinkedPath(
    root,
    options.publicKey,
    "independent public key",
  );
  // The caller owns this fresh directory; stale output always refuses before signing.
  await mkdir(output, { mode: 0o700 });
  const scratch = path.join(output, "private-work");
  await mkdir(scratch, { mode: 0o700 });
  try {
    const toolPaths: Record<string, string> = {};
    for (const [name, tool] of Object.entries(tools)) {
      if (!digest.test(tool.sha256) || !path.isAbsolute(tool.path))
        throw new Error("missing trusted tool pin");
      const target = path.join(
        scratch,
        name === "tauriAddon"
          ? "signer.node"
          : `${name}${process.platform === "win32" ? ".exe" : ""}`,
      );
      const actual = await copyBounded(tool.path, target, 256 * 1024 ** 2, true);
      if (actual.sha256 !== tool.sha256) throw new Error("trusted signing tool digest mismatch");
      await chmod(target, 0o700);
      toolPaths[name] = target;
    }
    const localPayload = path.join(scratch, request.filename);
    const actual = await copyBounded(payload, localPayload, request.bytes);
    if (actual.bytes !== request.bytes || actual.sha256 !== request.sha256)
      throw new Error("admitted payload identity mismatch");
    const keyPath = path.join(scratch, "public.key");
    await copyBounded(publicKey, keyPath, 16 * 1024);
    const key = (await readFile(keyPath, "utf8")).trim();
    if (
      !/^[A-Za-z0-9+/]+={0,2}$/.test(key) ||
      sha(Buffer.from(key, "base64")) !== request.public_key_sha256
    )
      throw new Error("independent public key identity mismatch");
    const launcher = path.join(scratch, "signer.cjs");
    await writeFile(
      launcher,
      'const cli=require("./signer.node");cli.run(process.argv.slice(2),"tauri",(e)=>{if(e)process.exitCode=1});',
      { flag: "wx", mode: 0o600 },
    );
    const invoke = async (args: string[], secret = false) => {
      const env = cleanEnvironment();
      if (secret) {
        const privateKey = process.env.TAURI_SIGNING_PRIVATE_KEY;
        if (!privateKey || privateKey.length > 32 * 1024)
          throw new Error("payload signing role private key is required");
        env.TAURI_SIGNING_PRIVATE_KEY = privateKey;
        const password = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ?? "";
        if (password.length > 32 * 1024) throw new Error("invalid signing role password");
        env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = password;
      }
      try {
        return await run(toolPaths.node!, [launcher, ...args], {
          cwd: scratch,
          env,
          timeout: 120_000,
          maxBuffer: 64 * 1024,
        });
      } catch {
        throw new Error("fixed Tauri signer refused; no secret subprocess output retained");
      }
    };
    if ((await invoke(["--version"])).stdout.trim() !== "tauri-cli 2.12.2")
      throw new Error("Tauri signer version mismatch");
    await invoke(["signer", "sign", "--app-version", request.version, localPayload], true);
    const signaturePath = `${localPayload}.sig`;
    // Bound the metadata before reading it; signature output remains private until verification.
    const checkedSignature = path.join(scratch, "checked.sig");
    await copyBounded(signaturePath, checkedSignature, 16 * 1024);
    const signature = (await readFile(checkedSignature, "utf8")).trim();
    let result: unknown;
    try {
      const verified = await run(
        toolPaths.verifier!,
        ["verify", localPayload, checkedSignature, keyPath, request.sha256, String(request.bytes)],
        { cwd: scratch, env: cleanEnvironment(), timeout: 120_000, maxBuffer: 64 * 1024 },
      );
      result = JSON.parse(verified.stdout);
    } catch {
      throw new Error("independent Rust payload verification refused");
    }
    if (
      !isRecord(result) ||
      result.schema_version !== 1 ||
      result.signature_verified !== true ||
      result.sha256 !== request.sha256 ||
      result.bytes !== request.bytes ||
      result.public_key_sha256 !== request.public_key_sha256
    )
      throw new Error("Rust verifier returned a different identity");
    assertSignedPayloadVersion(signature, request.filename, request.version);
    // Publish only detached signature, never package/tool/key bytes.
    await writeFile(path.join(output, `${request.filename}.sig`), signature, {
      flag: "wx",
      mode: 0o600,
    });
    return {
      schema_version: 1 as const,
      kind: "detached-payload-signature" as const,
      request,
      signature: {
        filename: `${request.filename}.sig`,
        bytes: Buffer.byteLength(signature),
        sha256: sha(Buffer.from(signature)),
      },
      signer_version: "2.12.2",
      tools,
      authority: "none" as const,
    };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// CONFIG is trusted controller configuration, never candidate artifact content.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3)
      throw new Error("usage: release-payload-signing.mts TRUSTED_CONFIG");
    const config = await open(
      process.argv[2]!,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let value: unknown;
    try {
      const metadata = await config.stat();
      if (!metadata.isFile() || metadata.size > 64 * 1024)
        throw new Error("invalid trusted signing configuration");
      const buffer = Buffer.alloc(64 * 1024 + 1);
      const { bytesRead } = await config.read(buffer);
      if (bytesRead > 64 * 1024) throw new Error("signing configuration exceeds limit");
      value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } finally {
      await config.close();
    }
    if (
      !isRecord(value) ||
      !isRecord(value.tools) ||
      !["projectRoot", "payload", "publicKey", "output"].every(
        (key) => typeof value[key] === "string",
      ) ||
      !["node", "tauriAddon", "verifier"].every((name) => {
        const tool = value.tools;
        return (
          isRecord(tool) &&
          isRecord(tool[name]) &&
          typeof tool[name].path === "string" &&
          typeof tool[name].sha256 === "string"
        );
      })
    )
      throw new Error("invalid trusted signing configuration");
    const result = await signReleasePayload(value as unknown as SignPayloadOptions);
    await writeFile(
      path.join(String(value.output), "payload-signing-receipt.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch {
    console.error("isolated payload signing refused; no secret diagnostic output emitted");
    process.exitCode = 1;
  }
}
