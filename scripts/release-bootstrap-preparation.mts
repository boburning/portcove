/** Public-only bootstrap context preparation. The actual maintained Rust tool
 * verifies offline signatures/expiry before this module retains a private
 * preparation receipt. Provider/configuration/job authority remains separate. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, writeFile, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  inspectMetadataBootstrapDescriptor,
  metadataInstant,
} from "./release-metadata-contract.mts";
import { inspectPublicationAuthorities } from "./release-authority-configuration.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roles = ["targets", "snapshot", "timestamp", "releases", "preview", "stable"] as const;
type Descriptor = ReturnType<typeof inspectMetadataBootstrapDescriptor>;
const fileNames = [
  "context.json",
  "initial-bootstrap.json",
  "trusted-root.json",
  "offline-targets.json",
  "payload.json",
  "records/reconstruction-manifest.json",
];
const identities = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha(bytes) }));
type Preparation = {
  prepared_root: string;
  context: string;
  descriptor: Descriptor;
  descriptor_sha256: string;
  files: ReturnType<typeof identities>;
  verifier: string;
  verifier_sha256: string;
  deadline: number;
};
const preparations = new WeakMap<object, Preparation>();

function remaining(deadline: number) {
  const left = Math.floor(deadline - performance.now());
  if (!Number.isFinite(left) || left < 1)
    throw new Error("bootstrap preparation deadline exhausted");
  return Math.min(left, 120000);
}
function signedPublic(bytes: Buffer) {
  const value: unknown = JSON.parse(
    bytes.toString("utf8"),
    (key: string, value: unknown, context?: { source?: string }) => {
      if (key === "version" && typeof value === "number") {
        if (!context?.source || !/^[1-9][0-9]*$/u.test(context.source))
          throw new Error("offline version representation differs");
        return context.source;
      }
      return value;
    },
  );
  if (
    !isRecord(value) ||
    !isRecord(value.signed) ||
    typeof value.signed.version !== "string" ||
    typeof value.signed.expires !== "string"
  )
    throw new Error("offline public metadata shape differs");
  // Signed RFC3339 bytes may retain nanosecond trailing zeroes. Only the
  // declared time projection is canonicalized; signed bytes stay untouched.
  const expires = value.signed.expires.replace(/\.([0-9]*?)0+Z$/u, (_all, fraction: string) =>
    fraction ? `.${fraction}Z` : "Z",
  );
  metadataInstant(expires);
  return { version: value.signed.version, expires };
}
function instantText(value: bigint) {
  const seconds = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/u, "");
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}${fraction ? `.${fraction}` : ""}Z`;
}
/** Declared context only. The later fixed Rust preflight must verify all public
 * signatures and descriptor constraints before any actual receipt is minted. */
