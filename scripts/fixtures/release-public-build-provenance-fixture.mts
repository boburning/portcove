import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type test from "node:test";
import { trustedAssemblyFixture } from "./trusted-assembly-fixture.mts";
import { createAuditZip } from "./audit-zip-fixture.mts";
import { prepareReleasePublicBuildInputs } from "../release-public-build-inputs.mts";
import { releasePublicBuildArtifactName } from "../release-public-build-provenance.mts";
import type { ReleaseEvidenceRequest } from "../release-run-evidence.mts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const json = (value: unknown) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

/** Inert schema/provider fixtures only: the root is not cryptographically signed,
 * the packages are text, and no build or native/runtime acceptance is implied. */
export async function releasePublicBuildProvenanceFixture(t: test.TestContext) {
  const f = await trustedAssemblyFixture(t, "initial-beta-win-linux");
  const configurationRoot = path.join(f.root, "public-configuration");
  await mkdir(configurationRoot);
  const role = { keyids: ["fixture"], threshold: 1 };
  const material = {
    root: json({
      signatures: [{ keyid: "fixture", sig: "00".repeat(64) }],
      signed: {
        _type: "root",
        spec_version: "1.0.0",
        version: 1,
        consistent_snapshot: true,
        expires: "2030-01-01T00:00:00Z",
        keys: {
          fixture: { keytype: "ed25519", scheme: "ed25519", keyval: { public: "11".repeat(32) } },
        },
        roles: { root: role, targets: role, snapshot: role, timestamp: role },
      },
    }),
    payload_public_key: Buffer.from(
      Buffer.from(
        `untrusted comment: inert fixture public key\n${Buffer.concat([Buffer.from("Ed"), Buffer.alloc(40, 1)]).toString("base64")}\n`,
      ).toString("base64"),
    ),
    packaging: await readFile(
      new URL("../../apps/desktop/src-tauri/tauri.release-public.conf.json", import.meta.url),
    ),
  };
  const manifest = json({
    schema_version: 1,
    repository: "boburning/portcove",
    purpose: "application-release-public-build-inputs",
    metadata_url: "https://boburning.github.io/portcove/application/metadata/",
    targets_url: "https://boburning.github.io/portcove/application/targets/",
    ...Object.fromEntries(
      Object.entries(material).map(([name, bytes]) => [
        name,
        { bytes: bytes.length, sha256: hash(bytes) },
      ]),
    ),
  });
  for (const [name, bytes] of [
    ["root.json", material.root],
    ["updater-public.key", material.payload_public_key],
    ["packaging.json", material.packaging],
    ["bundle.json", manifest],
  ] as const)
    await writeFile(path.join(configurationRoot, name), bytes);
  const configuration = { configuration_revision: "c".repeat(40), manifest_sha256: hash(manifest) };
  const prepared = await prepareReleasePublicBuildInputs({
    configurationRoot,
    observedRevision: configuration.configuration_revision,
    expectedRevision: configuration.configuration_revision,
    expectedManifestSha256: configuration.manifest_sha256,
    outputRoot: f.root,
  });
  const publicFiles = new Map(
    await Promise.all(
      (await readdir(prepared.output)).map(
        async (name) => [name, await readFile(path.join(prepared.output, name))] as const,
      ),
    ),
  );
  const publicZip = () =>
    createAuditZip([...publicFiles].map(([name, bytes]) => [name, bytes, { descriptor: true }]));
  const blobs = new Map<number, Buffer>();
  const archives = ["windows-x86_64", "linux-x86_64"].map((platform, i) => {
    const bytes = createAuditZip(
      f.request.files
        .filter((file) => file.platform_label === platform)
        .map((file) => [
          file.filename,
          f.contents.get(`${platform}/${file.filename}`)!,
          { descriptor: true },
        ]),
    );
    blobs.set(i + 1, bytes);
    return { platform, artifact_id: i + 1, bytes: bytes.length, sha256: hash(bytes) };
  });
  const publicArtifacts = ["linux-x86_64", "windows-x86_64"].map((platform, i) => {
    const bytes = publicZip();
    blobs.set(10 + i, bytes);
    return { platform, artifact_id: 10 + i, bytes: bytes.length, sha256: hash(bytes) };
  });
  const binding = { ...configuration, artifacts: publicArtifacts };
  const request = { ...f.request, schema_version: 3, public_build_inputs: binding };
  const workflow = Buffer.from("inert selected release workflow; never execute");
  const expected: ReleaseEvidenceRequest = {
    schema_version: 1,
    repository_id: 1354613114,
    run_id: 12345,
    attempt: 1,
    revision: request.source_commit,
    tree: request.source_tree,
    workflow_sha256: hash(workflow),
  };
  const state = { reads: 0, drift: false };
  const providerArtifacts = () =>
    [...archives, ...publicArtifacts].map((a) => ({
      id: a.artifact_id,
      name:
        a.artifact_id >= 10
          ? releasePublicBuildArtifactName(a.platform, "12345", 1)
          : `release-build-${a.platform}-12345-1`,
      size_in_bytes: a.bytes,
      digest: `sha256:${state.drift && state.reads > 1 && a.artifact_id >= 10 ? "0".repeat(64) : a.sha256}`,
      expired: false,
      created_at: "2026-10-18T00:00:00Z",
      expires_at: null,
      workflow_run: {
        id: 12345,
        repository_id: 1354613114,
        head_repository_id: 1354613114,
        head_sha: expected.revision,
      },
    }));
  const api = {
    request(method: string, endpoint: string) {
      if (method !== "GET") throw new Error("fixture is read-only");
      const route = new URL(endpoint, "https://api.github.com/").pathname.replace(
        "/repos/boburning/portcove",
        "",
      );
      let body: unknown;
      if (route === "/actions/runs/12345" || route === "/actions/runs/12345/attempts/1")
        body = {
          id: 12345,
          run_attempt: 1,
          head_sha: expected.revision,
          repository: { id: 1354613114, full_name: "boburning/portcove" },
          head_repository: { id: 1354613114 },
          path: ".github/workflows/release.yml",
          status: "completed",
          conclusion: "success",
          workflow_id: 6,
          event: "workflow_dispatch",
          updated_at: "2026-10-18T00:00:00Z",
        };
      else if (route === `/git/commits/${expected.revision}`)
        body = { sha: expected.revision, tree: { sha: expected.tree } };
      else if (route === "/contents/.github/workflows/release.yml")
        body = {
          type: "file",
          path: ".github/workflows/release.yml",
          encoding: "base64",
          size: workflow.length,
          content: workflow.toString("base64"),
        };
      else if (route === "/actions/runs/12345/attempts/1/jobs") body = { total_count: 0, jobs: [] };
      else if (route === "/actions/runs/12345/artifacts") {
        state.reads++;
        body = { total_count: 4, artifacts: providerArtifacts() };
      } else throw new Error(`unexpected provenance fixture route ${route}`);
      return { status: 200, headers: new Map<string, string>(), body };
    },
  };
  const download = (endpoint: string) => {
    const bytes = blobs.get(Number(endpoint.split("/").at(-2)));
    if (!bytes) throw new Error("unknown inert fixture artifact");
    return bytes;
  };
  const replacePublicArchive = () => {
    const bytes = publicZip();
    for (const item of publicArtifacts) {
      item.bytes = bytes.length;
      item.sha256 = hash(bytes);
      blobs.set(item.artifact_id, bytes);
    }
  };
  return {
    ...f,
    request,
    configuration,
    binding,
    expected,
    archives,
    blobs,
    publicFiles,
    prepared,
    options: { evidence: { api }, download },
    api,
    download,
    state,
    replacePublicArchive,
  };
}
