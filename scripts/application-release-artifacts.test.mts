import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { link, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { prepareApplicationBuildInputs } from "./application-release-build-inputs.mts";
import {
  applicationPackageNames,
  inspectApplicationBuildInputs,
  inspectApplicationPackageBytes,
} from "./application-release-artifacts.mts";
import {
  extractApplicationPackageArchive,
  inspectApplicationPackageArtifact,
} from "./application-release-transfer.mts";
import { applicationReleaseJobMinutes } from "./application-release-policy.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";

const expected = {
  source_commit: "a".repeat(40),
  source_tree: "b".repeat(40),
  version: "0.1.0-alpha.3",
  control_commit: "c".repeat(40),
  control_ref: "refs/tags/portcove-production-controller-windows-upstream-v1",
  run_id: "41800000001",
  package_attempt: 1,
};

void test("committed public inputs reproduce the appointed configuration without a remote configuration publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "application-inputs-"));
  try {
    const result = await prepareApplicationBuildInputs(
      path.join(root, "public"),
      expected.control_commit,
    );
    inspectApplicationBuildInputs(result.receipt, expected.control_commit);
    const bytes = await readFile(result.environment.PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION);
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      "285912b604b05815a1f8932651926b756b16d92005384766e5c19fcc028013f0",
    );
    assert.ok(path.isAbsolute(result.environment.PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE));
    for (const change of [
      { control_commit: "d".repeat(40) },
      { schema_version: 2 },
      { authority: "production" },
      { root_sha256: "d".repeat(64) },
      { payload_public_key_sha256: "d".repeat(64) },
      { tauri_configuration_sha256: "d".repeat(64) },
      { metadata_url: "https://example.com/metadata/" },
    ])
      assert.throws(() =>
        inspectApplicationBuildInputs({ ...result.receipt, ...change }, expected.control_commit),
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("package manifest binds actual bytes and refuses hardlinks or mismatched build authority", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "application-package-"));
  try {
    const publicInputs = await prepareApplicationBuildInputs(
      path.join(root, "public"),
      expected.control_commit,
    );
    const directory = path.join(root, "package");
    await mkdir(directory);
    for (const name of applicationPackageNames(expected.version)) {
      const bytes =
        name === "build-inputs.json"
          ? JSON.stringify(publicInputs.receipt)
          : name === "sbom.spdx.json"
            ? JSON.stringify({ spdxVersion: "SPDX-2.3", packages: [{ name: "inert test" }] })
            : `inert bytes; never executed: ${name}`;
      await writeFile(path.join(directory, name), bytes);
    }
    const before = await inspectApplicationPackageBytes(directory, expected);
    const payload = `Portcove_${expected.version}_x64-setup.exe`;
    await writeFile(path.join(directory, payload), "changed inert bytes");
    const after = await inspectApplicationPackageBytes(directory, expected);
    assert.notEqual(
      before.files.find((file) => file.filename === payload)?.sha256,
      after.files.find((file) => file.filename === payload)?.sha256,
    );
    await link(path.join(directory, payload), path.join(root, "hardlink"));
    await assert.rejects(inspectApplicationPackageBytes(directory, expected));
    await rm(path.join(root, "hardlink"));
    await assert.rejects(
      inspectApplicationPackageBytes(directory, { ...expected, control_commit: "d".repeat(40) }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("package names and provider observations cannot select foreign bytes, attempts or paths", () => {
  for (const version of ["../bad", "1.0.0/../other", "1.0.0\nother", "1.0.0+path", "01.0.0"])
    assert.throws(() => applicationPackageNames(version));
  const binding = { ...expected, artifact: 123, provenance_attempt: 2 };
  const raw = {
    id: 123,
    name: `application-unsigned-${expected.run_id}-2`,
    expired: false,
    size_in_bytes: 1000,
    digest: `sha256:${"d".repeat(64)}`,
    workflow_run: {
      id: Number(expected.run_id),
      head_sha: expected.control_commit,
      repository_id: 1354613114,
    },
  };
  assert.deepEqual(inspectApplicationPackageArtifact(raw, binding), {
    bytes: 1000,
    sha256: "d".repeat(64),
  });
  assert.deepEqual(
    inspectApplicationPackageArtifact(
      { ...raw, name: `application-compiler-${expected.run_id}-2` },
      binding,
      "compiler",
    ),
    { bytes: 1000, sha256: "d".repeat(64) },
  );
  assert.throws(() => inspectApplicationPackageArtifact(raw, binding, "compiler"));
  for (const change of [
    { id: 124 },
    { name: `application-unsigned-${expected.run_id}-1` },
    { expired: true },
    { size_in_bytes: 512 * 1024 ** 2 + 1 },
    { digest: "sha256:unknown" },
    { workflow_run: { ...raw.workflow_run, head_sha: expected.source_commit } },
    { workflow_run: { ...raw.workflow_run, repository_id: 1 } },
    { workflow_run: { ...raw.workflow_run, id: Number(expected.run_id) + 1 } },
  ])
    assert.throws(() => inspectApplicationPackageArtifact({ ...raw, ...change }, binding));
});

void test("compiler handoff rejects unsafe archive declarations before creating any output", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "application-archive-"));
  try {
    const entries = applicationPackageNames(expected.version).map(
      (name) => [name, "inert package data"] as const,
    );
    const valid = createAuditZip(entries);
    const oversized = Buffer.from(valid);
    // Match both local and central declarations; do not allocate or inflate the
    // claimed 512-MiB+1 payload to exercise the pre-extraction refusal.
    oversized.writeUInt32LE(512 * 1024 ** 2 + 1, 22);
    const central = oversized.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(central > 0);
    oversized.writeUInt32LE(512 * 1024 ** 2 + 1, central + 24);
    const invalid = [
      oversized,
      createAuditZip(entries.slice(1)),
      createAuditZip([...entries, ["unexpected.exe", "inert"]]),
      createAuditZip([...entries, ["application-release.json", "{}"]]),
      createAuditZip(
        entries.map(
          ([name, data], index) => [index === 0 ? "../escaped.exe" : name, data] as const,
        ),
      ),
    ];
    for (const [index, archive] of invalid.entries()) {
      const destination = path.join(root, `invalid-${index}`);
      await assert.rejects(
        extractApplicationPackageArchive(archive, destination, expected.version, "compiler"),
      );
      await assert.rejects(stat(destination), { code: "ENOENT" });
    }
    const destination = path.join(root, "valid");
    await extractApplicationPackageArchive(valid, destination, expected.version, "compiler");
    assert.equal(
      await readFile(path.join(destination, entries[0]![0]), "utf8"),
      "inert package data",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("native package workflow keeps candidate execution separate from attestation and private roles", () => {
  const workflow = parse(
    readFileSync(
      new URL("../.github/workflows/application-release-package.yml", import.meta.url),
      "utf8",
    ),
  ) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      "package" | "provenance",
      {
        "timeout-minutes": number;
        environment?: unknown;
        steps: { run?: string; uses?: string; with?: Record<string, unknown> }[];
      }
    >;
  };
  assert.deepEqual(Object.keys(workflow.on), ["workflow_call"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(
    workflow.jobs.package["timeout-minutes"],
    applicationReleaseJobMinutes["package / package"],
  );
  assert.equal(
    workflow.jobs.provenance["timeout-minutes"],
    applicationReleaseJobMinutes["package / provenance"],
  );
  const packageSteps = workflow.jobs.package.steps;
  const compilation = packageSteps.find((step) => step.run?.includes("pnpm tauri build"));
  assert.ok(compilation && typeof compilation.run === "string");
  assert.ok(
    compilation.run.includes("--no-sign --config $env:PORTCOVE_RELEASE_PUBLIC_TAURI_CONFIGURATION"),
  );
  assert.ok(!compilation.run.includes("--features"));
  assert.ok(packageSteps.some((step) => step.run === "cargo build --release -p portcove-cli"));
  const provenanceSteps = workflow.jobs.provenance.steps;
  assert.equal(provenanceSteps[0]?.with?.ref, "${{ github.sha }}");
  assert.equal(provenanceSteps[0]?.with?.["persist-credentials"], false);
  assert.ok(
    !provenanceSteps.some((step) => /pnpm install|cargo |tauri build/u.test(step.run ?? "")),
  );
  assert.ok(provenanceSteps.some((step) => step.uses?.startsWith("actions/attest@")));
  assert.ok(
    provenanceSteps.some(
      (step) => step.run === "node scripts/application-release-transfer.mts compiler",
    ),
  );
  assert.ok(!provenanceSteps.some((step) => step.uses?.startsWith("actions/download-artifact@")));
  const text = JSON.stringify(workflow);
  assert.equal(workflow.jobs.package.environment, undefined);
  assert.equal(workflow.jobs.provenance.environment, undefined);
  assert.ok(!/secrets\.|rust-cache|contents":"write/u.test(text));
});