export function deriveMetadataBootstrapDescriptor(
  publication: unknown,
  publicFiles: ReadonlyMap<string, Buffer>,
  generatedAt: string,
) {
  const pins = inspectPublicationAuthorities(publication, 2);
  if (!pins.public_source.initial_site_preimage)
    throw new Error("explicit setup preimage locator required");
  const read = (name: "root" | "offline_targets" | "payload_key_registry") => {
    const bytes = publicFiles.get(name),
      pin = pins.public_source[name];
    if (!bytes || bytes.length !== pin.bytes || sha(bytes) !== pin.sha256)
      throw new Error("ratified bootstrap public input changed");
    return bytes;
  };
  const root = signedPublic(read("root")),
    top = signedPublic(read("offline_targets"));
  read("payload_key_registry");
  const generated = metadataInstant(generatedAt);
  const expires = Object.fromEntries(
    roles.map((role) => {
      if (role === "targets") return [role, top.expires];
      const days = role === "timestamp" ? 2 : role === "releases" ? 90 : 7;
      const next = instantText(generated + BigInt(days) * 86_400_000_000_000n);
      const expiry = [next, top.expires, root.expires].sort((a, b) =>
        metadataInstant(a) < metadataInstant(b) ? -1 : 1,
      )[0]!;
      return [role, expiry];
    }),
  );
  return inspectMetadataBootstrapDescriptor({
    schema_version: 1,
    kind: "application-tuf-initial-bootstrap",
    generated_at: generatedAt,
    setup_plan_sha256: pins.setup_plan_sha256,
    initial_site_preimage_sha256: pins.initial_site_preimage_sha256,
    root_sha256: pins.public_source.root.sha256,
    offline_targets_sha256: pins.public_source.offline_targets.sha256,
    payload_key_registry_sha256: pins.public_source.payload_key_registry.sha256,
    initial_records_sha256: digest([]),
    versions: Object.fromEntries(
      roles.map((role) => [role, role === "targets" ? top.version : "1"]),
    ),
    expires,
  });
}
export function metadataBootstrapContextBytes(raw: unknown) {
  const descriptor = inspectMetadataBootstrapDescriptor(raw);
  const base = JSON.stringify({
    schema_version: 1,
    generated_at: descriptor.generated_at,
    trusted_root: "trusted-root.json",
    offline_targets: "offline-targets.json",
    payload_key_registry: "payload.json",
    reconstructed_records: "records",
    initial_bootstrap: "initial-bootstrap.json",
    expires: descriptor.expires,
  });
  const versions = `{${roles.map((role) => `${JSON.stringify(role)}:${descriptor.versions[role]}`).join(",")}}`;
  return Buffer.from(`${base.slice(0, -1)},"versions":${versions}}\n`);
}
async function tree(root: string) {
  const files = new Map<string, Buffer>();
  const rows = await readdir(root, { withFileTypes: true });
  if (
    rows.length !== 6 ||
    rows.some(
      (row) =>
        row.isSymbolicLink() || (row.name === "records" ? !row.isDirectory() : !row.isFile()),
    ) ||
    rows.some(
      (row) => ![...fileNames.filter((name) => !name.includes("/")), "records"].includes(row.name),
    )
  )
    throw new Error("bootstrap prepared root contains unexpected entries");
  const records = await readdir(path.join(root, "records"));
  if (records.join(",") !== "reconstruction-manifest.json")
    throw new Error("bootstrap records must remain empty");
  for (const name of fileNames) {
    const filename = await assertOwnedUnlinkedPath(
      root,
      path.join(root, name),
      "bootstrap public preparation",
    );
    const stat = await lstat(filename);
    if (stat.nlink !== 1) throw new Error("bootstrap prepared input is hardlinked");
    files.set(name, await readControllerToolFile(filename, 1024 * 1024));
  }
  return files;
}
function validateReport(raw: unknown, files: ReadonlyMap<string, Buffer>, descriptor: Descriptor) {
  if (
    !isRecord(raw) ||
    Object.keys(raw).sort().join(",") !==
      "authority,context_sha256,descriptor_sha256,expires,initial_records_sha256,offline_targets_sha256,payload_key_registry_sha256,root_sha256,schema_version,versions" ||
    raw.schema_version !== 1 ||
    raw.authority !== "none" ||
    raw.context_sha256 !== sha(files.get("context.json")!) ||
    raw.descriptor_sha256 !== sha(files.get("initial-bootstrap.json")!) ||
    raw.root_sha256 !== descriptor.root_sha256 ||
    raw.offline_targets_sha256 !== descriptor.offline_targets_sha256 ||
    raw.payload_key_registry_sha256 !== descriptor.payload_key_registry_sha256 ||
    raw.initial_records_sha256 !== descriptor.initial_records_sha256 ||
    digest(raw.versions) !== digest(descriptor.versions) ||
    digest(raw.expires) !== digest(descriptor.expires)
  )
    throw new Error("actual bootstrap verifier report differs from retained public context");
}
export async function prepareAuthenticatedMetadataBootstrap(request: {
  verifier: string;
  verifier_sha256: string;
  publication: unknown;
  public_files: ReadonlyMap<string, Buffer>;
  descriptor: unknown;
  output_parent: string;
  deadline: number;
}) {
  const selected = {
    ...request,
    publication: structuredClone(request.publication),
    descriptor: structuredClone(request.descriptor),
    public_files: new Map(
      [...request.public_files].map(([name, bytes]) => [name, Buffer.from(bytes)]),
    ),
  };
  remaining(selected.deadline);
  const descriptor = inspectMetadataBootstrapDescriptor(selected.descriptor),
    pins = inspectPublicationAuthorities(selected.publication, 2);
  const derived = deriveMetadataBootstrapDescriptor(
    pins,
    selected.public_files,
    descriptor.generated_at,
  );
  for (const key of [
    "generated_at",
    "setup_plan_sha256",
    "initial_site_preimage_sha256",
    "root_sha256",
    "offline_targets_sha256",
    "payload_key_registry_sha256",
    "initial_records_sha256",
    "versions",
  ] as const)
    if (digest(derived[key]) !== digest(descriptor[key]))
      throw new Error("bootstrap descriptor differs from exact ratified public inputs");
  if (
    descriptor.expires.targets !== derived.expires.targets ||
    roles.some(
      (role) => metadataInstant(descriptor.expires[role]) > metadataInstant(derived.expires[role]),
    )
  )
    throw new Error("bootstrap descriptor expiry exceeds ratified offline anchors or role ceiling");
  if (!path.isAbsolute(selected.output_parent) || !path.isAbsolute(selected.verifier))
    throw new Error("absolute bootstrap tool/output paths required");
  const parent = await lstat(selected.output_parent);
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    (await realpath(selected.output_parent)) !== path.resolve(selected.output_parent)
  )
    throw new Error("bootstrap private parent is linked or unavailable");
  const tool = await readControllerToolFile(selected.verifier);
  if (sha(tool) !== selected.verifier_sha256)
    throw new Error("actual qualified bootstrap verifier changed");
  const work = await mkdtemp(path.join(selected.output_parent, "bootstrap-"));
  const verifier = path.join(
      work,
      process.platform === "win32" ? "bootstrap-verifier.exe" : "bootstrap-verifier",
    ),
    prepared = path.join(work, "prepared");
  try {
    await writeFile(verifier, tool, { flag: "wx", mode: 0o700 });
    await mkdir(prepared, { mode: 0o700 });
    await mkdir(path.join(prepared, "records"), { mode: 0o700 });
    const files = new Map([
      ["context.json", metadataBootstrapContextBytes(descriptor)],
      ["initial-bootstrap.json", Buffer.from(JSON.stringify(descriptor))],
      ["trusted-root.json", selected.public_files.get("root")!],
      ["offline-targets.json", selected.public_files.get("offline_targets")!],
      ["payload.json", selected.public_files.get("payload_key_registry")!],
      ["records/reconstruction-manifest.json", Buffer.from('{"schema_version":1,"records":[]}')],
    ]);
    for (const [name, bytes] of files)
      await writeFile(path.join(prepared, name), bytes, { flag: "wx", mode: 0o600 });
    const context = path.join(prepared, "context.json");
    const result = await run(verifier, ["inspect-tuf-bootstrap", context], {
      cwd: work,
      timeout: remaining(selected.deadline),
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      env: {
        PATH: process.platform === "win32" ? `${process.env.SystemRoot}/System32` : "/usr/bin:/bin",
        SystemRoot: process.env.SystemRoot,
        HOME: work,
        TMP: work,
        TEMP: work,
        TMPDIR: work,
      },
    });
    remaining(selected.deadline);
    await writeFile(path.join(work, "verifier.stdout.json"), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(path.join(work, "verifier.stderr.log"), result.stderr, {
      flag: "wx",
      mode: 0o600,
    });
    const retained = await tree(prepared);
    if (digest(identities(retained)) !== digest(identities(files)))
      throw new Error("bootstrap context changed during verification");
    validateReport(JSON.parse(result.stdout) as unknown, retained, descriptor);
    if (sha(await readControllerToolFile(verifier)) !== selected.verifier_sha256)
      throw new Error("bootstrap verifier changed during execution");
    const receipt = Object.freeze({
      kind: "authenticated-initial-metadata-preparation",
      descriptor_sha256: digest(descriptor),
    });
    preparations.set(receipt, {
      prepared_root: prepared,
      context,
      descriptor,
      descriptor_sha256: digest(descriptor),
      files: identities(files),
      verifier,
      verifier_sha256: selected.verifier_sha256,
      deadline: selected.deadline,
    });
    await inspectPreparedMetadataBootstrap(receipt);
    return receipt;
  } catch (error) {
    if (isRecord(error))
      for (const [key, name] of [
        ["stdout", "failed-verifier.stdout.json"],
        ["stderr", "failed-verifier.stderr.log"],
      ] as const)
        if (typeof error[key] === "string" || Buffer.isBuffer(error[key]))
          await writeFile(path.join(work, name), error[key], { flag: "wx", mode: 0o600 });
    await writeFile(
      path.join(work, "refusal.json"),
      JSON.stringify({
        phase: "bootstrap-public-verification",
        authority: "none",
        automatic_retry: false,
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error(`actual bootstrap preparation refused; retain ${work}`, { cause: error });
  }
}
export async function inspectPreparedMetadataBootstrap(receipt: object, phaseDeadline?: number) {
  const owned = preparations.get(receipt);
  if (!owned) throw new Error("actual same-process bootstrap preparation required");
  if (phaseDeadline !== undefined) {
    remaining(phaseDeadline);
    owned.deadline = Math.min(owned.deadline, phaseDeadline);
  }
  remaining(owned.deadline);
  const files = await tree(owned.prepared_root);
  if (
    digest(identities(files)) !== digest(owned.files) ||
    sha(await readControllerToolFile(owned.verifier)) !== owned.verifier_sha256
  )
    throw new Error("actual bootstrap preparation bytes changed");
  remaining(owned.deadline);
  return structuredClone(owned);
}
