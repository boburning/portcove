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
