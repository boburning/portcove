/** One fixed disposable release, using native immutable Releases. No production
 * eligibility, key custody, pause transition or catalog authority is supplied. */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { readGitHubReleaseAsset } from "./github-binary.mts";
import { rehearsalExecution } from "./upstream-release-identity.mts";
import { verifyRehearsalAcceptance } from "./upstream-release-acceptance.mts";
import { assertRehearsalProtection } from "./upstream-release-runtime.mts";
import {
  rehearsalApi as api,
  rehearsalGh as gh,
  rehearsalEntry,
  verifyRehearsalPackage,
  inspectRehearsalReleaseReadback,
  type RehearsalEntry,
} from "./upstream-release-rehearsal.mts";

function attempts() {
  const native = Number(process.env.PORTCOVE_REHEARSAL_NATIVE_ATTEMPT);
  const attester = Number(process.env.PORTCOVE_REHEARSAL_ACCEPTANCE_ATTESTER_ATTEMPT);
  if (
    !Number.isSafeInteger(native) ||
    !Number.isSafeInteger(attester) ||
    native < 1 ||
    attester < native
  )
    throw new Error("actual native and separate acceptance attester attempts required");
  return { native, attester };
}

async function expectedAssets(directory: string, phase: string) {
  const m = await verifyRehearsalPackage(directory, phase);
  assert.equal(m.files.length, 10);
  const a = attempts();
  const acceptanceDirectory = "work/upstream-acceptance";
  const acceptance = await verifyRehearsalAcceptance(
    acceptanceDirectory,
    directory,
    a.native,
    a.attester,
    phase,
  );
  const files = [
    ...m.files,
    await rehearsalEntry(directory, "rehearsal.json"),
    ...acceptance.files,
  ];
  assert.equal(new Set(files.map((file) => file.name)).size, 15);
  if (files.reduce((total, file) => total + file.bytes, 0) > 2 * 1024 ** 3)
    throw new Error("complete release including acceptance exceeds2GiB assembly limit");
  return { m, files, acceptanceDirectory };
}

function matchingRelease(tag: string): unknown {
  // Complete bounded observation, never create merely because a by-tag GET404s.
  const releases = api("releases?per_page=100");
  assert.ok(Array.isArray(releases) && releases.length < 100);
  const matches = releases.filter((value) => isRecord(value) && value.tag_name === tag);
  assert.ok(matches.length <= 1);
  return matches[0];
}

function assets(id: number, files: RehearsalEntry[]): unknown[] {
  const actual = api(`releases/${id}/assets?per_page=100`);
  assert.ok(Array.isArray(actual) && actual.length <= files.length);
  const names = new Set<string>();
  for (const value of actual) {
    assert.ok(
      isRecord(value) &&
        typeof value.name === "string" &&
        !names.has(value.name) &&
        value.state === "uploaded",
    );
    names.add(value.name);
    assert.ok(
      files.some(
        (file) =>
          file.name === value.name &&
          file.bytes === value.size &&
          `sha256:${file.sha256}` === value.digest,
      ),
    );
  }
  return actual;
}

function tagReadback(tag: string, source: string) {
  const ref = api(`git/ref/tags/${tag}`);
  assert.ok(
    isRecord(ref) &&
      ref.ref === `refs/tags/${tag}` &&
      isRecord(ref.object) &&
      ref.object.type === "commit" &&
      ref.object.sha === source,
  );
  return ref;
}

