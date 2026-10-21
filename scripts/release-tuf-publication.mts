/** Keyless assembly of five role envelopes. Imported tool reports remain data;
 * only the actual context/tool/role receiver chain can mint the private session. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { verifiedControllerToolPaths } from "./release-controller-tool-admission.mts";
import {
  inspectTufPublicationFacts,
  assertMetadataRenewalPublication,
  assertMetadataBootstrapPublication,
} from "./release-metadata-contract.mts";
import { inspectMetadataSigningBinding } from "./release-metadata-signing-contract.mts";
import { payloadSigningEnvironment } from "./release-payload-signing.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import {
  requireReceivedSigningContext,
  requireRetainedSigningContext,
} from "./release-signing-context-artifact.mts";
import {
  requireReceivedTufRoleArtifact,
  requireRetainedTufRoleArtifact,
} from "./release-tuf-role-artifact.mts";
import { inspectTufContextPaths } from "./release-tuf-signing.mts";
import { isRecord } from "./runtime-values.mts";

const run = promisify(execFile);
const roles = ["releases", "preview", "stable", "snapshot", "timestamp"] as const;
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const inventory = (files: ReadonlyMap<string, Buffer>) =>
  [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) }));
function remaining(deadline: number) {
  const left = Math.floor(deadline - performance.now());
  if (!Number.isFinite(deadline) || left < 1) throw new Error("keyless TUF deadline exhausted");
  return Math.min(left, 90000);
}
type Envelope = { filename: string; path: string; bytes: number; sha256: string };
export function inspectTufAssemblyInputs(raw: unknown): readonly Envelope[] {
  if (!Array.isArray(raw) || raw.length !== 5) throw new Error("five exact TUF envelopes required");
  return Object.freeze(
    raw.map((file: unknown, index) => {
      if (
        !isRecord(file) ||
        Object.keys(file).sort().join(",") !== "bytes,filename,path,sha256" ||
        file.filename !== `${roles[index]}.json` ||
        typeof file.path !== "string" ||
        !path.isAbsolute(file.path) ||
        typeof file.bytes !== "number" ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        file.bytes > 512 * 1024 ||
        typeof file.sha256 !== "string" ||
        !/^[a-f0-9]{64}$/u.test(file.sha256)
      )
        throw new Error("five exact TUF envelopes required");
      return Object.freeze({
        filename: String(file.filename),
        path: file.path,
        bytes: file.bytes,
        sha256: file.sha256,
      });
    }),
  );
}

/** Byte utility, no provider/qualification/publication authority. The actual
 * wrapper below supplies the fixed authenticated tool and public inputs. */
