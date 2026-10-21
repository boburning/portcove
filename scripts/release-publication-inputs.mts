/** Bounded byte reconstruction only. The caller must first authenticate the
 * complete signing context; this function cannot create an admission receipt. */
import { createHash } from "node:crypto";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { inspectPublicationRecordAssociation } from "./release-publication-result.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { isRecord } from "./runtime-values.mts";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { requireReceivedSigningContext } from "./release-signing-context-artifact.mts";
import { readBoundedReleaseContextFiles } from "./release-signing-context.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { artifactName, packagesForPlatform } from "./release-package-policy.mts";
import { checkCoordinatorDeadline } from "./release-coordinator-deadline.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export async function reconstructPublicationSignatures(
  manifest: unknown,
  facts: unknown,
  files: ReadonlyMap<string, Buffer>,
) {
  if (!isRecord(manifest) || !isRecord(manifest.binding) || !isRecord(facts))
    throw new Error("complete publication signing context required");
  const binding = manifest.binding;
  const { accepted, policy, labels } = await inspectTrustedAssemblyInput(facts.assembly);
  if (labels.length !== 2) throw new Error("exact detached signature pair required");
  const candidates = labels.map((platform) => {
    const updater = updaterIdentity(policy, platform, accepted.version);
    const raw = files.get(
      `records/releases/${accepted.version}/${updater.target}/${updater.format}.json`,
    );
    if (!raw || raw.length > 1024 ** 2) throw new Error("bounded signed updater record required");
    const record: unknown = JSON.parse(raw.toString("utf8"));
    if (
      !isRecord(record) ||
      !isRecord(record.artifact) ||
      typeof record.artifact.tauri_signature !== "string" ||
      Buffer.byteLength(record.artifact.tauri_signature) > 16384
    )
      throw new Error("original detached signature text missing");
    const text = record.artifact.tauri_signature;
    return ["", "\n", "\r\n"].map((ending) => {
      const bytes = Buffer.from(text + ending);
      return {
        platform,
        filename: `${updater.filename}.sig`,
        bytes,
        identity: {
          platform,
          filename: `${updater.filename}.sig`,
          bytes: bytes.length,
          sha256: hash(bytes),
        },
      };
    });
  });
  const matches = candidates[0]!.flatMap((a) =>
    candidates[1]!.flatMap((b) => {
      const pair = [a, b];
      return [pair, [...pair].reverse()].some(
        (ordered) => digest(ordered.map((item) => item.identity)) === binding.signatures_sha256,
      )
        ? [pair]
        : [];
    }),
  );
  if (matches.length !== 1) throw new Error("original detached signature pair digest differs");
  const signatures = matches[0]!;
  await inspectPublicationRecordAssociation(
    manifest,
    facts,
    [
      ...accepted.files.map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 })),
      ...signatures.map(({ identity }) => identity),
    ],
    files,
  );
  return signatures.map(({ platform, filename, bytes }) => ({
    platform,
    filename,
    bytes: Buffer.from(bytes),
  }));
}

/** Only the authenticated receiver can supply the original record/pair binding.
 * Packages remain inert and are independently verified by the existing updater
 * inventory/Rust signature verifier after this bounded materialization. */
export async function materializePublicationUpdaterRoots(
  contextReceipt: object,
  facts: unknown,
  packageRoot: string,
  output: string,
  publicKey: Buffer,
  deadline: number,
) {
  const context = await requireReceivedSigningContext(contextReceipt, deadline);
  const files = await readBoundedReleaseContextFiles(path.dirname(context.context));
  const signatures = await reconstructPublicationSignatures(context.manifest, facts, files);
  if (!isRecord(facts)) throw new Error("actual admitted publication facts required");
  const { accepted, policy } = await inspectTrustedAssemblyInput(facts.assembly);
  const key = publicKey.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(key))
    throw new Error("fixed updater public key encoding differs");
  const roots = [];
  for (const signature of signatures) {
    const platform = signature.platform;
    const directory = path.join(output, `updater-${platform}`);
    await mkdir(directory, { mode: 0o700 });
    const packages = [];
    for (const entry of packagesForPlatform(policy, platform)) {
      checkCoordinatorDeadline();
      const filename = artifactName(entry, accepted.version);
      const expected = accepted.files.find(
        (file) => file.platform_label === platform && file.filename === filename,
      );
      if (!expected) throw new Error("signed package inventory differs");
      const bytes = await readControllerToolFile(path.join(packageRoot, filename), 512 * 1024 ** 2);
      if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
        throw new Error("signed package bytes differ");
      await writeFile(path.join(directory, filename), bytes, { flag: "wx", mode: 0o600 });
      packages.push({ id: entry.id, filename, bytes: bytes.length, sha256: hash(bytes) });
    }
    const updater = updaterIdentity(policy, platform, accepted.version);
    const pkg = packages.find((file) => file.filename === updater.filename);
    if (!pkg) throw new Error("signed updater package missing");
    await writeFile(path.join(directory, signature.filename), signature.bytes, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      path.join(directory, "updater-inventory.json"),
      JSON.stringify({
        schema_version: 1,
        repository: "boburning/portcove",
        version: accepted.version,
        source_commit: accepted.source_commit,
        platform_label: platform,
        application_identifier: "io.github.portcove.portcove",
        packages,
        updater: {
          ...pkg,
          target: updater.target,
          format: updater.format,
          public_key_sha256: hash(Buffer.from(key, "base64")),
          signature: {
            filename: signature.filename,
            bytes: signature.bytes.length,
            sha256: hash(signature.bytes),
          },
        },
      }),
      { flag: "wx", mode: 0o600 },
    );
    roots.push({ platform, directory });
  }
  await requireReceivedSigningContext(contextReceipt, deadline);
  checkCoordinatorDeadline();
  return roots;
}
