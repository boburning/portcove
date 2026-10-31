import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { packagesForPlatform, artifactName } from "./release-package-policy.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  inspectPublicationRecordAssociation,
  prepareOwnedPublicationResult,
  requireOwnedPublicationResult,
} from "./release-publication-result.mts";

const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
for (const profile of ["initial-beta-win-linux", "initial-beta-windows-x86_64-v1"] as const)
  void test(`record association binds exact ${profile} packages and signature assets with producing lineage`, async (t) => {
    const f =
      profile === "initial-beta-win-linux"
        ? await trustedAssemblyFixture(t, profile)
        : await releasePublicBuildProvenanceFixture(t, true, profile);
    const { accepted, policy, labels } = await inspectTrustedAssemblyInput(f.request);
    const facts = {
      assembly: f.request,
      archives: [{ artifact_id: 123 }],
      configuration: { namespace: "portcove-fixture" },
    };
    const assets = labels.flatMap((label) =>
      packagesForPlatform(policy, label).map((rule) => {
        const name = artifactName(rule, accepted.version);
        const file = accepted.files.find(
          (item) => item.filename === name && item.platform_label === label,
        )!;
        return { filename: name, bytes: file.bytes, sha256: file.sha256 };
      }),
    );
    const files = new Map<string, Buffer>();
    const signatures = labels.map((label) => {
      const updater = updaterIdentity(policy, label, accepted.version);
      const packageFile = assets.find((file) => file.filename === updater.filename)!;
      const signature = Buffer.from(`inert-signature-${label}\n`);
      const identity = {
        filename: `${updater.filename}.sig`,
        bytes: signature.length,
        sha256: hash(signature),
      };
      assets.push(identity);
      files.set(
        `records/releases/${accepted.version}/${updater.target}/${updater.format}.json`,
        Buffer.from(
          JSON.stringify({
            schema_version: 1,
            version: accepted.version,
            source_commit: accepted.source_commit,
            source_tree: accepted.source_tree,
            target: updater.target,
            qualified_run: { run_id: Number(accepted.run_id), attempt: accepted.run_attempt },
            artifact: {
              url: `https://github.com/boburning/portcove/releases/download/v${accepted.version}/${updater.filename}`,
              bytes: packageFile.bytes,
              sha256: packageFile.sha256,
              tauri_signature: signature.toString("utf8").trimEnd(),
            },
          }),
        ),
      );
      return { platform: label, ...identity };
    });
    const manifest = {
      facts,
      controller: {},
      binding: {
        version: accepted.version,
        source_commit: accepted.source_commit,
        source_tree: accepted.source_tree,
        run_id: String(accepted.run_id),
        run_attempt: accepted.run_attempt,
        signatures_sha256: digest(signatures),
        records_sha256: "f".repeat(64),
      },
    };
    const result = await inspectPublicationRecordAssociation(manifest, facts, assets, files);
    assert.equal(result.authority, "none");
    assert.equal(result.scope, "integrity-only");
    assert.equal(assets.length, profile === "initial-beta-win-linux" ? 8 : 3);
    await assert.rejects(
      inspectPublicationRecordAssociation(
        manifest,
        facts,
        [...assets, { filename: "unqualified-linux.AppImage", bytes: 1, sha256: "0".repeat(64) }],
        files,
      ),
    );
    await assert.rejects(
      inspectPublicationRecordAssociation(
        { ...manifest, binding: { ...manifest.binding, run_id: "999" } },
        facts,
        assets,
        files,
      ),
      /lineage/,
    );
    await assert.rejects(
      inspectPublicationRecordAssociation(manifest, facts, [...assets, assets[0]!], files),
      /duplicates/,
    );
    await assert.rejects(
      inspectPublicationRecordAssociation(
        manifest,
        facts,
        assets.map((file, index) => (index === 0 ? { ...file, sha256: "0".repeat(64) } : file)),
        files,
      ),
      /package differs/,
    );
    await assert.rejects(
      inspectPublicationRecordAssociation(
        manifest,
        facts,
        assets.map((file) =>
          file.filename.endsWith(".sig") ? { ...file, sha256: "0".repeat(64) } : file,
        ),
        files,
      ),
      /signature asset differs/,
    );
    const [name, bytes] = [...files][0]!;
    const wrong: unknown = JSON.parse(bytes.toString("utf8"));
    assert.ok(typeof wrong === "object" && wrong !== null);
    files.set(name, Buffer.from(JSON.stringify({ ...wrong, source_tree: "0".repeat(40) })));
    await assert.rejects(
      inspectPublicationRecordAssociation(manifest, facts, assets, files),
      /record differs/,
    );
  });

void test("imported report/completion/tool data cannot create an owned publisher result", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("no actual private publisher"));
  await assert.rejects(
    prepareOwnedPublicationResult({}, {}, {}, process.cwd(), performance.now() + 1000),
    /actual owned immutable/,
  );
  await assert.rejects(
    prepareOwnedPublicationResult({}, {}, {}, process.cwd(), 0),
    /phase deadline/,
  );
  await assert.rejects(
    requireOwnedPublicationResult({ kind: "actual-owned-publication-result" }),
    /actual owned publication result custody/,
  );
});
