import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createGitHubRunner, GitHubApiError } from "./github-api.mts";
import { readGitHubArtifactArchive } from "./github-binary.mts";
import { withCoordinatorDeadline } from "./release-coordinator-deadline.mts";
import { requireActualPublicationControllerContext } from "./acquire-release-admission.mts";
import { requireReservedPublicationCompletion } from "./production-aggregate-steps.mts";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { inspectTrustedAssemblyInput } from "./trusted-release-assembly.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import {
  reconstructPublicationSignatures,
  materializePublicationUpdaterRoots,
} from "./release-publication-inputs.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
for (const profile of ["initial-beta-win-linux", "initial-beta-windows-x86_64-v1"] as const)
  void test(`publication reconstructs the exact ${profile} signature set across known record newline encodings`, async (t) => {
    const fixture =
      profile === "initial-beta-win-linux"
        ? await trustedAssemblyFixture(t, profile)
        : await releasePublicBuildProvenanceFixture(t, true, profile);
    const { accepted, policy, labels } = await inspectTrustedAssemblyInput(fixture.request);
    const facts = { assembly: fixture.request, archives: [], configuration: {} };
    const files = new Map<string, Buffer>();
    const originals = labels.map((platform, index) => {
      const updater = updaterIdentity(policy, platform, accepted.version);
      const pkg = accepted.files.find((file) => file.filename === updater.filename)!;
      const text = `inert-signature-${platform}`;
      const bytes = Buffer.from(text + (index === 0 ? "\r\n" : "\n"));
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
              bytes: pkg.bytes,
              sha256: pkg.sha256,
              tauri_signature: text,
            },
          }),
        ),
      );
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
    const manifest = {
      facts,
      controller: {},
      binding: {
        version: accepted.version,
        source_commit: accepted.source_commit,
        source_tree: accepted.source_tree,
        run_id: String(accepted.run_id),
        run_attempt: accepted.run_attempt,
        signatures_sha256: digest(originals.map((item) => item.identity)),
        records_sha256: "f".repeat(64),
      },
    };
    const actual = await reconstructPublicationSignatures(manifest, facts, files);
    assert.deepEqual(
      actual,
      originals.map(({ platform, filename, bytes }) => ({ platform, filename, bytes })),
    );
    const reverse = {
      ...manifest,
      binding: {
        ...manifest.binding,
        signatures_sha256: digest([...originals].reverse().map((item) => item.identity)),
      },
    };
    assert.deepEqual(await reconstructPublicationSignatures(reverse, facts, files), actual);
    await assert.rejects(
      reconstructPublicationSignatures(
        { ...manifest, binding: { ...manifest.binding, signatures_sha256: "0".repeat(64) } },
        facts,
        files,
      ),
      /pair digest/,
    );
    await assert.rejects(
      reconstructPublicationSignatures(
        { ...manifest, binding: { ...manifest.binding, source_commit: "0".repeat(40) } },
        facts,
        files,
      ),
      /lineage/,
    );
    const [name, bytes] = [...files][0]!;
    files.set(
      name,
      Buffer.from(bytes.toString("utf8").replace("inert-signature", "modified-signature")),
    );
    await assert.rejects(reconstructPublicationSignatures(manifest, facts, files), /pair digest/);
  });
void test("a copied signing context cannot materialize signer output directories", async () => {
  await assert.rejects(
    materializePublicationUpdaterRoots(
      {},
      {},
      process.cwd(),
      process.cwd(),
      Buffer.from("AA=="),
      performance.now() + 1000,
    ),
    /actual authenticated/,
  );
  assert.throws(
    () =>
      requireActualPublicationControllerContext({ mode: "completion-only", phase: "promoting" }),
    /actual same-process/,
  );
  await assert.rejects(requireReservedPublicationCompletion("{}", {}, {}), /actual same-process/);
});
void test("shared publication deadline bounds actual subprocess settings and refuses late success without erasing timeout evidence", async (t) => {
  let clock = 100;
  t.mock.method(performance, "now", () => clock);
  const runner = createGitHubRunner({
    timeoutMs: 15000,
    spawn: (_command, _args, settings) => {
      assert.equal(settings.timeout, 900);
      return { status: 0, stdout: "safe", stderr: "" };
    },
  });
  await withCoordinatorDeadline(1000, async () => assert.equal(runner(["api", "fixed"]), "safe"));
  await withCoordinatorDeadline(1000, async () => {
    assert.equal(
      readGitHubArtifactArchive("repos/boburning/portcove/actions/artifacts/1/zip", {
        cwd: process.cwd(),
        maxBytes: 22,
        timeoutMs: 120000,
        spawn: (_command, _args, settings) => {
          assert.equal(settings.timeout, 900);
          return { status: 0, stdout: Buffer.alloc(22) };
        },
      }).length,
      22,
    );
  });
  const late = createGitHubRunner({
    spawn: () => {
      clock = 1001;
      return { status: 0, stdout: "late", stderr: "" };
    },
  });
  await assert.rejects(
    withCoordinatorDeadline(1000, async () => late(["api", "fixed"])),
    /deadline/,
  );
  clock = 100;
  const timedOut = createGitHubRunner({
    spawn: () => {
      clock = 1001;
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
      };
    },
  });
  await assert.rejects(
    withCoordinatorDeadline(1000, async () => timedOut(["api", "fixed"])),
    (error: unknown) =>
      error instanceof GitHubApiError &&
      error.cause instanceof Error &&
      "code" in error.cause &&
      error.cause.code === "ETIMEDOUT",
  );
});