async function byteReadback(id: number, files: RehearsalEntry[], phase: string) {
  const directory = `work/upstream-release-readback-${phase}`;
  await mkdir(directory);
  const observed = assets(id, files);
  assert.equal(observed.length, files.length);
  for (const file of files) {
    const asset: unknown = observed.find((value) => isRecord(value) && value.name === file.name);
    assert.ok(isRecord(asset) && typeof asset.id === "number" && Number.isSafeInteger(asset.id));
    const bytes = readGitHubReleaseAsset(`repos/boburning/portcove/releases/assets/${asset.id}`, {
      cwd: process.cwd(),
      maxBytes: file.bytes,
      timeoutMs: 120000,
    });
    assert.equal(bytes.length, file.bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
    await writeFile(path.join(directory, file.name), bytes, { flag: "wx" });
  }
}

async function readback(
  id: number,
  tag: string,
  source: string,
  files: RehearsalEntry[],
  phase: "draft" | "immutable",
  receipt: string,
) {
  const observed = inspectRehearsalReleaseReadback(
    api(`releases/${id}`),
    tagReadback(tag, source),
    assets(id, files),
    { id, tag, source, files },
    phase,
  );
  await writeFile(
    receipt,
    `${JSON.stringify({ scope: "disposable-nonproduction", ...observed, production: false, executor: rehearsalExecution() })}\n`,
    { flag: "wx" },
  );
  return observed;
}

export async function prepareRehearsalDraft(directory: string) {
  const { m, files, acceptanceDirectory } = await expectedAssets(directory, "draft");
  await assertRehearsalProtection("draft");
  const tag = `v${m.version}`;
  const refs = api(`git/matching-refs/tags/${tag}`);
  assert.ok(Array.isArray(refs));
  const matching = refs.filter((value) => isRecord(value) && value.ref === `refs/tags/${tag}`);
  assert.ok(matching.length <= 1);
  if (!matching.length) api("git/refs", "POST", { ref: `refs/tags/${tag}`, sha: m.source });
  tagReadback(tag, m.source);
  let release = matchingRelease(tag);
  if (!release)
    release = api("releases", "POST", {
      tag_name: tag,
      target_commitish: m.source,
      name: `NONPRODUCTION #534 rehearsal ${m.run_id}/${m.run_attempt}`,
      draft: true,
      prerelease: true,
      make_latest: "false",
      body: "Disposable Windows delivery/recovery rehearsal. Not an eligible Portcove production release. These public fixture keys and packages must never be appointed for production.",
    });
  assert.ok(
    isRecord(release) &&
      Number.isSafeInteger(release.id) &&
      release.target_commitish === m.source &&
      release.tag_name === tag &&
      release.prerelease === true,
  );
  const id = Number(release.id);
  const actual = assets(id, files);
  if (release.draft === true && release.immutable === false) {
    for (const file of files)
      if (!actual.some((value) => isRecord(value) && value.name === file.name)) {
        const parent = [
          "acceptance.json",
          "installed.json",
          "renderer-update-evidence.json",
          "summary.json",
        ].includes(file.name)
          ? acceptanceDirectory
          : directory;
        gh([
          "release",
          "upload",
          tag,
          path.join(parent, file.name),
          "--repo",
          "boburning/portcove",
        ]);
      }
  } else {
    assert.ok(
      release.draft === false && release.immutable === true && actual.length === files.length,
    );
  }
  await byteReadback(id, files, "draft");
  const settled = api(`releases/${id}`);
  assert.ok(isRecord(settled));
  const observed = await readback(
    id,
    tag,
    m.source,
    files,
    settled.draft === true ? "draft" : "immutable",
    "work/upstream-draft-result.json",
  );
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `release_id=${id}\ntag=${tag}\n`, { flag: "a" });
  return observed;
}

export async function verifyImmutableRehearsal(directory: string, phase = "immutable") {
  const { m, files } = await expectedAssets(directory, phase);
  const tag = `v${m.version}`;
  const release = matchingRelease(tag);
  assert.ok(isRecord(release) && Number.isSafeInteger(release.id));
  const expectedId = Number(process.env.PORTCOVE_REHEARSAL_RELEASE_ID);
  assert.ok(
    Number.isSafeInteger(expectedId) && expectedId > 0 && release.id === expectedId,
    "immutable release identity differs from original publisher output",
  );
  const observed = inspectRehearsalReleaseReadback(
    release,
    tagReadback(tag, m.source),
    assets(Number(release.id), files),
    { id: Number(release.id), tag, source: m.source, files },
    "immutable",
  );
  // Maintained provider-generated release attestation, distinct from build provenance.
  gh(["release", "verify", tag, "--repo", "boburning/portcove"]);
  return { m, files, observed };
}

async function publish(directory: string) {
  const { m, files } = await expectedAssets(directory, "publish");
  await assertRehearsalProtection("publish");
  const tag = `v${m.version}`;
  const release = matchingRelease(tag);
  assert.ok(isRecord(release) && Number.isSafeInteger(release.id));
  const id = Number(release.id);
  // Re-read every final identity immediately before the sole irreversible effect.
  inspectRehearsalReleaseReadback(
    release,
    tagReadback(tag, m.source),
    assets(id, files),
    { id, tag, source: m.source, files },
    release.draft === true ? "draft" : "immutable",
  );
  if (release.draft === true)
    api(`releases/${id}`, "PATCH", { draft: false, make_latest: "false" });
  // A late/failed PATCH is not blindly repeated: a retry first reconciles the
  // actual existing release and can only verify an already immutable result.
  await byteReadback(id, files, "published");
  const observed = await readback(
    id,
    tag,
    m.source,
    files,
    "immutable",
    "work/upstream-immutable-result.json",
  );
  gh(["release", "verify", tag, "--repo", "boburning/portcove"]);
  if (process.env.GITHUB_OUTPUT)
    await writeFile(process.env.GITHUB_OUTPUT, `release_id=${id}\ntag=${tag}\n`, { flag: "a" });
  return observed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, directory] = process.argv.slice(2);
  if (!directory) throw new Error("exact signed directory required");
  if (phase === "draft") await prepareRehearsalDraft(directory);
  else if (phase === "publish") await publish(directory);
  else if (phase === "verify-immutable") await verifyImmutableRehearsal(directory);
  else throw new Error("expected draft, publish or verify-immutable");
}
