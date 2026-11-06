/** Verify the fixed disposable immutable release and its attestation. */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "./runtime-values.mts";
import { verifyRehearsalAcceptance } from "./upstream-release-acceptance.mts";
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
  return { m, files };
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [phase, directory] = process.argv.slice(2);
  if (!directory) throw new Error("exact signed directory required");
  if (phase !== "verify-immutable") throw new Error("expected verify-immutable");
  await verifyImmutableRehearsal(directory);
}
