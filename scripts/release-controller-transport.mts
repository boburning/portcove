/** Fixed job-local Actions routing only. These locators and acknowledgements
 * convey no release, key, provider or journal authority. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, open, lstat, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { isRecord } from "./runtime-values.mts";
import { readControllerToolFile } from "./release-controller-tools.mts";
import { assertOwnedUnlinkedPath, releasePathContains } from "./release-path-safety.mts";
import {
  inspectReleaseControlPhase,
  releaseControlPhaseProfile,
} from "./release-control-phases.mts";
import {
  inspectControlStepReadiness,
  controlBridgeOriginalDeadline,
} from "./release-control-step-bridge.mts";
import { GitHubApiClient, createGitHubRunner } from "./github-api.mts";
import { inspectCatalogSigningBinding } from "./release-catalog-signing-contract.mts";
import { retainReleaseRoutingMarker as retain } from "./release-routing-marker.mts";

const kinds = [
  "role-key",
  "signature",
  "context",
  "result",
  "site",
  "aggregate",
  "attest",
] as const;
type Kind = (typeof kinds)[number];
type Phase = ReturnType<typeof inspectReleaseControlPhase>;
const phaseBudgets: Record<Phase, number> = {
  admission: 535000,
  payload: 570000,
  coordinator: 170000,
  "release-publication": 350000,
  "site-publication": 290000,
  "tuf-releases": 115000,
  "tuf-preview": 115000,
  "tuf-stable": 115000,
  "tuf-snapshot": 115000,
  "tuf-timestamp": 115000,
  "catalog-definitions": 115000,
  "catalog-policy": 115000,
  "catalog-snapshot": 115000,
  "catalog-timestamp": 115000,
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const exact = (raw: unknown, keys: string): raw is Record<string, unknown> =>
  isRecord(raw) && Object.keys(raw).sort().join(",") === keys;
function active(deadline: number) {
  if (!Number.isFinite(deadline) || deadline <= performance.now())
    throw new Error("original transport deadline exhausted; retain pending effects");
}
function filename(root: string, phase: Phase, suffix: string) {
  return path.join(root, `controller-transport-${phase}-${suffix}.json`);
}
async function retainBytes(file: string, bytes: Buffer) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Settlement is routing data, never acceptance. Publish complete markers for
 * concurrent readers; preserve the older bridge's exact separate schema. */