export async function assembleIsolatedTufPublication(
  raw: {
    context_directory: string;
    tool: { path: string; sha256: string };
    signed_roles: readonly Envelope[];
    output_parent: string;
  },
  deadline: number,
) {
  const request = structuredClone(raw),
    signed = inspectTufAssemblyInputs(request.signed_roles);
  remaining(deadline);
  if (
    !path.isAbsolute(request.context_directory) ||
    !path.isAbsolute(request.output_parent) ||
    !path.isAbsolute(request.tool.path) ||
    !/^[a-f0-9]{64}$/u.test(request.tool.sha256) ||
    releasePathContains(request.context_directory, request.output_parent)
  )
    throw new Error("fixed disjoint keyless TUF paths required");
  const source = await readBoundedReleaseContextFiles(request.context_directory);
  const context = source.get("context.json");
  if (!context) throw new Error("keyless TUF public context missing");
  inspectTufContextPaths(context);
  const original = digest(inventory(source)),
    toolBytes = await readControllerToolFile(request.tool.path);
  if (hash(toolBytes) !== request.tool.sha256) throw new Error("keyless TUF tool changed");
  remaining(deadline);
  const directory = await mkdtemp(path.join(request.output_parent, "tuf-publication-"));
  await chmod(directory, 0o700);
  const inputs = path.join(directory, "public-inputs"),
    signedRoot = path.join(directory, "signed-roles"),
    scratch = path.join(directory, "private-work"),
    repository = path.join(directory, "repository");
  let phase = "stage-public-inputs";
  try {
    for (const root of [inputs, signedRoot, scratch]) await mkdir(root, { mode: 0o700 });
    for (const [name, bytes] of source) {
      remaining(deadline);
      const destination = await assertOwnedUnlinkedPath(
        inputs,
        path.join(inputs, name),
        "keyless TUF input",
      );
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    for (const file of signed) {
      const bytes = await readControllerToolFile(file.path, file.bytes);
      if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
        throw new Error("keyless role input changed");
      await writeFile(path.join(signedRoot, file.filename), bytes, { flag: "wx", mode: 0o600 });
    }
    const env = payloadSigningEnvironment(scratch);
    for (const value of new Set(Object.values(env)))
      if (typeof value === "string" && value.startsWith(scratch))
        await mkdir(value, { recursive: true, mode: 0o700 });
    const tool = path.join(
        scratch,
        process.platform === "win32" ? "release-tools.exe" : "release-tools",
      ),
      config = path.join(scratch, "assemble.json");
    await writeFile(tool, toolBytes, { flag: "wx", mode: 0o700 });
    await chmod(tool, 0o700);
    await writeFile(
      config,
      JSON.stringify({
        schema_version: 1,
        context: path.join(inputs, "context.json"),
        signed_roles: signedRoot,
        output: repository,
      }),
      { flag: "wx", mode: 0o600 },
    );
    phase = "fixed-keyless-verifier";
    const result = await run(tool, ["assemble-tuf", config], {
      cwd: scratch,
      env,
      timeout: remaining(deadline),
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
      windowsHide: true,
    });
    remaining(deadline);
    await writeFile(path.join(directory, "assembly-report-raw.json"), result.stdout, {
      flag: "wx",
      mode: 0o600,
    });
    phase = "validate-keyless-report";
    const report: unknown = JSON.parse(result.stdout),
      files = await readBoundedReleaseContextFiles(repository);
    if (
      result.stderr ||
      !isRecord(report) ||
      Object.keys(report).sort().join(",") !==
        "changed,files,output,publication,records,schema_version" ||
      report.schema_version !== 1 ||
      report.changed !== true ||
      report.output !== repository ||
      typeof report.records !== "number" ||
      !Number.isSafeInteger(report.records) ||
      report.records < 0
    )
      throw new Error("actual keyless TUF report differs");
    const publicFiles = new Map(files);
    publicFiles.delete("repository-manifest.json");
    if (digest(report.files) !== digest(inventory(files)))
      throw new Error("keyless TUF report inventory differs");
    const publication = inspectTufPublicationFacts(report.publication);
    const required = (name: string) => {
      const bytes = files.get(name);
      if (!bytes) throw new Error("keyless TUF output missing");
      return bytes;
    };
    const records = new Map(
      [...source]
        .filter(
          ([name]) =>
            name.startsWith("records/") && name !== "records/reconstruction-manifest.json",
        )
        .map(([name, bytes]) => [name.slice(8), bytes]),
    );
    const targets = new Map(records);
    const payload = source.get("payload.json");
    if (!payload) throw new Error("keyless TUF payload registry missing");
    targets.set("keys/payload.json", payload);
    for (const [name, bytes] of targets)
      if (!required(`targets/${hash(bytes)}.${name}`).equals(bytes))
        throw new Error("keyless TUF target differs from exact public context");
    if (
      publication.repository_sha256 !== digest(inventory(publicFiles)) ||
      publication.records_sha256 !== digest(inventory(records)) ||
      publication.root_sha256 !== hash(source.get("trusted-root.json")!) ||
      publication.offline_targets_sha256 !== hash(source.get("offline-targets.json")!) ||
      publication.timestamp_sha256 !== hash(required("metadata/timestamp.json")) ||
      publication.snapshot_sha256 !==
        hash(required(`metadata/${publication.versions.snapshot}.snapshot.json`))
    )
      throw new Error("keyless TUF facts differ from actual bytes");
    phase = "public-custody-readback";
    if (
      original !==
        digest(inventory(await readBoundedReleaseContextFiles(request.context_directory))) ||
      original !== digest(inventory(await readBoundedReleaseContextFiles(inputs))) ||
      hash(await readControllerToolFile(tool)) !== request.tool.sha256 ||
      hash(await readControllerToolFile(request.tool.path)) !== request.tool.sha256
    )
      throw new Error("keyless TUF custody changed");
    for (const file of signed) {
      for (const name of [file.path, path.join(signedRoot, file.filename)]) {
        const bytes = await readControllerToolFile(name, file.bytes);
        if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
          throw new Error("keyless TUF role custody changed");
      }
    }
    const reportBytes = Buffer.from(JSON.stringify(report));
    await writeFile(path.join(directory, "assembly-report.json"), reportBytes, {
      flag: "wx",
      mode: 0o600,
    });
    remaining(deadline);
    return Object.freeze({
      directory,
      repository,
      publication,
      records: report.records,
      files: inventory(files),
      input_files: inventory(source),
      signed_files: signed.map(({ filename, bytes, sha256 }) => ({
        path: filename,
        bytes,
        sha256,
      })),
      report_sha256: hash(reportBytes),
      authority: "none" as const,
    });
  } catch {
    await writeFile(
      path.join(directory, "refusal.json"),
      JSON.stringify({
        phase,
        context_inventory_sha256: original,
        tool_sha256: request.tool.sha256,
        authority: "none",
      }),
      { flag: "wx", mode: 0o600 },
    );
    throw new Error("keyless TUF assembly refused; public evidence retained");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const publications = new WeakMap<
  object,
  {
    context: object;
    tools: object;
    roles: readonly object[];
    deadline: number;
    result: Awaited<ReturnType<typeof assembleIsolatedTufPublication>>;
  }
>();
export async function prepareActualTufPublication(
  contextReceipt: object,
  toolReceipt: object,
  rawRoles: readonly object[],
  parent: string,
  deadline: number,
) {
  remaining(deadline);
  if (!Array.isArray(rawRoles) || rawRoles.length !== 5)
    throw new Error("five actual attested TUF role receipts required");
  const captured: readonly object[] = Array.from(rawRoles as readonly object[]),
    context = await requireReceivedSigningContext(contextReceipt, deadline),
    tools = await verifiedControllerToolPaths(toolReceipt),
    manifest = context.manifest;
  if (
    !isRecord(manifest.controller) ||
    !isRecord(manifest.binding) ||
    manifest.controller.controller_revision !== tools.identity.controller_revision ||
    manifest.controller.source_tree !== tools.identity.source_tree ||
    manifest.controller.controller_ref !== tools.identity.controller_ref
  )
    throw new Error("current tool source differs from authenticated TUF context");
  const contextManifest = hash(
    await readControllerToolFile(
      path.join(context.directory, "signing-context-manifest.json"),
      1024 * 1024,
    ),
  );
  const envelopes = [];
  for (let index = 0; index < 5; index++) {
    const role = await requireReceivedTufRoleArtifact(captured[index]!, deadline);
    if (
      role.role !== roles[index] ||
      role.expected.context_manifest_sha256 !== contextManifest ||
      role.expected.context_binding_sha256 !== digest(manifest.binding) ||
      role.expected.context_facts_sha256 !== manifest.facts_sha256
    )
      throw new Error("actual TUF role context binding differs");
    envelopes.push(role.envelope);
  }
  const result = await assembleIsolatedTufPublication(
    {
      context_directory: path.dirname(context.context),
      tool: { path: tools.rust, sha256: hash(await readControllerToolFile(tools.rust)) },
      signed_roles: envelopes,
      output_parent: parent,
    },
    deadline,
  );
  if (result.publication.records_sha256 !== manifest.binding.records_sha256)
    throw new Error("actual assembled record set differs from private context");
  if (manifest.kind === "metadata-signing-context") {
    const metadata = inspectMetadataSigningBinding(
      manifest.facts,
      manifest.binding,
      manifest.previous_site_pins,
    );
    (metadata.facts.mode === "renewal"
      ? assertMetadataRenewalPublication
      : assertMetadataBootstrapPublication)(metadata.facts.descriptor, result.publication);
  }
  const receipt = Object.freeze({ kind: "actual-keyless-TUF-publication", authority: "none" });
  publications.set(receipt, {
    context: contextReceipt,
    tools: toolReceipt,
    roles: captured,
    deadline,
    result,
  });
  await requireActualTufPublication(receipt);
  return receipt;
}
async function readActualTufPublication(
  receipt: object,
  phaseDeadline: number | undefined,
  provider: "fresh" | "retained",
) {
  const actual = publications.get(receipt);
  if (!actual) throw new Error("actual keyless TUF publication required");
  if (phaseDeadline !== undefined) {
    remaining(phaseDeadline);
    actual.deadline = Math.min(actual.deadline, phaseDeadline);
  }
  remaining(actual.deadline);
  const context = await (
      provider === "fresh" ? requireReceivedSigningContext : requireRetainedSigningContext
    )(actual.context, actual.deadline),
    tools = await verifiedControllerToolPaths(actual.tools);
  for (const role of actual.roles)
    await (provider === "fresh" ? requireReceivedTufRoleArtifact : requireRetainedTufRoleArtifact)(
      role,
      actual.deadline,
    );
  if (
    digest(
      inventory(
        await readBoundedReleaseContextFiles(path.join(actual.result.directory, "public-inputs")),
      ),
    ) !== digest(actual.result.input_files) ||
    digest(
      inventory(
        await readBoundedReleaseContextFiles(path.join(actual.result.directory, "signed-roles")),
      ),
    ) !== digest(actual.result.signed_files) ||
    digest(inventory(await readBoundedReleaseContextFiles(actual.result.repository))) !==
      digest(actual.result.files) ||
    hash(
      await readControllerToolFile(
        path.join(actual.result.directory, "assembly-report.json"),
        1024 * 1024,
      ),
    ) !== actual.result.report_sha256
  )
    throw new Error("actual keyless TUF retained output changed");
  remaining(actual.deadline);
  return Object.freeze({
    context_receipt: actual.context,
    tools_receipt: actual.tools,
    context,
    tools,
    repository: actual.result.repository,
    input_root: path.join(actual.result.directory, "public-inputs"),
    context_path: path.join(actual.result.directory, "public-inputs", "context.json"),
    signed_roles: path.join(actual.result.directory, "signed-roles"),
    publication: structuredClone(actual.result.publication),
    records: actual.result.records,
    provenance:
      provider === "fresh"
        ? ("fresh-provider-readback" as const)
        : ("original-verified-snapshot" as const),
    authority: "none" as const,
  });
}
export function requireActualTufPublication(receipt: object, phaseDeadline?: number) {
  return readActualTufPublication(receipt, phaseDeadline, "fresh");
}
/** Static cryptographic provenance only; current controls/native/publication
 * readbacks stay with their owning live consumers. The actual mint still uses
 * the full default-provider receivers and fixed keyless verifier. */
export function requireRetainedActualTufPublication(receipt: object, phaseDeadline?: number) {
  return readActualTufPublication(receipt, phaseDeadline, "retained");
}
