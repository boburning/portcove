/** Connected disposable byte/crypto qualification. Controlled provider facts
 * never become hosted admission, native, semantic or publication authority. */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { trustedAssemblyFixture } from "./fixtures/trusted-assembly-fixture.mts";
import { disposableTufWorkerFixture } from "./fixtures/tuf-worker-fixture.mts";
import { assembleTrustedRelease } from "./trusted-release-assembly.mts";
import { loadPackagePolicy, packagesForPlatform, artifactName } from "./release-package-policy.mts";
import { updaterIdentity } from "./updater-artifact-inventory.mts";
import { signReleasePayload } from "./release-payload-signing.mts";
import {
  reconstructApplicationUpdateRecords,
  writeApplicationUpdateReconstruction,
} from "./reconstruct-application-update-records.mts";
import { signIsolatedTufRole, tufRoleDependencies } from "./release-tuf-signing.mts";
import {
  assembleIsolatedTufPublication,
  requireActualTufPublication,
} from "./release-tuf-publication.mts";
import { composeSiteFiles, readComposedSite } from "./release-site-composer.mts";
import { readPublicApplicationSite } from "./release-site-readback.mts";
import {
  prepareAuthenticatedMetadataRenewal,
  inspectPreparedMetadataRenewal,
} from "./release-metadata-renewal.mts";
import {
  proposeImmutableReleaseTransition,
  readImmutableReleaseState,
  performImmutableReleaseEffect,
  requireOwnedImmutableReleaseCompletion,
} from "./release-immutable-publication.mts";
import { releaseCanonicalDigest as digest } from "./release-canonical.mts";
import { prepareReleaseVersion } from "../apps/desktop/scripts/prepare-release-version.mts";
import { capacityFixture } from "./fixtures/release-capacity-fixture.mts";
import {
  checkpointReleaseOpportunity,
  recoverReleaseOpportunity,
  coordinatorStateRef,
} from "./release-coordinator-state.mts";
import {
  runBoundedMetadataRenewalOperation,
  recordCapacityReadback,
  recordPublishedMetadata,
} from "./release-capacity-operation.mts";

const run = promisify(execFile);
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roles = ["releases", "preview", "stable", "snapshot", "timestamp"] as const;
const tool = process.env.PORTCOVE_CONNECTED_RELEASE_TOOL;
const toolSha = process.env.PORTCOVE_CONNECTED_RELEASE_TOOL_SHA256;
function installedAddon() {
  if (process.env.PORTCOVE_CONNECTED_RELEASE_ADDON)
    return process.env.PORTCOVE_CONNECTED_RELEASE_ADDON;
  const desktop = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
  const cli = createRequire(desktop.resolve("@tauri-apps/cli/package.json"));
  return cli.resolve(
    `@tauri-apps/cli-${process.platform === "win32" ? "win32-x64-msvc" : "linux-x64-gnu"}`,
  );
}
async function files(directory: string, prefix = ""): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const value of await files(directory, name)) result.set(...value);
    else result.set(name, await readFile(path.join(directory, name)));
  }
  return new Map([...result].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
async function prepareCandidate(root: string) {
  const repository = path.join(root, "candidate-source");
  await mkdir(repository);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-C", repository, ...args],
      { encoding: "utf8", windowsHide: true },
    ).trim();
  git("init", "--quiet");
  git("config", "user.name", "Disposable connected fixture");
  git("config", "user.email", "fixture@portcove.invalid");
  git("config", "core.autocrlf", "false");
  for (const [name, bytes] of Object.entries({
    "Cargo.toml":
      '[workspace]\nmembers = ["crates/example"]\n[workspace.package]\nversion = "0.1.0-alpha.2"\n',
    "crates/example/Cargo.toml": '[package]\nname = "example"\nversion.workspace = true\n',
    "Cargo.lock": 'version = 4\n\n[[package]]\nname = "example"\nversion = "0.1.0-alpha.2"\n',
    "apps/desktop/package.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
    "apps/desktop/src-tauri/tauri.conf.json": '{\n  "version": "0.1.0-alpha.2"\n}\n',
  })) {
    await mkdir(path.dirname(path.join(repository, name)), { recursive: true });
    await writeFile(path.join(repository, name), bytes);
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "Inert version-authority fixture");
  const source = git("rev-parse", "HEAD"),
    tree = git("rev-parse", "HEAD^{tree}");
  const prepared = await prepareReleaseVersion(
    repository,
    {
      source_commit: source,
      reviewed_commit: source,
      source_tree: tree,
      reviewed_tree: tree,
      change_set_sha256: "a".repeat(64),
      base_version: "0.1.0-alpha.2",
      change: "prerelease",
      compatibility: "compatible",
    },
    ["0.1.0-alpha.2"],
  );
  assert.equal(prepared.version, "0.1.0-alpha.3");
  assert.equal(git("rev-parse", "HEAD"), source);
  assert.deepEqual(git("diff", "--name-only", source, prepared.prepared_commit).split("\n"), [
    "Cargo.lock",
    "Cargo.toml",
    "apps/desktop/package.json",
    "apps/desktop/src-tauri/tauri.conf.json",
  ]);
  return prepared;
}