export async function retainControllerJobSettlement(
  root: string,
  rawPhase: unknown,
  exitCode: number,
  requiresAttestation: boolean,
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (
    !path.isAbsolute(root) ||
    ![0, 1].includes(exitCode) ||
    typeof requiresAttestation !== "boolean"
  )
    throw new Error("fixed job settlement differs");
  await retain(path.join(root, `controller-job-settlement-${phase}.json`), {
    exit_code: exitCode,
    requires_attestation: requiresAttestation,
  });
  await retain(path.join(root, `release-control-${phase}-process-ended.json`), {
    exit_code: exitCode,
  });
}
function bundleRoute(phase: Phase, contextKind?: "catalog-signing-context") {
  if (!allowed(phase, "attest")) throw new Error("fixed attestation phase required");
  const prefix =
    phase === "coordinator"
      ? contextKind === "catalog-signing-context"
        ? "trusted-catalog-signing-context"
        : "trusted-coordinator-signing-context"
      : phase === "payload"
        ? "trusted-payload-signing-context"
        : phase === "release-publication"
          ? "trusted-immutable-release-result"
          : `trusted-${phase}`;
  return {
    name: `${prefix}-attestation-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
    filename:
      phase === "release-publication"
        ? "immutable-release-result-attestation.json"
        : phase.startsWith("tuf-") || phase.startsWith("catalog-")
          ? "role-attestation.json"
          : "signing-context-attestation.json",
  };
}
/** Copies only the completed pinned Action's bounded raw bundle. This is
 * transport normalization, never signature verification or a private receipt. */
export async function normalizeControllerAttestationBundle(
  root: string,
  rawPhase: unknown,
  slot: number,
  source: string,
  deadline: number,
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  active(deadline);
  if (!path.isAbsolute(source)) throw new Error("completed pinned Action bundle path required");
  const event = inspectControllerTransportEvent(
    await json(filename(root, phase, `slot-${slot}`)),
    root,
    phase,
  );
  if (event.kind !== "attest") throw new Error("fixed attestation slot unavailable");
  await verifyEvent(root, event);
  if (!endedState(await json(path.join(root, `controller-job-settlement-${phase}.json`))))
    throw new Error("producer did not require attestation");
  const bytes = await readControllerToolFile(source, 512 * 1024);
  active(deadline);
  const route = bundleRoute(phase, event.context_kind),
    directory = path.join(root, `controller-attestation-bundle-${phase}`);
  await mkdir(directory, { mode: 0o700 });
  const file = path.join(directory, route.filename);
  await retainBytes(file, bytes);
  const ready = { path: file, name: route.name, bytes: bytes.length, sha256: hash(bytes) };
  active(deadline);
  await retain(filename(root, phase, "bundle-ready"), ready);
  return ready;
}
async function json(file: string, max = 16384): Promise<unknown> {
  return JSON.parse((await readControllerToolFile(file, max)).toString("utf8"));
}
async function optional(file: string): Promise<unknown> {
  try {
    return await json(file);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}
function rootPath(root: string, file: unknown) {
  if (
    typeof file !== "string" ||
    /[\r\n]/u.test(file) ||
    !path.isAbsolute(file) ||
    !releasePathContains(root, file) ||
    path.resolve(file) === path.resolve(root)
  )
    throw new Error("fixed transport path escaped runner storage");
  return path.resolve(file);
}
function role(phase: Phase) {
  return phase === "payload"
    ? "payload"
    : phase.startsWith("tuf-")
      ? phase.slice(4)
      : phase.startsWith("catalog-")
        ? phase
        : null;
}
function allowed(phase: Phase, kind: Kind) {
  return kind === "aggregate"
    ? phase === "admission"
    : kind === "role-key" || kind === "signature"
      ? role(phase) !== null
      : kind === "context"
        ? phase === "payload" || phase === "coordinator"
        : kind === "result"
          ? phase === "release-publication"
          : kind === "site"
            ? phase === "site-publication"
            : phase === "coordinator" ||
              phase === "payload" ||
              phase === "release-publication" ||
              phase.startsWith("tuf-") ||
              phase.startsWith("catalog-");
}
const predicateType = (phase: Phase) =>
  `https://portcove.dev/attestations/${phase === "release-publication" ? "immutable-release-result" : phase.startsWith("tuf-") ? "tuf-role-output" : phase.startsWith("catalog-") ? "catalog-role-output" : "release-signing-context"}/v1`;
type Event = {
  context_kind?: "catalog-signing-context";
  schema_version: 1;
  phase: Phase;
  kind: Kind;
  directory: string;
  name: string;
  files: { path: string; bytes: number; sha256: string }[];
  ack: string | null;
  predicate: string | null;
  predicate_type: string | null;
  predicate_sha256: string | null;
};
/** Shape/routing only. Imported events never mint any authenticated receipt. */
export function inspectControllerTransportEvent(
  raw: unknown,
  root: string,
  expectedPhase: unknown,
) {
  const phase = inspectReleaseControlPhase(expectedPhase);
  if (
    !(
      exact(
        raw,
        "ack,directory,files,kind,name,phase,predicate,predicate_sha256,predicate_type,schema_version",
      ) ||
      exact(
        raw,
        "ack,context_kind,directory,files,kind,name,phase,predicate,predicate_sha256,predicate_type,schema_version",
      )
    ) ||
    raw.schema_version !== 1 ||
    raw.phase !== phase ||
    !kinds.some((kind) => kind === raw.kind) ||
    !allowed(phase, raw.kind as Kind)
  )
    throw new Error("fixed phase transport event differs");
  const kind = raw.kind as Kind,
    directory = rootPath(root, raw.directory);
  const catalogContext = Object.hasOwn(raw, "context_kind");
  if (
    catalogContext &&
    (raw.context_kind !== "catalog-signing-context" ||
      phase !== "coordinator" ||
      !(kind === "context" || kind === "attest"))
  )
    throw new Error("closed catalog context route differs");
  if (
    typeof raw.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/u.test(raw.name) ||
    !Array.isArray(raw.files) ||
    raw.files.length > 8 ||
    new Set(raw.files.map((file) => (isRecord(file) ? file.path : null))).size !== raw.files.length
  )
    throw new Error("fixed transport file inventory differs");
  const files = raw.files.map((file: unknown) => {
    if (
      !exact(file, "bytes,path,sha256") ||
      typeof file.bytes !== "number" ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 1 ||
      file.bytes > 512 * 1024 ** 2 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      throw new Error("fixed transport file identity differs");
    return { path: rootPath(directory, file.path), bytes: file.bytes, sha256: file.sha256 };
  });
  const maximum =
    kind === "aggregate"
      ? 2 * 1024 ** 3
      : kind === "site"
        ? 512 * 1024 ** 2
        : kind === "context"
          ? 128 * 1024 ** 2
          : kind === "result"
            ? 65536
            : kind === "signature"
              ? 2 * 1024 ** 2
              : 1024 * 1024;
  if (
    files.reduce((total, file) => total + file.bytes, 0) > maximum ||
    (kind === "context" && files.length !== 2) ||
    (["site", "result", "attest"].includes(kind) && files.length !== 1)
  )
    throw new Error("fixed transport aggregate/file count exceeds its maintained handoff");
  const relative = files
    .map((file) => path.relative(directory, file.path).replaceAll("\\", "/"))
    .sort();
  if (
    (kind === "context" &&
      relative.join(",") !== "signing-context-bytes.bin,signing-context-manifest.json") ||
    (kind === "result" && relative.join(",") !== "upload/immutable-release-result.json") ||
    (kind === "site" &&
      !/^site-deployment-[A-Za-z0-9_-]+\/upload\/artifact[.]tar$/u.test(relative[0] ?? "")) ||
    (kind === "aggregate" &&
      relative.some((file) => !/^assets\/[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(file))) ||
    (kind === "signature" &&
      relative.some((file) => !/^output\/[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(file)))
  )
    throw new Error("fixed transport member paths differ");
  const ackName =
    kind === "aggregate"
      ? "aggregate-uploaded.json"
      : kind === "signature"
        ? "uploaded.json"
        : kind === "context"
          ? "context-uploaded.json"
          : kind === "result"
            ? "result-uploaded.json"
            : kind === "site"
              ? "site-uploaded.json"
              : null;
  if (
    (ackName ? raw.ack !== path.join(directory, ackName) : raw.ack !== null) ||
    (kind === "role-key" ? files.length !== 0 || raw.name !== role(phase) : files.length < 1)
  )
    throw new Error("fixed acknowledgement route differs");
  if (kind === "attest") {
    if (
      raw.predicate_type !== predicateType(phase) ||
      typeof raw.predicate !== "string" ||
      files.length !== 1 ||
      typeof raw.predicate_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(raw.predicate_sha256)
    )
      throw new Error("fixed attestation route differs");
    rootPath(directory, raw.predicate);
    const expectedSubject =
      phase === "release-publication"
        ? "immutable-release-result.json"
        : phase.startsWith("tuf-") || phase.startsWith("catalog-")
          ? "signing-output-manifest.json"
          : "signing-context-manifest.json";
    const expectedPredicate =
      phase === "release-publication"
        ? "immutable-release-result-predicate.json"
        : phase.startsWith("tuf-") || phase.startsWith("catalog-")
          ? "predicate.json"
          : "signing-context-predicate.json";
    if (
      path.basename(files[0]!.path) !== expectedSubject ||
      path.basename(raw.predicate) !== expectedPredicate
    )
      throw new Error("fixed attestation file names differ");
  } else if (raw.predicate !== null || raw.predicate_type !== null || raw.predicate_sha256 !== null)
    throw new Error("unexpected attestation fields");
  return {
    ...(catalogContext ? { context_kind: "catalog-signing-context" as const } : {}),
    schema_version: 1,
    phase,
    kind,
    directory,
    name: raw.name,
    files,
    ack: raw.ack,
    predicate: raw.predicate,
    predicate_type: raw.predicate_type,
    predicate_sha256: raw.predicate_sha256,
  } as Event;
}
async function fileIdentity(root: string, file: string, max: number) {
  await assertOwnedUnlinkedPath(root, file, "fixed transport file");
  const before = await lstat(file);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > max)
    throw new Error("fixed transport file exceeds bound");
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const rawChunk of createReadStream(file, { highWaterMark: 65536 })) {
    const chunk: unknown = rawChunk;
    if (!Buffer.isBuffer(chunk)) throw new Error("fixed transport byte stream required");
    bytes += chunk.length;
    if (bytes > max) throw new Error("fixed transport file grew");
    digest.update(chunk);
  }
  const after = await lstat(file);
  if (
    bytes !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ino !== before.ino ||
    after.nlink !== 1
  )
    throw new Error("fixed transport file changed");
  return { path: file, bytes, sha256: digest.digest("hex") };
}
async function verifyEvent(root: string, event: Event) {
  await assertOwnedUnlinkedPath(root, event.directory, "fixed transport directory");
  for (const expected of event.files) {
    const actual = await fileIdentity(root, expected.path, expected.bytes);
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256)
      throw new Error("retained transport bytes changed");
  }
  if (
    event.predicate &&
    (await fileIdentity(root, event.predicate, 1024 * 1024)).sha256 !== event.predicate_sha256
  )
    throw new Error("retained attestation predicate changed");
  if (event.context_kind) await verifyCatalogContextRoute(root, event);
}
/** Integrity-only route selection, never producer admission. The existing
 * private receiver independently authenticates the complete context bytes. */
async function verifyCatalogContextRoute(root: string, event: Event) {
  const manifestPath =
    event.kind === "context"
      ? path.join(event.directory, "signing-context-manifest.json")
      : event.files[0]?.path;
  if (!manifestPath) throw new Error("catalog context route lacks manifest");
  await assertOwnedUnlinkedPath(root, manifestPath, "catalog context manifest route");
  const manifest = await json(manifestPath, 1024 * 1024);
  if (
    !isRecord(manifest) ||
    manifest.kind !== "catalog-signing-context" ||
    manifest.schema_version !== 1 ||
    manifest.authority !== "none"
  )
    throw new Error("catalog manifest cannot select this context route");
  inspectCatalogSigningBinding(manifest.facts, manifest.binding, manifest.previous_site_pins);
  if (event.kind === "attest") {
    if (!event.predicate) throw new Error("catalog context predicate missing");
    const predicate = await json(event.predicate, 65536);
    if (
      !isRecord(predicate) ||
      predicate.role !== "catalog-signing-context" ||
      predicate.manifest_sha256 !== event.files[0]?.sha256
    )
      throw new Error("catalog context attestation route differs from manifest");
  }
}
/** Called only at the existing owned pending/ready boundary. No credential is
 * written. The downstream producer still verifies complete provider bytes. */
export async function retainControllerUpload(
  root: string,
  rawPhase: unknown,
  kind: "signature" | "context" | "result" | "site" | "aggregate",
  directory: string,
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  const readyName =
    kind === "aggregate"
      ? "aggregate-ready.json"
      : kind === "signature"
        ? "ready.json"
        : kind === "context"
          ? "context-ready.json"
          : kind === "result"
            ? "result-ready.json"
            : "site-upload-ready.json";
  await assertOwnedUnlinkedPath(root, path.join(directory, readyName), "owned upload readiness");
  const ready = await json(path.join(directory, readyName), 65536);
  if (!isRecord(ready) || typeof ready.name !== "string")
    throw new Error("owned readiness unavailable");
  const catalogContext =
    kind === "context" &&
    phase === "coordinator" &&
    ready.name.startsWith("trusted-catalog-signing-context-");
  const prefix =
    kind === "aggregate"
      ? "trusted-release-final"
      : kind === "signature"
        ? `trusted-${phase === "payload" ? "payload-signing" : phase}-output`
        : kind === "context"
          ? phase === "payload"
            ? "trusted-payload-signing-context"
            : catalogContext
              ? "trusted-catalog-signing-context"
              : "trusted-coordinator-signing-context"
          : kind === "result"
            ? "trusted-immutable-release-result"
            : "application-update-site";
  if (ready.name !== `${prefix}-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`)
    throw new Error("owned upload name differs from fixed job");
  let files: string[];
  if (kind === "site") files = [rootPath(directory, ready.archive)];
  else {
    if (!Array.isArray(ready.files) || ready.files.length < 1 || ready.files.length > 8)
      throw new Error("owned upload inventory unavailable");
    files = ready.files.map((file: unknown) => {
      const name = kind === "signature" && isRecord(file) ? file.filename : file;
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/u.test(name))
        throw new Error("owned upload member differs");
      return path.join(
        directory,
        kind === "aggregate"
          ? "assets"
          : kind === "signature"
            ? "output"
            : kind === "result"
              ? "upload"
              : "",
        name,
      );
    });
  }
  const event = inspectControllerTransportEvent(
    {
      ...(catalogContext ? { context_kind: "catalog-signing-context" } : {}),
      schema_version: 1,
      phase,
      kind,
      directory,
      name: ready.name,
      files: await Promise.all(
        files.map((file) =>
          fileIdentity(
            root,
            file,
            kind === "site" || kind === "aggregate" ? 512 * 1024 ** 2 : 128 * 1024 ** 2,
          ),
        ),
      ),
      ack: path.join(
        directory,
        kind === "aggregate"
          ? "aggregate-uploaded.json"
          : kind === "signature"
            ? "uploaded.json"
            : kind === "context"
              ? "context-uploaded.json"
              : kind === "result"
                ? "result-uploaded.json"
                : "site-uploaded.json",
      ),
      predicate: null,
      predicate_type: null,
      predicate_sha256: null,
    },
    root,
    phase,
  );
  await verifyEvent(root, event);
  await retain(filename(root, phase, kind), event);
}
export async function retainControllerRoleKey(root: string, selected: string, directory: string) {
  const phase = inspectReleaseControlPhase(
    selected === "payload"
      ? "payload"
      : selected.startsWith("catalog-")
        ? selected
        : `tuf-${selected}`,
  );
  const event = inspectControllerTransportEvent(
    {
      schema_version: 1,
      phase,
      kind: "role-key",
      directory,
      name: selected,
      files: [],
      ack: null,
      predicate: null,
      predicate_type: null,
      predicate_sha256: null,
    },
    root,
    phase,
  );
  await assertOwnedUnlinkedPath(root, directory, "owned role key directory");
  await retain(filename(root, phase, "role-key"), event);
}
/** Trusted process wrapper calls this after its actual producer has settled.
 * The fixed pinned attestation Action must still complete before job success. */
export async function retainControllerAttestation(
  root: string,
  rawPhase: unknown,
  raw: { subject_path: string; predicate_path: string; predicate_type: string },
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  rootPath(root, raw.subject_path);
  rootPath(root, raw.predicate_path);
  let directory = path.dirname(raw.subject_path);
  while (!releasePathContains(directory, raw.predicate_path)) directory = path.dirname(directory);
  rootPath(root, directory);
  let catalogContext = false;
  if (phase === "coordinator") {
    const bytes = await readControllerToolFile(raw.predicate_path, 65536);
    let predicate: unknown;
    try {
      predicate = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    catalogContext = isRecord(predicate) && predicate.role === "catalog-signing-context";
  }
  const event = inspectControllerTransportEvent(
    {
      ...(catalogContext ? { context_kind: "catalog-signing-context" } : {}),
      schema_version: 1,
      phase,
      kind: "attest",
      directory,
      name: "attestation",
      files: [await fileIdentity(root, raw.subject_path, 1024 * 1024)],
      ack: null,
      predicate: raw.predicate_path,
      predicate_type: raw.predicate_type,
      predicate_sha256: (await fileIdentity(root, raw.predicate_path, 1024 * 1024)).sha256,
    },
    root,
    phase,
  );
  await verifyEvent(root, event);
  await retain(filename(root, phase, "attest"), event);
}

type Route =
  | { kind: "control"; path: string; name: string; index: number }
  | Event
  | { kind: "done" };
function endedState(raw: unknown) {
  if (
    !exact(raw, "exit_code,requires_attestation") ||
    !Number.isInteger(raw.exit_code) ||
    typeof raw.requires_attestation !== "boolean"
  )
    throw new Error("fixed producer settlement schema differs");
  if (raw.exit_code !== 0) throw new Error("fixed producer refused; retain pending effects");
  return raw.requires_attestation;
}
export async function nextControllerTransport(
  root: string,
  rawPhase: unknown,
  slot: number,
  deadline: number,
): Promise<Route> {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (!Number.isInteger(slot) || slot < 1 || slot > 40)
    throw new Error("fixed transport has forty slots");
  if (slot > 1) {
    const previous = await json(filename(root, phase, `slot-${slot - 1}`));
    if (
      !isRecord(previous) ||
      !(await optional(
        filename(
          root,
          phase,
          previous.kind === "control"
            ? `control-${String(previous.index)}-ack`
            : `${String(previous.kind)}-ack`,
        ),
      ))
    )
      throw new Error("previous fixed transport event is not acknowledged");
  }
  for (;;) {
    active(deadline);
    for (let index = 0; index <= 14; index++) {
      if (await optional(filename(root, phase, `control-${index}-ack`))) continue;
      const pointer = await optional(path.join(root, `control-step-ready-${phase}-r${index}.json`));
      if (pointer === undefined) break;
      if (!exact(pointer, "path,sha256")) throw new Error("fixed readiness pointer differs");
      const file = rootPath(root, pointer.path),
        bytes = await readControllerToolFile(file, 16384);
      if (hash(bytes) !== pointer.sha256) throw new Error("fixed readiness changed");
      const ready = inspectControlStepReadiness(JSON.parse(bytes.toString("utf8")), {
        phase,
        index,
        run_id: process.env.GITHUB_RUN_ID ?? "",
        revision: process.env.GITHUB_SHA ?? "",
        ref: process.env.GITHUB_REF ?? "",
      });
      const route = { kind: "control" as const, path: file, name: ready.name, index };
      await retain(filename(root, phase, `slot-${slot}`), route);
      return route;
    }
    for (const kind of kinds) {
      if (await optional(filename(root, phase, `${kind}-ack`))) continue;
      const raw = await optional(filename(root, phase, kind));
      if (raw === undefined) continue;
      const event = inspectControllerTransportEvent(raw, root, phase);
      await verifyEvent(root, event);
      active(deadline);
      if (kind === "attest") {
        const ended = await optional(path.join(root, `controller-job-settlement-${phase}.json`));
        if (ended === undefined) continue;
        if (!endedState(ended)) throw new Error("unexpected producer attestation");
      }
      await retain(filename(root, phase, `slot-${slot}`), event);
      return event;
    }
    const ended = await optional(path.join(root, `controller-job-settlement-${phase}.json`));
    if (ended !== undefined) {
      const requiresAttestation = endedState(ended);
      if (!requiresAttestation || (await optional(filename(root, phase, "attest-ack"))))
        return { kind: "done" };
    }
    await delay(Math.min(100, Math.max(1, deadline - performance.now())));
  }
}
/** Resource metadata only. This cannot admit a role or authenticate inputs. */
export function controllerTransportClock(
  raw: unknown,
  rawPhase: unknown,
  environment: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
  monotonic = performance.now(),
  hostMonotonic = process.hrtime.bigint(),
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (
    !exact(raw, "clock,sha256") ||
    !isRecord(raw.clock) ||
    hash(Buffer.from(JSON.stringify(raw.clock))) !== raw.sha256
  )
    throw new Error("retained original transport clock changed");
  const clock = raw.clock;
  if (
    !exact(
      clock,
      "controller_revision,execution_ref,job_id,job_name,monotonic_deadline_ns,phase,profile_ms,run_attempt,run_id,started_at",
    ) ||
    clock.phase !== phase ||
    clock.profile_ms !== phaseBudgets[phase] ||
    clock.run_id !== environment.GITHUB_RUN_ID ||
    clock.run_attempt !== 1 ||
    environment.GITHUB_RUN_ATTEMPT !== "1" ||
    clock.controller_revision !== environment.GITHUB_SHA ||
    clock.execution_ref !== environment.GITHUB_REF ||
    typeof clock.started_at !== "string" ||
    typeof clock.job_id !== "number" ||
    !Number.isSafeInteger(clock.job_id) ||
    clock.job_id < 1 ||
    clock.job_name !== releaseControlPhaseProfile(phase).reader_name ||
    typeof clock.monotonic_deadline_ns !== "string" ||
    !/^[1-9][0-9]{0,24}$/u.test(clock.monotonic_deadline_ns)
  )
    throw new Error("original transport clock identity differs");
  const left = Math.min(
    Date.parse(clock.started_at) + phaseBudgets[phase] - now,
    Number((BigInt(clock.monotonic_deadline_ns) - hostMonotonic) / 1_000_000n),
  );
  if (
    !Number.isFinite(left) ||
    left <= 0 ||
    left > phaseBudgets[phase] ||
    !Number.isFinite(monotonic)
  )
    throw new Error("original transport clock exhausted");
  return monotonic + left;
}
async function originalDeadline(root: string, phase: Phase) {
  if (
    process.env.GITHUB_RUN_ATTEMPT !== "1" ||
    !/^[1-9][0-9]{0,15}$/u.test(process.env.GITHUB_RUN_ID ?? "") ||
    !/^[a-f0-9]{40}$/u.test(process.env.GITHUB_SHA ?? "") ||
    !/^refs\/tags\/portcove-production-controller-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(
      process.env.GITHUB_REF ?? "",
    )
  )
    throw new Error("fixed transport source/run/ref unavailable");
  const file = filename(root, phase, "clock"),
    old = await optional(file);
  if (old !== undefined) {
    await assertOwnedUnlinkedPath(root, file, "original transport clock");
    return controllerTransportClock(old, phase);
  }
  const runner = createGitHubRunner({ cwd: root, timeoutMs: 15000, maxBuffer: 2 * 1024 ** 2 });
  const api = new GitHubApiClient((args, body) =>
    runner([...args, "--hostname", "github.com"], body),
  );
  const response = api.request(
    "GET",
    `repos/boburning/portcove/actions/runs/${process.env.GITHUB_RUN_ID}/attempts/1/jobs?per_page=100`,
  );
  if (response.status !== 200) throw new Error("original producer job unavailable");
  const deadline = controlBridgeOriginalDeadline(response.body, phase);
  const profile = releaseControlPhaseProfile(phase);
  if (!isRecord(response.body) || !Array.isArray(response.body.jobs))
    throw new Error("original job inventory unavailable");
  const job: unknown = response.body.jobs.find(
    (entry: unknown) => isRecord(entry) && entry.name === profile.reader_name,
  );
  if (!isRecord(job)) throw new Error("original job unavailable");
  const clock = {
    controller_revision: process.env.GITHUB_SHA,
    execution_ref: process.env.GITHUB_REF,
    job_id: job.id,
    job_name: profile.reader_name,
    phase,
    profile_ms: phaseBudgets[phase],
    run_attempt: 1,
    run_id: process.env.GITHUB_RUN_ID,
    started_at: job.started_at,
    monotonic_deadline_ns: (
      process.hrtime.bigint() +
      BigInt(Math.max(0, Math.floor(deadline - performance.now()))) * 1_000_000n
    ).toString(),
  };
  await retain(file, { clock, sha256: hash(Buffer.from(JSON.stringify(clock))) });
  return Math.min(deadline, controllerTransportClock(await json(file), phase));
}
export function inspectControllerKeyProcess(raw: string) {
  const close = raw.lastIndexOf(") "),
    fields = raw
      .slice(close + 2)
      .trim()
      .split(/\s+/u);
  if (close < 1 || fields.length < 20 || !/^[1-9][0-9]*$/u.test(fields[19]!))
    throw new Error("owned key client process identity unavailable");
  if (!/^[A-Za-z]$/u.test(fields[0]!)) throw new Error("owned key process state unavailable");
  return { start_ticks: fields[19]!, state: fields[0]! };
}
async function linuxProcessStart(pid: number) {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1)
    throw new Error("owned Linux key client required");
  try {
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const rawChunk of createReadStream(`/proc/${pid}/stat`, { highWaterMark: 8193 })) {
      const chunk: unknown = rawChunk;
      if (!Buffer.isBuffer(chunk)) throw new Error("owned proc byte stream required");
      bytes += chunk.length;
      if (bytes > 8192) throw new Error("owned proc identity exceeds bound");
      chunks.push(Buffer.from(chunk));
    }
    return inspectControllerKeyProcess(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (isRecord(error) && (error.code === "ENOENT" || error.code === "ESRCH")) return null;
    throw error;
  }
}
/** One fixed concurrent socket client lets the trusted payload callback request
 * another control round while signing. Its secret never enters a local file. */
export async function startControllerKeyClient(
  root: string,
  phase: Phase,
  slot: number,
  deadline: number,
) {
  if (process.platform !== "linux" || !role(phase))
    throw new Error("fixed Linux signing client required");
  active(deadline);
  const event = inspectControllerTransportEvent(
    await json(filename(root, phase, `slot-${slot}`)),
    root,
    phase,
  );
  if (event.kind !== "role-key") throw new Error("fixed key route unavailable");
  await retain(filename(root, phase, "key-client-intent"), { slot, role: event.name });
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "TEMP",
    "TMP",
    "RUNNER_TEMP",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_SHA",
    "GITHUB_REF",
    "PORTCOVE_ROLE_KEY",
    "PORTCOVE_ROLE_PASSWORD",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "key-worker", phase, String(slot)],
    { cwd: root, env, stdio: "ignore", windowsHide: true },
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () => reject(new Error("fixed key client launch refused")));
  });
  if (!child.pid) throw new Error("owned key client PID unavailable");
  await retain(filename(root, phase, "key-client-started"), {
    pid: child.pid,
    slot,
    role: event.name,
  });
  child.unref();
}
async function keyClientWorker(root: string, phase: Phase, slot: number, deadline: number) {
  let exitCode = 1;
  try {
    const event = inspectControllerTransportEvent(
      await json(filename(root, phase, `slot-${slot}`)),
      root,
      phase,
    );
    if (
      event.kind !== "role-key" ||
      JSON.stringify(await json(filename(root, phase, "key-client-intent"))) !==
        JSON.stringify({ slot, role: event.name })
    )
      throw new Error("fixed key client intent differs");
    const start = await linuxProcessStart(process.pid);
    if (!start) throw new Error("owned key client disappeared");
    await retain(filename(root, phase, "key-client-identity"), {
      pid: process.pid,
      start_ticks: start.start_ticks,
      slot,
      role: event.name,
    });
    const { supplyIsolatedRoleKey, isolatedRoleKeyEnvironment } =
      await import("./release-role-key-channel.mts");
    await supplyIsolatedRoleKey(
      event.directory,
      event.name as import("./release-role-key-channel.mts").IsolatedSigningRole,
      event.name === "payload"
        ? {
            TAURI_SIGNING_PRIVATE_KEY: process.env.PORTCOVE_ROLE_KEY,
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.PORTCOVE_ROLE_PASSWORD,
          }
        : { [isolatedRoleKeyEnvironment(event.name)]: process.env.PORTCOVE_ROLE_KEY },
      deadline,
    );
    active(deadline);
    exitCode = 0;
  } finally {
    await retain(filename(root, phase, "key-client-settled"), { exit_code: exitCode, slot });
  }
}
export async function finishControllerKeyClient(root: string, phase: Phase, deadline: number) {
  const started = await optional(filename(root, phase, "key-client-started"));
  if (started === undefined) {
    if (await optional(filename(root, phase, "role-key")))
      throw new Error("required key client was not launched");
    return;
  }
  if (
    !exact(started, "pid,role,slot") ||
    !role(phase) ||
    typeof started.pid !== "number" ||
    !Number.isSafeInteger(started.slot) ||
    Number(started.slot) < 1 ||
    Number(started.slot) > 40 ||
    started.role !== role(phase)
  )
    throw new Error("key client start changed");
  for (;;) {
    active(deadline);
    const settled = await optional(filename(root, phase, "key-client-settled"));
    if (settled !== undefined) {
      if (
        !exact(settled, "exit_code,slot") ||
        settled.exit_code !== 0 ||
        settled.slot !== started.slot
      )
        throw new Error("owned key client refused");
      const identity = await json(filename(root, phase, "key-client-identity"));
      if (
        !exact(identity, "pid,role,slot,start_ticks") ||
        identity.pid !== started.pid ||
        identity.role !== started.role ||
        identity.slot !== started.slot ||
        typeof identity.start_ticks !== "string" ||
        !/^[1-9][0-9]*$/u.test(identity.start_ticks)
      )
        throw new Error("owned key client identity changed");
      const current = await linuxProcessStart(started.pid);
      if (current === null || current.start_ticks !== identity.start_ticks || current.state === "Z")
        return;
    }
    await delay(Math.min(25, Math.max(1, deadline - performance.now())));
  }
}
export async function acknowledgeControllerTransport(
  root: string,
  rawPhase: unknown,
  slot: number,
  artifact?: { artifact_id: number; sha256: string },
) {
  const phase = inspectReleaseControlPhase(rawPhase);
  if (!Number.isInteger(slot) || slot < 1 || slot > 40) throw new Error("fixed slot differs");
  const raw = await json(filename(root, phase, `slot-${slot}`));
  if (isRecord(raw) && raw.kind === "control") {
    if (
      !exact(raw, "index,kind,name,path") ||
      !Number.isInteger(raw.index) ||
      Number(raw.index) < 0 ||
      Number(raw.index) > 14
    )
      throw new Error("fixed control slot differs");
    await retain(filename(root, phase, `control-${Number(raw.index)}-ack`), { authority: "none" });
    return;
  }
  const event = inspectControllerTransportEvent(raw, root, phase);
  await verifyEvent(root, event);
  if (event.ack || event.kind === "attest") {
    if (
      !artifact ||
      !Number.isSafeInteger(artifact.artifact_id) ||
      artifact.artifact_id < 1 ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256)
    )
      throw new Error("actual upload Action output unavailable");
    if (event.kind === "attest") {
      const ready = await json(filename(root, phase, "bundle-ready")),
        route = bundleRoute(phase, event.context_kind);
      if (
        !exact(ready, "bytes,name,path,sha256") ||
        ready.name !== route.name ||
        typeof ready.path !== "string" ||
        ready.path !== path.join(root, `controller-attestation-bundle-${phase}`, route.filename) ||
        typeof ready.bytes !== "number" ||
        ready.bytes < 1 ||
        ready.bytes > 512 * 1024
      )
        throw new Error("normalized fixed attestation bundle missing");
      const actual = await fileIdentity(root, ready.path, 512 * 1024);
      if (actual.sha256 !== ready.sha256 || actual.bytes !== ready.bytes)
        throw new Error("normalized attestation bytes changed");
      await retain(filename(root, phase, "attestation-uploaded"), artifact);
    } else {
      if (!event.ack) throw new Error("fixed upload acknowledgement unavailable");
      await retain(
        event.ack,
        event.kind === "site"
          ? { artifact_id: artifact.artifact_id }
          : event.kind === "result"
            ? { id: artifact.artifact_id, sha256: artifact.sha256 }
            : artifact,
      );
    }
  }
  await retain(filename(root, phase, `${event.kind}-ack`), { authority: "none" });
}
async function output(values: Record<string, string>) {
  if (!process.env.GITHUB_OUTPUT) throw new Error("fixed Actions output unavailable");
  for (const [key, value] of Object.entries(values)) {
    const separator = `transport_${randomBytes(16).toString("hex")}`;
    await appendFile(process.env.GITHUB_OUTPUT, `${key}<<${separator}\n${value}\n${separator}\n`);
  }
}
async function cli() {
  const root = process.env.RUNNER_TEMP,
    phase = inspectReleaseControlPhase(process.argv[3]),
    slot = Number(process.argv[4]);
  if (!root || !path.isAbsolute(root) || process.argv.length !== 5)
    throw new Error("fixed transport phase/slot required");
  const deadline = await originalDeadline(root, phase);
  active(deadline);
  if (process.argv[2] === "finish") {
    const ended = await json(path.join(root, `controller-job-settlement-${phase}.json`));
    const needs = endedState(ended);
    if (needs && !(await optional(filename(root, phase, "attest-ack"))))
      throw new Error("required attestation incomplete");
    for (const kind of kinds)
      if (
        (await optional(filename(root, phase, kind))) &&
        !(await optional(filename(root, phase, `${kind}-ack`)))
      )
        throw new Error("fixed transport event remains incomplete");
    for (let index = 0; index <= 14; index++)
      if (
        (await optional(path.join(root, `control-step-ready-${phase}-r${index}.json`))) &&
        !(await optional(filename(root, phase, `control-${index}-ack`)))
      )
        throw new Error("readiness event remains incomplete");
    await finishControllerKeyClient(root, phase, deadline);
    return;
  }
  if (process.argv[2] === "key") {
    await startControllerKeyClient(root, phase, slot, deadline);
    return;
  }
  if (process.argv[2] === "key-worker") {
    try {
      await keyClientWorker(root, phase, slot, deadline);
    } catch {
      process.exitCode = 2;
    }
    return;
  }
  if (process.argv[2] === "normalize") {
    const ready = await normalizeControllerAttestationBundle(
      root,
      phase,
      slot,
      process.env.PORTCOVE_TRANSPORT_BUNDLE_PATH ?? "",
      deadline,
    );
    await output({ bundle_path: ready.path, bundle_name: ready.name });
    return;
  }
  if (process.argv[2] === "ack") {
    await acknowledgeControllerTransport(root, phase, slot, {
      artifact_id: Number(process.env.PORTCOVE_TRANSPORT_ARTIFACT_ID),
      sha256: process.env.PORTCOVE_TRANSPORT_ARTIFACT_SHA256 ?? "",
    });
    return;
  }
  if (process.argv[2] !== "next") throw new Error("fixed transport command refused");
  const route = await nextControllerTransport(root, phase, slot, deadline);
  if (route.kind === "done") {
    await output({ kind: "done" });
    return;
  }
  if (route.kind === "control") {
    await output({ kind: "control", paths: route.path, name: route.name });
    return;
  }
  await output({
    kind: route.kind,
    paths: route.files.map((file) => file.path).join("\n"),
    name: route.name,
    directory: route.directory,
    subject: route.files[0]?.path ?? "",
    predicate: route.predicate ?? "",
    predicate_type: route.predicate_type ?? "",
  });
}
if (
  process.argv[1] &&
  /^release-controller-transport[.]mts$/u.test(path.basename(process.argv[1])) &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  void cli().catch(() => {
    console.error("fixed controller transport refused; retain original pending effects");
    process.exitCode = 2;
  });
