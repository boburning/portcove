import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  serializeSiteTar,
  readBackSiteDeployment,
  inspectSiteArtifactArchive,
  bindSiteDeploymentToPublicationResult,
} from "./release-site-deployment.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";

void test("deterministic Pages tar round-trips ordinary and long safe paths through the installed archive reader", async (context) => {
  const tar =
    process.platform === "win32"
      ? path.join(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe")
      : "/usr/bin/tar";
  if (!existsSync(tar)) {
    context.skip("installed native tar reader unavailable");
    return;
  }
  const long = `catalog/targets/${"long-path+".repeat(15)}.json`;
  const files = new Map([
    [".nojekyll", Buffer.alloc(0)],
    ["application/metadata/timestamp.json", Buffer.from("opaque metadata")],
    [long, Buffer.from([0, 255, 1, 10])],
    ["publication.json", Buffer.from("opaque generation marker")],
  ]);
  const archive = serializeSiteTar(files);
  assert.ok(archive.equals(serializeSiteTar(new Map([...files].reverse()))));
  assert.equal(archive.length % 512, 0);
  const directory = await mkdtemp(path.join(os.tmpdir(), "portcove-site-tar-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const filename = path.join(directory, "artifact.tar");
  await writeFile(filename, archive, { flag: "wx" });
  const env = { PATH: path.dirname(tar), SystemRoot: process.env.SystemRoot };
  const list = execFileSync(tar, ["-tf", filename], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env,
    windowsHide: true,
  })
    .toString("utf8")
    .trim()
    .split(/\r?\n/u);
  assert.deepEqual(list, [...files.keys()].sort());
  for (const [name, bytes] of files) {
    const actual = execFileSync(tar, ["-xOf", filename, name], {
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env,
      windowsHide: true,
    });
    assert.ok(actual.equals(bytes));
  }
});

void test("Pages archive serialization admits no links, traversal, external paths or unsafe names", () => {
  for (const name of [
    "../outside",
    "/outside",
    "a/../../outside",
    "catalog/.hidden",
    "a\\outside",
    "a\nentry",
    `catalog/${"a/".repeat(16)}leaf`,
  ])
    assert.throws(() => serializeSiteTar(new Map([[name, Buffer.from("x")]])), /site tar/u);
  assert.throws(
    () =>
      serializeSiteTar(
        new Map(Array.from({ length: 6002 }, (_, i) => [`file${i}`, Buffer.alloc(0)])),
      ),
    /entry count/u,
  );
});

void test("a serialized deployment receipt cannot be imported as an actual composed session", async () => {
  await assert.rejects(
    readBackSiteDeployment({ kind: "prepared-application-site-deployment" }),
    /imported deployment/u,
  );
  await assert.rejects(
    bindSiteDeploymentToPublicationResult({ kind: "prepared-application-site-deployment" }, {}, {}),
    /actual authenticated site composition/,
  );
});

void test("uploaded ZIP must contain exactly the actual deterministic tar, before any tar interpretation", () => {
  const tar = serializeSiteTar(new Map([[".nojekyll", Buffer.alloc(0)]]));
  const expected = { bytes: tar.length, sha256: createHash("sha256").update(tar).digest("hex") };
  const valid = createAuditZip([["artifact.tar", tar]]);
  assert.equal(inspectSiteArtifactArchive(valid, expected).sha256, expected.sha256);
  const altered = Buffer.from(tar);
  altered[10] = 1;
  for (const archive of [
    createAuditZip([["artifact.tar", altered]]),
    createAuditZip([["artifact.tar", Buffer.concat([tar, Buffer.alloc(1)])]]),
    createAuditZip([["wrong.tar", tar]]),
    createAuditZip([
      ["artifact.tar", tar],
      ["extra", "x"],
    ]),
    createAuditZip([
      ["artifact.tar", tar],
      ["artifact.tar", tar],
    ]),
    createAuditZip([["artifact.tar", tar, { attributes: 0xa1ff0000 }]]),
  ])
    assert.throws(() => inspectSiteArtifactArchive(archive, expected));
});

void test(
  "actual initial keyless Tough assembly composes a first complete site without a fabricated prior",
  {
    skip:
      !process.env.PORTCOVE_TUF_BOOTSTRAP_SITE_TOOL ||
      !process.env.PORTCOVE_TUF_BOOTSTRAP_SITE_FIXTURE,
    timeout: 30000,
  },
  async () => {
    const { readFile, copyFile, mkdir, rm, mkdtemp } = await import("node:fs/promises");
    const { assembleIsolatedTufPublication } = await import("./release-tuf-publication.mts");
    const { composeSiteFiles, readComposedSite } = await import("./release-site-composer.mts");
    const { releaseCanonicalDigest } = await import("./release-canonical.mts");
    const source = process.env.PORTCOVE_TUF_BOOTSTRAP_SITE_FIXTURE!,
      tool = process.env.PORTCOVE_TUF_BOOTSTRAP_SITE_TOOL!,
      sha256 = process.env.PORTCOVE_TUF_BOOTSTRAP_SITE_SHA256;
    assert.ok(sha256 && /^[a-f0-9]{64}$/u.test(sha256));
    assert.equal(
      createHash("sha256")
        .update(await readFile(tool))
        .digest("hex"),
      sha256,
    );
    const root = await mkdtemp(path.join(os.tmpdir(), "initial-site-keyless-")),
      input = path.join(root, "inputs");
    let passed = false;
    try {
      await mkdir(path.join(input, "records"), { recursive: true });
      for (const name of [
        "context.json",
        "initial-bootstrap.json",
        "trusted-root.json",
        "offline-targets.json",
        "payload.json",
        "records/reconstruction-manifest.json",
      ])
        await copyFile(path.join(source, name), path.join(input, name));
      const envelopes = [];
      for (const role of ["releases", "preview", "stable", "snapshot", "timestamp"]) {
        const filename = `${role}.json`,
          file = path.join(source, "envelopes", filename),
          bytes = await readFile(file);
        envelopes.push({
          filename,
          path: file,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      }
      const result = await assembleIsolatedTufPublication(
        {
          context_directory: input,
          tool: { path: tool, sha256 },
          signed_roles: envelopes,
          output_parent: root,
        },
        performance.now() + 15000,
      );
      assert.equal(result.publication.records_sha256, releaseCanonicalDigest([]));
      const rootSHA = createHash("sha256")
        .update(await readFile(path.join(input, "trusted-root.json")))
        .digest("hex");
      const composed = await composeSiteFiles({
        previous: null,
        expected_previous_generation: null,
        application: result.repository,
        application_root_sha256: rootSHA,
        output_parent: root,
        deadline: performance.now() + 10000,
      });
      assert.equal(composed.generation.previous_generation, null);
      assert.equal(composed.changed, true);
      const readback = await readComposedSite(
        composed.output,
        composed.generation.generation,
        rootSHA,
        performance.now() + 10000,
      );
      assert.ok(readback.files.has("application/metadata/timestamp.json"));
      assert.ok(
        ![...readback.files.keys()].some(
          (name) => name.includes("prior/") || name.includes("releases/fake"),
        ),
      );
      passed = true;
    } finally {
      if (passed) await rm(root, { recursive: true, force: true });
      else process.stderr.write(`Retain initial keyless site evidence: ${root}\n`);
    }
  },
);