void test(
  "connected disposable packages, payload signatures, nonempty Tough feed, immutable provider and renewal preserve exact bytes",
  {
    skip: !tool && process.env.PORTCOVE_REQUIRE_CONNECTED_RELEASE_FIXTURE !== "1",
    timeout: 120000,
  },
  async (t) => {
    assert.ok(tool && path.isAbsolute(tool) && toolSha && /^[a-f0-9]{64}$/u.test(toolSha));
    assert.equal(hash(await readFile(tool)), toolSha);
    const root = await mkdtemp(path.join(os.tmpdir(), "portcove-connected-release-"));
    const assemblyFixture = await trustedAssemblyFixture(t, "initial-beta-win-linux");
    const candidate = await prepareCandidate(root);
    assemblyFixture.request.source_commit = candidate.prepared_commit;
    assemblyFixture.request.source_tree = candidate.prepared_tree;
    for (const file of assemblyFixture.request.files.filter((entry) =>
      entry.filename.startsWith("release-producer-"),
    )) {
      const location = path.join(
        assemblyFixture.input,
        `release-build-${file.platform_label}`,
        file.filename,
      );
      const producer = JSON.parse(await readFile(location, "utf8")) as Record<string, unknown>;
      const bytes = Buffer.from(
        JSON.stringify({ ...producer, revision: candidate.prepared_commit }),
      );
      await writeFile(location, bytes);
      file.bytes = bytes.length;
      file.sha256 = hash(bytes);
    }
    const aggregate = await assembleTrustedRelease(
      assemblyFixture.root,
      assemblyFixture.input,
      assemblyFixture.request,
    );
    assert.equal(aggregate.original_compiler, null);
    assert.equal(aggregate.release_authorization, "not-evaluated");
    await mkdir(path.join(root, "release"));
    await cp(
      new URL("../release/package-policy.json", import.meta.url),
      path.join(root, "release/package-policy.json"),
    );
    await cp(aggregate.assets, path.join(root, "packages"), { recursive: true });
    const addon = installedAddon();
    if (process.env.PORTCOVE_CONNECTED_RELEASE_ADDON)
      assert.equal(
        hash(await readFile(addon)),
        process.env.PORTCOVE_CONNECTED_RELEASE_ADDON_SHA256,
      );
    const launcher = path.join(root, "tauri.cjs");
    await writeFile(
      launcher,
      `require(${JSON.stringify(addon)}).run(process.argv.slice(2),"tauri",e=>{if(e)process.exitCode=1});`,
    );
    const keyPath = path.join(root, "disposable.key");
    t.after(() => rm(keyPath, { force: true }));
    await run(
      process.execPath,
      [launcher, "signer", "generate", "--ci", "--password", "", "--write-keys", keyPath],
      {
        env: { SystemRoot: process.env.SystemRoot },
        timeout: 15000,
        maxBuffer: 65536,
      },
    );
    const publicKey = `${keyPath}.pub`,
      publicBytes = await readFile(publicKey);
    const publicId = hash(Buffer.from(publicBytes.toString("utf8").trim(), "base64"));
    const bootstrap = path.join(root, "bootstrap");
    const keys = await disposableTufWorkerFixture(
      bootstrap,
      Buffer.from(publicBytes.toString("utf8").trim(), "base64"),
    );
    const signerTools = {
      node: { path: process.execPath, sha256: hash(await readFile(process.execPath)) },
      tauriAddon: { path: addon, sha256: hash(await readFile(addon)) },
      verifier: { path: tool, sha256: toolSha },
    };
    const policy = await loadPackagePolicy();
    const version = assemblyFixture.request.version;
    const sources = [];
    const signatures = new Map<string, Buffer>();
    let passed = false;
    try {
      for (const label of ["windows-x86_64", "linux-x86_64"] as const) {
        const identity = updaterIdentity(policy, label, version);
        const payloadPath = path.join(root, "packages", identity.filename);
        const payload = await readFile(payloadPath);
        const signed = await signReleasePayload(
          {
            projectRoot: root,
            request: {
              schema_version: 1,
              repository: "boburning/portcove",
              version,
              source_commit: assemblyFixture.request.source_commit,
              platform_label: label,
              filename: identity.filename,
              bytes: payload.length,
              sha256: hash(payload),
              public_key_sha256: publicId,
              qualification_inventory_sha256: aggregate.inventory.sha256,
              aggregate_archive_sha256: digest(aggregate.output_files),
              reservation_checkpoint: "e".repeat(40),
              producer: { run_id: "12345", run_attempt: 1, job_id: "456", artifact_id: "789" },
            },
            payload: payloadPath,
            publicKey,
            output: path.join(root, `signed-${label}`),
            tools: signerTools,
          },
          {
            beforeSign: async () => {},
            keyMaterial: async () => ({ key: await readFile(keyPath, "utf8"), password: "" }),
          },
        );
        const signatureBytes = await readFile(
          path.join(root, `signed-${label}`, signed.signature.filename),
        );
        signatures.set(`${identity.filename}.sig`, signatureBytes);
        await run(
          tool,
          [
            "verify",
            payloadPath,
            path.join(root, `signed-${label}`, signed.signature.filename),
            publicKey,
            hash(payload),
            String(payload.length),
          ],
          { timeout: 10000, env: { SystemRoot: process.env.SystemRoot } },
        );
        const altered = path.join(root, `altered-${label}`);
        await writeFile(altered, Buffer.concat([payload, Buffer.from("changed")]));
        await assert.rejects(
          run(
            tool,
            [
              "verify",
              altered,
              path.join(root, `signed-${label}`, signed.signature.filename),
              publicKey,
              hash(await readFile(altered)),
              String(payload.length + 7),
            ],
            { timeout: 10000, env: { SystemRoot: process.env.SystemRoot } },
          ),
        );
        sources.push({
          inventoryBytes: Buffer.from(
            JSON.stringify({
              schema_version: 1,
              repository: policy.repository,
              version,
              source_commit: assemblyFixture.request.source_commit,
              platform_label: label,
              application_identifier: "io.github.portcove.portcove",
              packages: await Promise.all(
                packagesForPlatform(policy, label).map(async (item) => {
                  const filename = artifactName(item, version),
                    bytes = await readFile(path.join(aggregate.assets, filename));
                  return { id: item.id, filename, bytes: bytes.length, sha256: hash(bytes) };
                }),
              ),
              updater: {
                id: identity.id,
                target: identity.target,
                format: identity.format,
                filename: identity.filename,
                bytes: payload.length,
                sha256: hash(payload),
                public_key_sha256: publicId,
                signature: {
                  filename: `${identity.filename}.sig`,
                  bytes: signatureBytes.length,
                  sha256: hash(signatureBytes),
                },
              },
            }),
          ),
          signatureBytes,
          source_tree: assemblyFixture.request.source_tree,
          qualified_run: {
            workflow: ".github/workflows/release.yml",
            workflow_commit: "c".repeat(40),
            run_id: 12345,
            attempt: 1,
          },
          execution_context: "disposable-byte-fixture-no-native-execution",
          compatibility: {
            minimum_os_version: "1.0.0",
            required_capabilities: [],
            cli_protocol: { min: 1, max: 1 },
            catalog_formats: [2],
            library: { read: { min: 1, max: 1 }, write_schema: 1, lock_protocol: "fixture-only" },
          },
          evidence_ids: ["controlled-provider-disposable-fixture-no-native-acceptance"],
        });
      }
      // Private payload material is gone before any consumer/metadata role runs.
      await rm(keyPath);
      const signAndAssemble = async (context: string, name: string) => {
        const signed: Awaited<ReturnType<typeof signIsolatedTufRole>>[] = [];
        for (const role of roles) {
          const result = await signIsolatedTufRole(
            {
              role,
              context_directory: context,
              output: path.join(root, `${name}-${role}`),
              tool: { path: tool, sha256: toolSha },
              signed_roles: tufRoleDependencies(role).map((dependency) => {
                const item = signed.find((entry) => entry.role === dependency);
                assert.ok(item);
                return {
                  filename: item.filename,
                  path: item.path,
                  bytes: item.bytes,
                  sha256: item.sha256,
                };
              }),
            },
            {
              deadline: performance.now() + 10000,
              beforeKey: async () => {},
              keyMaterial: async () => Buffer.from(keys[role]),
            },
          );
          signed.push(result);
        }
        return assembleIsolatedTufPublication(
          {
            context_directory: context,
            tool: { path: tool, sha256: toolSha },
            signed_roles: signed.map(({ filename, path: file, bytes, sha256 }) => ({
              filename,
              path: file,
              bytes,
              sha256,
            })),
            output_parent: root,
          },
          performance.now() + 10000,
        );
      };
      const initial = await signAndAssemble(bootstrap, "initial");
      const context = path.join(root, "release-context");
      await mkdir(context);
      for (const name of ["trusted-root.json", "offline-targets.json", "payload.json"])
        await cp(path.join(bootstrap, name), path.join(context, name));
      await cp(initial.repository, path.join(context, "prior"), { recursive: true });
      const eligibility = {
        [`v${version}`]: {
          version,
          preview_eligible: true,
          production_eligible: false,
          targets: ["windows-x86_64", "linux-x86_64"],
        },
      };
      const reconstruction = await reconstructApplicationUpdateRecords(sources, eligibility);
      await writeApplicationUpdateReconstruction(path.join(context, "records"), reconstruction, {
        projectRoot: root,
      });
      const bootstrapContext = JSON.parse(
        await readFile(path.join(bootstrap, "context.json"), "utf8"),
      ) as {
        generated_at: string;
        expires: Record<string, string>;
        versions: Record<string, number>;
      };
      const releaseContext = {
        schema_version: 1,
        generated_at: bootstrapContext.generated_at,
        trusted_root: "trusted-root.json",
        offline_targets: "offline-targets.json",
        payload_key_registry: "payload.json",
        reconstructed_records: "records",
        previous_repository: "prior",
        versions: Object.fromEntries(
          Object.entries(bootstrapContext.versions).map(([role, value]) => [
            role,
            role === "targets" ? value : value + 1,
          ]),
        ),
        expires: bootstrapContext.expires,
      };
      await writeFile(path.join(context, "context.json"), JSON.stringify(releaseContext));
      const publication = await signAndAssemble(context, "release");
      assert.equal(publication.records, 4);
      await assert.rejects(requireActualTufPublication(publication), /actual keyless/);
      const envelopes = await Promise.all(
        roles.map(async (role) => {
          const filename = `${role}.json`,
            file = path.join(root, `release-${role}`, filename);
          let bytes = await readFile(file),
            selected = file;
          if (role === "releases") {
            const text = bytes.toString("utf8");
            const altered = text.replace(
              /("sig"\s*:\s*")([a-f0-9])/u,
              (_match: string, prefix: string, first: string) =>
                `${prefix}${first === "0" ? "1" : "0"}`,
            );
            assert.notEqual(altered, text);
            bytes = Buffer.from(altered);
            selected = path.join(root, "changed-signature.json");
            await writeFile(selected, bytes);
          }
          return { filename, path: selected, bytes: bytes.length, sha256: hash(bytes) };
        }),
      );
      await assert.rejects(
        assembleIsolatedTufPublication(
          {
            context_directory: context,
            tool: { path: tool, sha256: toolSha },
            signed_roles: envelopes,
            output_parent: root,
          },
          performance.now() + 10000,
        ),
        /public evidence retained/,
      );
      // A preview version cannot manufacture production promotion evidence.
      await assert.rejects(
        reconstructApplicationUpdateRecords(sources, {
          [`v${version}`]: { ...eligibility[`v${version}`]!, production_eligible: true },
        }),
        /production|stable|prerelease/iu,
      );

      const assetBytes = new Map<string, Buffer>();
      for (const item of aggregate.output_files)
        assetBytes.set(item.filename, await readFile(path.join(aggregate.assets, item.filename)));
      for (const item of signatures) assetBytes.set(...item);
      const releaseIdentity = {
        version,
        source_commit: assemblyFixture.request.source_commit,
        assets: [...assetBytes].map(([filename, bytes]) => ({
          filename,
          bytes: bytes.length,
          sha256: hash(bytes),
        })),
      };
      const release = {
        id: 700,
        tag_name: `v${version}`,
        target_commitish: releaseIdentity.source_commit,
        prerelease: true,
        draft: true,
        immutable: false,
        url: "https://api.github.com/repos/boburning/portcove/releases/700",
        html_url: "https://github.com/boburning/portcove/releases/tag/untagged-fixture",
        upload_url:
          "https://uploads.github.com/repos/boburning/portcove/releases/700/assets{?name,label}",
      };
      const assets: {
        id: number;
        name: string;
        size: number;
        digest: string;
        state: string;
        url: string;
        browser_download_url: string;
      }[] = [];
      const stored = new Map<string, Buffer>();
      let created = false,
        writes = 0;
      let providerReads = 0;
      const provider = {
        request(method: string, endpoint: string) {
          providerReads++;
          assert.equal(method, "GET");
          const tag = endpoint.includes("/git/ref/tags/");
          return {
            status: tag && release.draft ? 404 : 200,
            headers: new Map<string, string>(),
            body: tag
              ? release.draft
                ? null
                : {
                    ref: `refs/tags/v${version}`,
                    object: { type: "commit", sha: releaseIdentity.source_commit },
                  }
              : endpoint.includes("/releases?")
                ? created
                  ? [release]
                  : []
                : endpoint.includes("/assets?")
                  ? assets
                  : release,
          };
        },
      };
      const transport: typeof fetch = async (_input, options) => {
        writes++;
        if (options?.method === "PATCH") {
          release.draft = false;
          release.immutable = true;
          release.html_url = `https://github.com/boburning/portcove/releases/tag/v${version}`;
          for (const item of assets)
            item.browser_download_url = `https://github.com/boburning/portcove/releases/download/v${version}/${item.name}`;
        } else if (options?.body instanceof Uint8Array) {
          assert.equal(typeof _input, "string");
          const url = _input as string,
            name = new URL(url).searchParams.get("name")!;
          const bytes = Buffer.from(options.body);
          stored.set(name, bytes);
          const id = 800 + assets.length;
          assets.push({
            id,
            name,
            size: bytes.length,
            digest: `sha256:${hash(bytes)}`,
            state: "uploaded",
            url: `https://api.github.com/repos/boburning/portcove/releases/assets/${id}`,
            browser_download_url: `https://github.com/boburning/portcove/releases/download/untagged-fixture/${name}`,
          });
        } else created = true;
        return new Response(null, { status: options?.method === "PATCH" ? 200 : 201 });
      };
      for (;;) {
        const actual = readImmutableReleaseState(provider, releaseIdentity);
        const transition = proposeImmutableReleaseTransition(
          releaseIdentity,
          actual.release,
          actual.assets,
        );
        if (transition.decision === "complete") break;
        assert.equal(transition.decision, "effect");
        if (transition.decision !== "effect") throw new Error("expected one fixed effect");
        await performImmutableReleaseEffect(
          transition.effect,
          transition.effect.kind === "upload-asset"
            ? assetBytes.get(transition.effect.asset.filename)!
            : null,
          "disposable-fixture-token-not-provider-authority",
          transport,
          performance.now() + 10000,
        );
      }
      assert.equal(writes, assetBytes.size + 2);
      assert.ok(providerReads > writes);
      assert.deepEqual(stored, assetBytes);
      assert.equal(
        proposeImmutableReleaseTransition(releaseIdentity, release, assets).decision,
        "complete",
      );
      await assert.rejects(requireOwnedImmutableReleaseCompletion({ ...release }), /actual owned/);

      const rootSha = hash(await readFile(path.join(bootstrap, "trusted-root.json")));
      const initialSite = await composeSiteFiles({
        previous: null,
        expected_previous_generation: null,
        application: initial.repository,
        application_root_sha256: rootSha,
        output_parent: root,
      });
      const initialFiles = (
        await readComposedSite(initialSite.output, initialSite.generation.generation, rootSha)
      ).files;
      initialFiles.delete("publication.json");
      initialFiles.set(
        "catalog/targets/disposable.json",
        Buffer.from("preserve exact independent catalog bytes"),
      );
      const markerBody = {
        schema_version: 1,
        previous_generation: initialSite.generation.previous_generation,
        application_root_sha256: rootSha,
        files: [...initialFiles]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([name, bytes]) => ({ path: name, bytes: bytes.length, sha256: hash(bytes) })),
      };
      const seed = path.join(root, "catalog-seed");
      await mkdir(seed);
      for (const [name, bytes] of initialFiles) {
        await mkdir(path.dirname(path.join(seed, name)), { recursive: true });
        await writeFile(path.join(seed, name), bytes);
      }
      await writeFile(
        path.join(seed, "publication.json"),
        JSON.stringify({ ...markerBody, generation: digest(markerBody) }),
      );
      const site = await composeSiteFiles({
        previous: seed,
        expected_previous_generation: digest(markerBody),
        application: publication.repository,
        application_root_sha256: rootSha,
        output_parent: root,
      });
      const siteFiles = await files(site.output);
      t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
        assert.equal(options.credentials, "omit");
        assert.equal(options.redirect, "error");
        const bytes = siteFiles.get(new URL(url).pathname.replace(/^\/portcove\//u, ""));
        assert.ok(bytes);
        const response = new Response(bytes);
        Object.defineProperty(response, "url", { value: url });
        return response;
      });
      await readPublicApplicationSite(site.generation);
      const publicFiles = await files(publication.repository);
      publicFiles.delete("repository-manifest.json");
      const publicPrior = path.join(root, "public-prior");
      await cp(publication.repository, publicPrior, {
        recursive: true,
        filter: (source) => path.basename(source) !== "repository-manifest.json",
      });
      const renewalWork = path.join(root, "renewal-work");
      await mkdir(renewalWork);
      const renewal = await prepareAuthenticatedMetadataRenewal({
        verifier: tool,
        verifier_sha256: toolSha,
        trusted_root: path.join(context, "trusted-root.json"),
        trusted_root_sha256: rootSha,
        previous_repository: publicPrior,
        prior_repository_sha256: digest(
          [...publicFiles].map(([name, bytes]) => ({
            path: name,
            bytes: bytes.length,
            sha256: hash(bytes),
          })),
        ),
        generated_at: new Date(Date.parse(bootstrapContext.generated_at) + 1000)
          .toISOString()
          .replace(".000Z", "Z"),
        output_parent: renewalWork,
      });
      const prepared = await inspectPreparedMetadataRenewal(renewal);
      const renewed = await signAndAssemble(prepared.prepared_root, "renewal");
      assert.equal(renewed.publication.records_sha256, publication.publication.records_sha256);
      const renewedSite = await composeSiteFiles({
        previous: site.output,
        expected_previous_generation: site.generation.generation,
        application: renewed.repository,
        application_root_sha256: rootSha,
        output_parent: root,
      });
      assert.deepEqual(
        await readFile(path.join(renewedSite.output, "catalog/targets/disposable.json")),
        initialFiles.get("catalog/targets/disposable.json"),
      );
      for (const [name, bytes] of await files(publication.repository))
        if (name.startsWith("targets/") || /^metadata\/\d+\./u.test(name))
          assert.deepEqual(await readFile(path.join(renewed.repository, name)), bytes);
      // Existing real Git journal, controlled provider, no hosted executor brand.
      // Lose the response after replacing the served complete site, then settle
      // only through fresh exact-byte public readback without repeating upload.
      const journal = path.join(root, "journal.git");
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", journal, ...args], {
          encoding: "utf8",
          windowsHide: true,
        }).trim();
      await mkdir(journal);
      git("init", "--bare", "--quiet");
      const capacity = { ...capacityFixture(), schema_version: 2 };
      const published = {
        schema_version: 1,
        root_sha256: publication.publication.root_sha256,
        offline_targets_sha256: publication.publication.offline_targets_sha256,
        repository_sha256: publication.publication.repository_sha256,
        snapshot_sha256: publication.publication.snapshot_sha256,
        timestamp_sha256: publication.publication.timestamp_sha256,
        records_sha256: publication.publication.records_sha256,
        versions: publication.publication.versions,
        expires: publication.publication.expires,
        operation_id: null,
        publication: {
          remote_identity: "qualification:connected-site",
          evidence_sha256: digest(site.generation),
          site_generation_sha256: site.generation.generation,
        },
      };
      const source = assemblyFixture.request.source_commit,
        tree = assemblyFixture.request.source_tree;
      const input = {
        schema_version: 2,
        now: new Date().toISOString(),
        active_candidate: null,
        published_metadata: published,
        controller: {
          workflow: ".github/workflows/release-coordinator.yml",
          revision: "3".repeat(40),
          publication_paused: false,
          capacity_attempt: capacity,
        },
        opportunity: {
          source_commit: source,
          source_tree: tree,
          base_commit: source,
          change_set_sha256: "a".repeat(64),
          complete_change_set: true,
          meaningful: false,
          documentation_only: true,
          urgency: false,
          requested_channel: "preview",
          classification: {
            source_commit: source,
            reviewed_commit: source,
            source_tree: tree,
            reviewed_tree: tree,
            change_set_sha256: "a".repeat(64),
            base_version: "0.1.0-alpha.2",
            change: "prerelease",
            compatibility: "compatible",
          },
        },
        publication: {
          complete: true,
          observed_at: new Date().toISOString(),
          published_versions: [version],
          published_sources: [source],
          reserved_versions: [],
          last_routine_preview_at: null,
        },
      };
      const seeded = await checkpointReleaseOpportunity(journal, null, input);
      let siteWrites = 0;
      const request = {
        kind: "upload" as const,
        destination: "qualification:connected-renewal-site",
      };
      const effect = async () => {
        siteWrites++;
        siteFiles.clear();
        for (const item of await files(renewedSite.output)) siteFiles.set(...item);
        throw new Error("controlled provider response lost after complete effect");
      };
      await assert.rejects(
        runBoundedMetadataRenewalOperation(
          journal,
          seeded.checkpoint,
          prepared.descriptor,
          request,
          async () => capacity.boundary,
          effect,
          { maximumReceipts: 1 },
        ),
        /recover and read back/,
      );
      const pendingCheckpoint = git("rev-parse", coordinatorStateRef);
      const pending = await recoverReleaseOpportunity(journal, pendingCheckpoint);
      assert.equal(pending.input.active_candidate, null);
      await assert.rejects(
        runBoundedMetadataRenewalOperation(
          journal,
          pendingCheckpoint,
          prepared.descriptor,
          request,
          async () => capacity.boundary,
          effect,
        ),
        /bounded operation is held/iu,
      );
      const readback = await readPublicApplicationSite(renewedSite.generation);
      const evidence = digest(readback);
      const recovered = await recordCapacityReadback(
        journal,
        pendingCheckpoint,
        "effect-completed",
        evidence,
        {
          completedEffect: {
            remote_identity: "qualification:connected-renewal-site",
            evidence_sha256: evidence,
          },
        },
      );
      const restored = await recoverReleaseOpportunity(journal, recovered.checkpoint);
      assert.ok(
        restored.input.controller &&
          typeof restored.input.controller === "object" &&
          "capacity_attempt" in restored.input.controller,
      );
      const operation = restored.input.controller.capacity_attempt;
      assert.ok(operation && typeof operation === "object" && "operation" in operation);
      const settled = operation.operation;
      assert.ok(settled && typeof settled === "object" && "id" in settled);
      const recorded = await recordPublishedMetadata(journal, recovered.checkpoint, {
        ...published,
        repository_sha256: renewed.publication.repository_sha256,
        snapshot_sha256: renewed.publication.snapshot_sha256,
        timestamp_sha256: renewed.publication.timestamp_sha256,
        versions: renewed.publication.versions,
        expires: renewed.publication.expires,
        operation_id: settled.id,
        publication: {
          remote_identity: "qualification:connected-renewal-site",
          evidence_sha256: evidence,
          site_generation_sha256: renewedSite.generation.generation,
        },
      });
      assert.equal(
        (await recoverReleaseOpportunity(journal, recorded.checkpoint)).input.active_candidate,
        null,
      );
      await assert.rejects(
        runBoundedMetadataRenewalOperation(
          journal,
          recorded.checkpoint,
          prepared.descriptor,
          request,
          async () => capacity.boundary,
          effect,
        ),
        /prior|current|renewal|unchanged/iu,
      );
      assert.equal(siteWrites, 1, "lost response recovery must never repeat the effect");
      assert.equal(
        (
          await composeSiteFiles({
            previous: renewedSite.output,
            expected_previous_generation: renewedSite.generation.generation,
            application: renewed.repository,
            application_root_sha256: rootSha,
            output_parent: root,
          })
        ).changed,
        false,
      );
      passed = true;
    } finally {
      for (const key of Object.values(keys)) key.fill(0);
      await rm(keyPath, { force: true });
      if (passed) await rm(root, { recursive: true, force: true });
      else process.stderr.write(`Retained public connected fixture evidence: ${root}\n`);
    }
  },
);
