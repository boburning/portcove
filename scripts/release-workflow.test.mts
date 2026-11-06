import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, open, opendir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";
import { Octokit } from "@octokit/core";
import { parseDocument, stringify } from "yaml";
import { isRecord } from "./runtime-values.mts";

import {
  loadPackagePolicy,
  releaseLabels as policyReleaseLabels,
  releaseBuildMatrix,
} from "./release-package-policy.mts";

const releaseLabels = policyReleaseLabels(await loadPackagePolicy());
const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);
const cliPackager = await readFile(new URL("./package-cli.ps1", import.meta.url), "utf8");
const cliSmoke = await readFile(new URL("./smoke-test-cli-archive.ps1", import.meta.url), "utf8");
const macosVerifier = await readFile(
  new URL("./verify-macos-release.ps1", import.meta.url),
  "utf8",
);

function parsedWorkflow(text: string) {
  const document = parseDocument(text, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  return parsed as Record<string, unknown> & { jobs: Record<string, Record<string, unknown>> };
}
const reviewedSyftInput = "syft-version: v1.56.0";
const workflowData = parsedWorkflow(workflow);
function job(name: string) {
  const selected = workflowData.jobs[name];
  assert.ok(selected, `missing release job ${name}`);
  // Script-content checks below deliberately inspect commands, not YAML layout.
  return stringify(selected, { lineWidth: 0 });
}
function steps(name: string, data = workflowData) {
  const selected = data.jobs[name]?.steps;
  assert.ok(Array.isArray(selected));
  return selected as Record<string, unknown>[];
}
function needs(name: string, expected: string[], data = workflowData) {
  const actual = data.jobs[name]?.needs;
  const entries: unknown[] = Array.isArray(actual) ? actual : [actual];
  assert.ok(entries.every((entry) => typeof entry === "string"));
  const compare = (left: string, right: string) => left.localeCompare(right);
  assert.deepEqual(entries.map(String).sort(compare), [...expected].sort(compare));
}
function artifact(
  name: string,
  action: string,
  expected: Record<string, unknown>,
  data = workflowData,
) {
  const selected = steps(name, data).find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith(`actions/${action}@`) &&
      isRecord(step.with) &&
      Object.entries(expected).every(
        ([key, value]) => (step.with as Record<string, unknown>)[key] === value,
      ),
  );
  assert.ok(selected, `missing ${name} ${action} relationship ${JSON.stringify(expected)}`);
}
const identitySection = job("identity");
const qualificationSection = job("qualification");
const validateSection = job("validate");
const buildSection = job("build");
const intelBuildSection = job("build_intel");
const intelSection = job("verify_intel");
const gateSection = job("release_gate");
const assembleSection = job("assemble");
const rehearseSection = job("rehearse");
const attestSection = job("attest");
const publishSection = job("publish");

function inlineRunScript(name: string, stepName: string) {
  const step = steps(name).find((step) => step.name === stepName);
  assert.ok(step && typeof step.run === "string", `missing inline run script for ${stepName}`);
  return step.run;
}

const githubScriptPin = "actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3";
function inlineGitHubScript(jobName: string, stepName: string) {
  const step = steps(jobName).find((step) => step.name === stepName);
  assert.ok(step && isRecord(step.with));
  assert.equal(step.uses, githubScriptPin);
  assert.equal(step.with["github-token"], "${{ github.token }}");
  assert.equal(step.with.retries, 0);
  assert.equal(step.with.debug, false);
  assert.equal(step.run, undefined);
  assert.ok(typeof step.with.script === "string" && !step.with.script.includes("${{"));
  return step.with.script;
}

const metadataScript = inlineGitHubScript(
  "assemble",
  "Read existing draft metadata without write permission",
);
const publicationScript = inlineGitHubScript("publish", "Create or reconcile draft release");

function assertWriteAuthority(data: typeof workflowData) {
  assert.deepEqual(data.permissions, { contents: "read" });
  for (const name of ["build", "build_intel", "assemble", "rehearse"])
    assert.deepEqual(data.jobs[name]?.permissions, { contents: "read" });
  assert.deepEqual(data.jobs.attest?.permissions, {
    "artifact-metadata": "write",
    attestations: "write",
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(data.jobs.publish?.permissions, { contents: "write" });
  assert.equal(data.jobs.cleanup, undefined);
  assert.equal(
    Object.values(data.jobs).filter(
      (job) => isRecord(job.permissions) && job.permissions.contents === "write",
    ).length,
    1,
  );
}

void test("write authority is split across isolated attestation and publication jobs", () => {
  assertWriteAuthority(workflowData);
  assert.doesNotMatch(attestSection, /actions\/checkout|run:/);
  assert.doesNotMatch(publishSection, /actions\/checkout|setup-node|node scripts/);
});

void test("release risk jobs install frozen dependencies before binding their reader token", () => {
  for (const [name, operation] of [
    ["assemble", "Bind the SBOM into the final checksum manifest"],
    ["authorize_publication", "Recheck Linux release authorization before upload"],
  ] as const) {
    const selected = steps(name);
    const checkout = selected.find((step) => String(step.uses).startsWith("actions/checkout@"));
    assert.ok(isRecord(checkout?.with) && checkout.with["persist-credentials"] === false);
    const setup = selected.findIndex((step) => String(step.uses).startsWith("pnpm/action-setup@"));
    const install = selected.findIndex(
      (step) => step.name === "Install frozen release risk dependencies before credentials",
    );
    const risk = selected.findIndex((step) => step.name === operation);
    assert.ok(setup >= 0 && install > setup && risk > install);
    if (name === "assemble") {
      const sbom = selected.findIndex((step) =>
        String(step.uses).startsWith("anchore/sbom-action@"),
      );
      assert.ok(sbom >= 0 && setup > sbom);
    }
    assert.deepEqual(selected[install]?.env, { GH_TOKEN: "", GITHUB_TOKEN: "" });
    assert.match(
      String(selected[install]?.run),
      /env -i .* --prod --frozen-lockfile --ignore-scripts --ignore-pnpmfile/u,
    );
    assert.deepEqual(selected[risk]?.env, { GH_TOKEN: "${{ github.token }}" });
    const env = workflowData.jobs[name]?.env;
    assert.ok(!isRecord(env) || !("GH_TOKEN" in env));
    assert.deepEqual(workflowData.jobs[name]?.permissions, { contents: "read" });
  }
});

void test("cheap identity unlocks qualification and builds before the explicit result gate", () => {
  assert.match(identitySection, /actions\/setup-node/);
  assert.doesNotMatch(identitySection, /pnpm install|rust-toolchain|just audit/);
  assert.doesNotMatch(
    identitySection,
    /select-release-channel\.test|reconstruct-application-update-records\.test/,
  );
  needs("qualification", ["identity"]);
  assert.match(qualificationSection, /\.\/\.github\/workflows\/qualification\.yml/);
  assert.match(qualificationSection, /qualification_caller: release/);
  assert.match(qualificationSection, /provenance_scope: release-qualification/);
  needs("validate", ["identity", "qualification"]);
  assert.match(validateSection, /just audit --fresh --profile release/);
  assert.match(validateSection, /needs\.qualification\.outputs\.plan_digest/);
  assert.match(validateSection, /needs\.qualification\.outputs\.plan_gzip_base64/);
  assert.match(validateSection, /PORTCOVE_EXPECTED_CHECKOUT: \$\{\{ github\.sha \}\}/);
  assert.match(validateSection, /node scripts\/validation-plan\.mts/);
  assert.match(validateSection, /node scripts\/workflow-provenance\.mts/);
  assert.match(
    validateSection,
    /workflow-provenance-release-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/,
  );
  assert.match(validateSection, /retention-days: 7/);
  needs("build", ["identity", "validate"]);
  needs("build_intel", ["identity", "validate"]);

  assert.equal(workflowData.jobs.release_gate?.if, "${{ always() && !inputs.report_only_repair }}");
  needs("release_gate", [
    "identity",
    "qualification",
    "validate",
    "build",
    "build_intel",
    "verify_intel",
  ]);
  assert.match(gateSection, /scripts\/release-result-gate\.mts/);
  needs("assemble", ["identity", "release_gate"]);
});

void test("every builder uploads only the staged checksummed payload with short fallback retention", () => {
  for (const label of releaseLabels.filter((label) => label !== "macos-x86_64"))
    assert.ok(releaseBuildMatrix().include.some((row) => row.label === label));
  assert.match(buildSection, /fromJSON\(needs.identity.outputs.build_matrix\)/);
  assert.match(intelBuildSection, /--label macos-x86_64/);
  artifact("build", "upload-artifact", {
    name: "release-build-${{ matrix.label }}-${{ github.run_id }}-${{ github.run_attempt }}",
    path: "release-upload/**",
    "retention-days": 7,
    overwrite: false,
  });
  artifact("build_intel", "upload-artifact", {
    name: "release-build-macos-x86_64-${{ github.run_id }}-${{ github.run_attempt }}",
    "retention-days": 7,
    overwrite: false,
  });
  assert.match(buildSection, /--stage-dir release-upload/);
  assert.match(buildSection, /path: release-upload\/\*\*/);
  assert.match(buildSection, /retention-days: 7/);
  assert.match(buildSection, /overwrite: false/);
  assert.match(intelBuildSection, /retention-days: 7/);
  assert.match(intelBuildSection, /overwrite: false/);
  assert.match(buildSection, /--run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(buildSection, /--revision "\$\{\{ github\.sha \}\}"/);
  assert.doesNotMatch(buildSection, /target\/release\/bundle\/\*\*/);
  assert.doesNotMatch(buildSection, /github\.event_name/);
});

void test("builders package the versioned CLI smoke test it and request explicit Tauri bundles", () => {
  assert.match(buildSection, /scripts\/package-cli\.ps1/);
  assert.match(buildSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.deepEqual(
    releaseBuildMatrix().include.map((row) => row.bundles),
    ["nsis", "appimage,deb,rpm", "dmg"],
  );
  assert.equal(releaseBuildMatrix().include[2]?.target, "aarch64-apple-darwin");
  assert.equal(workflowData.jobs.build_intel?.["runs-on"], "macos-15");
  assert.match(intelBuildSection, /--target x86_64-apple-darwin/);
  assert.match(intelBuildSection, /--bundles dmg/);
  assert.doesNotMatch(buildSection, /os: macos-15-intel/);
  assert.match(buildSection, /shared-key: release-\$\{\{ matrix\.label \}\}/);
});

void test("cross-built Intel artifacts receive native Intel package and launch verification", () => {
  needs("verify_intel", ["identity", "build_intel"]);
  assert.equal(workflowData.jobs.verify_intel?.["runs-on"], "macos-15-intel");
  assert.match(intelSection, /name: release-build-macos-x86_64/);
  assert.match(intelSection, /scripts\/smoke-test-cli-archive\.ps1/);
  assert.match(intelSection, /scripts\/verify-macos-release\.ps1/);
  assert.match(intelSection, /Architecture x86_64/);

  assert.doesNotMatch(macosVerifier, /-acceptlicense/);
});

void test("supplemental macOS packaging source check retains BSD-compatible chmod syntax", () => {
  assert.match(cliPackager, /& chmod \+x \$temporaryExecutable/);
  assert.doesNotMatch(cliPackager, /& chmod \+x --/);
});

void test("supplemental CLI smoke source guard excludes shell-based launcher detours", () => {
  assert.doesNotMatch(cliSmoke, /Start-Process|cmd(?:\.exe)?|\/bin\/sh/iu);
});

void test("assembler reconciles the full matrix then generates and checksums the release SBOM", () => {
  needs("assemble", ["identity", "release_gate"]);
  artifact("assemble", "download-artifact", {
    pattern: "release-build-*-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  const reconcile = assembleSection.indexOf("reconcile-release-assets.mts");
  const sbom = assembleSection.indexOf("anchore/sbom-action@");
  const finalize = assembleSection.indexOf("finalize-release-assets.mts");
  const upload = assembleSection.indexOf("name: release-final");
  assert(reconcile >= 0 && sbom > reconcile && finalize > sbom && upload > finalize);
  assert.ok(assembleSection.includes(reviewedSyftInput));
  assert.match(assembleSection, /upload-release-assets: false/);
  assert.match(
    assembleSection,
    /--sbom-subject-checksums release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.match(assembleSection, /name: release-attestation-metadata/);
  assert.match(assembleSection, /path: release-attestation\/sbom-subject-checksums\.txt/);
  assert.match(assembleSection, /--run-id "\$\{\{ github\.run_id \}\}"/);
  assert.match(assembleSection, /--max-attempt "\$\{\{ github\.run_attempt \}\}"/);
  assert.match(assembleSection, /Refusing to modify non-draft release/);
  assert.match(assembleSection, /Refusing to rewrite existing release notes/);
  assert.doesNotMatch(assembleSection, /releases\/generate-notes/);
});

void test("manual rehearsal verifies every finalized checksum without release write access", () => {
  assert.equal(
    workflowData.jobs.rehearse?.if,
    "${{ !inputs.report_only_repair && github.event_name == 'workflow_dispatch' }}",
  );
  needs("rehearse", ["assemble"]);
  assert.match(rehearseSection, /name: release-final/);
  assert.match(rehearseSection, /sha256sum --check --strict SHA256SUMS\.txt/);
  assert.match(rehearseSection, /name: release-attestation-metadata/);
  assert.match(
    rehearseSection,
    /sha256sum --check --strict \.\.\/release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.doesNotMatch(rehearseSection, /gh release/);
});

void test("tag releases attest exact final bytes and the SBOM before draft mutation", () => {
  assert.equal(
    workflowData.jobs.attest?.if,
    "${{ !inputs.report_only_repair && (github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && (needs.identity.outputs.release_profile == 'initial-beta-win-linux' || needs.identity.outputs.release_profile == 'initial-beta-windows-x86_64-v1'))) }}",
  );
  needs("attest", ["identity", "assemble"]);
  assert.equal((attestSection.match(/actions\/attest@/g) ?? []).length, 3);
  const compilerAttest = steps("attest").find(
    (step) =>
      step.name ===
      "Attest retained compiler report bytes without claiming compiler or native acceptance",
  );
  assert.equal(
    compilerAttest?.if,
    "(needs.identity.outputs.release_profile == 'initial-beta-win-linux' || needs.identity.outputs.release_profile == 'initial-beta-windows-x86_64-v1')",
  );
  assert.match(
    attestSection,
    /subject-path: release-compiler-observations\/compiler-result-\*\.json/,
  );
  assert.match(attestSection, /subject-path: release-assets-aggregate\/\*/);
  assert.match(attestSection, /name: release-attestation-metadata/);
  assert.match(
    attestSection,
    /subject-checksums: release-attestation\/sbom-subject-checksums\.txt/,
  );
  assert.doesNotMatch(
    attestSection,
    /subject-checksums: release-assets-aggregate\/SHA256SUMS\.txt/,
  );
  assert.match(attestSection, /sbom-path: release-assets-aggregate\/Portcove-SBOM\.spdx\.json/);
  needs("publish", ["assemble", "attest", "authorize_publication"]);
});

void test("publisher mutates drafts only from precomputed metadata and attested assets", () => {
  assert.equal(workflowData.jobs.publish?.if, "github.event_name == 'push'");
  assert.equal(steps("publish").length, 3);
  artifact("publish", "download-artifact", {
    name: "release-final-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  artifact("publish", "download-artifact", {
    name: "release-publication-metadata-${{ github.run_id }}-${{ github.run_attempt }}",
  });
  assert.doesNotMatch(
    publicationScript,
    /gh release|child_process|import\(|releases\/latest|latest\/download/u,
  );
  assert.deepEqual(
    [...publicationScript.matchAll(/require\('([^']+)'\)/gu)].map((match) => match[1]),
    ["node:crypto", "node:fs", "node:fs/promises"],
  );
});

const tag = "v0.1.0-beta.1";
const commit = "a".repeat(40);
const fixtureToken = "synthetic-token";
const fixtureNow = Date.parse("2026-01-01T12:00:00Z");
const releaseId = 101;
const repositoryRoute = "/repos/boburning/portcove";
const releasePath = `${repositoryRoute}/releases/${releaseId}`;
const fixtureBody = "reviewed fixture notes\n";
const digest = (bytes: string | ArrayBuffer) =>
  createHash("sha256")
    .update(typeof bytes === "string" ? bytes : Buffer.from(bytes))
    .digest("hex");

type FixtureAsset = { id: number; name: string; size: number; digest: string; state: string };
function fixtureAsset(id: number, name: string, bytes: string | ArrayBuffer): FixtureAsset {
  return {
    id,
    name,
    size: typeof bytes === "string" ? Buffer.byteLength(bytes) : bytes.byteLength,
    digest: `sha256:${digest(bytes)}`,
    state: "uploaded",
  };
}

type FixtureRequest = { origin: string; method: string; path: string; query: URLSearchParams };
const requireBuiltin = createRequire(import.meta.url);
const asyncPrototype: unknown = Object.getPrototypeOf(async () => undefined);
const { constructor: AsyncFunction } = asyncPrototype as {
  constructor: new (...args: string[]) => (...args: unknown[]) => Promise<void>;
};

async function publisherFixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-sdk-publisher-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const metadata = "release-metadata";
  const payload = "release-assets-aggregate";
  await mkdir(path.join(root, metadata));
  await mkdir(path.join(root, payload));
  const file = (relative: string) => path.join(root, relative);
  const names = new Map([
    ["Portcove-fixture.zip", "exact payload"],
    ["Portcove-SBOM.spdx.json", '{"spdxVersion":"SPDX-2.3"}'],
  ]);
  names.set(
    "SHA256SUMS.txt",
    [...names].map(([name, bytes]) => `${digest(bytes)}  ${name}\n`).join(""),
  );
  for (const [name, bytes] of names) await writeFile(file(`${payload}/${name}`), bytes);
  await writeFile(file(`${metadata}/generated-release-body.md`), fixtureBody);

  const state = {
    now: fixtureNow,
    tagSha: commit,
    draft: null as null | {
      id: number;
      tag_name: string;
      draft: boolean;
      body: string;
      name: string;
      prerelease: boolean;
    },
    assets: [] as FixtureAsset[],
    before: undefined as undefined | ((request: FixtureRequest) => Response | undefined),
    after: undefined as undefined | ((request: FixtureRequest) => Response | undefined),
  };
  const requests: FixtureRequest[] = [];
  const effects: FixtureRequest[] = [];
  const failures: string[] = [];
  const outputs = new Map<string, unknown>();
  const github = new Octokit({
    auth: fixtureToken,
    request: {
      fetch: () => {
        throw new Error("Workflow bypassed the injected fetch");
      },
    },
  });
  const json = (value: unknown, status = 200) => Response.json(value, { status });
  const fetcher = async (input: Request, init: RequestInit) => {
    assert.ok(input instanceof Request);
    assert.equal(init.redirect, "manual");
    assert.ok(init.signal);
    init.signal.throwIfAborted();
    assert.equal(input.headers.get("authorization"), `token ${fixtureToken}`);
    const url = new URL(input.url);
    const request = {
      origin: url.origin,
      method: input.method,
      path: url.pathname,
      query: url.searchParams,
    };
    requests.push(request);
    if (request.path !== "/graphql" && request.method !== "GET") effects.push(request);
    const override = state.before?.(request);
    if (override) return override;
    if (request.origin === "https://uploads.github.com") {
      assert.equal(request.path, `${releasePath}/assets`);
      assert.equal(request.method, "POST");
      const name = request.query.get("name");
      assert.ok(
        name &&
          names.has(name) &&
          state.draft?.draft &&
          !state.assets.some((asset) => asset.name === name),
      );
      const bytes = await input.arrayBuffer();
      assert.equal(input.headers.get("content-length"), String(bytes.byteLength));
      assert.equal(input.headers.get("content-type"), "application/octet-stream");
      assert.equal(Buffer.from(bytes).toString(), names.get(name));
      const asset = fixtureAsset(1000 + effects.length, name, bytes);
      state.assets.push(asset);
      return state.after?.(request) ?? json(asset, 201);
    }
    assert.equal(request.origin, "https://api.github.com");
    if (request.path === "/graphql") {
      assert.equal(request.method, "POST");
      const query: unknown = await input.json();
      assert.ok(isRecord(query) && typeof query.query === "string");
      assert.match(query.query, /release\(tagName: \$tag\)/u);
      assert.deepEqual(query.variables, { tag });
      const draft = state.draft;
      return json({
        data: {
          repository: {
            release: draft && {
              databaseId: draft.id,
              isDraft: draft.draft,
              tagName: draft.tag_name,
            },
          },
        },
      });
    }
    if (request.path === `${repositoryRoute}/git/ref/tags/${tag}`)
      return json({ ref: `refs/tags/${tag}`, object: { type: "commit", sha: state.tagSha } });
    if (request.path === `${repositoryRoute}/releases/tags/${tag}`)
      return state.draft && !state.draft.draft ? json(state.draft) : json({}, 404);
    if (request.path === `${repositoryRoute}/releases` && request.method === "POST") {
      assert.equal(state.draft, null);
      assert.deepEqual(await input.json(), {
        tag_name: tag,
        name: `Portcove ${tag}`,
        draft: true,
        prerelease: true,
        generate_release_notes: true,
        body: fixtureBody,
      });
      state.draft = {
        id: releaseId,
        tag_name: tag,
        name: `Portcove ${tag}`,
        draft: true,
        prerelease: true,
        body: `${fixtureBody}
## Generated changes
fixture change`,
      };
      return state.after?.(request) ?? json(state.draft, 201);
    }
    if (request.path === releasePath && request.method === "GET") return json(state.draft);
    if (request.path === `${releasePath}/assets` && request.method === "GET") {
      assert.equal(request.query.get("per_page"), "100");
      const page = Number(request.query.get("page"));
      return json(state.assets.slice((page - 1) * 100, page * 100));
    }
    if (
      request.path.startsWith(`${repositoryRoute}/releases/assets/`) &&
      request.method === "DELETE"
    ) {
      const id = Number(request.path.split("/").at(-1));
      assert.ok(state.draft?.draft && state.assets.some((asset) => asset.id === id));
      state.assets = state.assets.filter((asset) => asset.id !== id);
      return state.after?.(request) ?? new Response(null, { status: 204 });
    }
    throw new Error("Unadmitted fixture request");
  };
  const run = async (scope: "assemble" | "publish", env: Record<string, string> = {}) => {
    failures.length = 0;
    const fixtureDate = new Proxy(Date, {
      get: (target, key, receiver) =>
        key === "now" ? () => state.now : (Reflect.get(target, key, receiver) as unknown),
    });
    const native = {
      lstat: (relative: string) => lstat(file(relative)),
      open: (relative: string, flags: number) => open(file(relative), flags),
      opendir: (relative: string) => opendir(file(relative)),
      writeFile: (relative: string, bytes: string, options: { flag: string }) =>
        writeFile(file(relative), bytes, options),
    };
    const inline = new AsyncFunction(
      "github",
      "context",
      "core",
      "require",
      "process",
      "fetch",
      "Date",
      scope === "assemble" ? metadataScript : publicationScript,
    );
    await inline(
      github,
      {
        eventName: "push",
        ref: `refs/tags/${tag}`,
        sha: commit,
        repo: { owner: "boburning", repo: "portcove" },
      },
      {
        setFailed: (message: string) => failures.push(message),
        setOutput: (key: string, value: unknown) => outputs.set(key, value),
      },
      (name: string): unknown =>
        name === "node:fs/promises" ? native : (requireBuiltin(name) as unknown),
      { env: { LINUX_AUTHORIZED_AT: new Date(fixtureNow).toISOString(), ...env } },
      fetcher,
      fixtureDate,
    );
    return [...failures];
  };
  const review = async () => {
    for (const name of ["reviewed-draft.json", "reviewed-release-body.md"])
      await rm(file(`${metadata}/${name}`), { force: true });
    return run("assemble");
  };
  return { effects, file, names, outputs, requests, review, run, state };
}

void test("pinned workflow uses SDK routes and reconciles only the exact draft assets", async (t) => {
  const fixture = await publisherFixture(t);
  assert.deepEqual(await fixture.review(), []);
  assert.equal(fixture.outputs.get("existing-draft"), false);
  assert.deepEqual(await fixture.run("publish"), []);
  assert.deepEqual(
    fixture.effects.map(({ method, origin }) => [method, origin]),
    [
      ["POST", "https://api.github.com"],
      ...[...fixture.names].map(() => ["POST", "https://uploads.github.com"]),
    ],
  );
  assert.ok(fixture.state.draft?.draft);
  const originalAssets = fixture.state.assets.slice();
  assert.deepEqual(await fixture.review(), []);
  assert.equal(fixture.outputs.get("existing-draft"), true);
  fixture.effects.length = 0;
  assert.deepEqual(await fixture.run("publish"), []);
  assert.deepEqual(fixture.effects, []);
  const stale = fixtureAsset(995, "stale draft file.zip", "stale");
  fixture.state.assets.push(stale);
  fixture.state.after = ({ method }) =>
    method === "DELETE" ? new Response(null, { status: 502 }) : undefined;
  assert.deepEqual(await fixture.run("publish"), []);
  assert.deepEqual(fixture.state.assets, originalAssets);
  assert.deepEqual(
    fixture.effects.map(({ method, path: route }) => [method, route]),
    [["DELETE", `${repositoryRoute}/releases/assets/${stale.id}`]],
  );
});

void test("publisher attempts each mutation once and requires authoritative readback", async (t) => {
  const fixture = await publisherFixture(t);
  assert.deepEqual(await fixture.review(), []);
  fixture.state.after = ({ path: route }) =>
    route === `${repositoryRoute}/releases` ? new Response(null, { status: 502 }) : undefined;
  assert.deepEqual(await fixture.run("publish"), [
    "Draft creation outcome requires a new reviewed attempt",
  ]);
  assert.equal(fixture.effects.length, 1);
  assert.ok(fixture.state.draft?.draft);
  assert.deepEqual(await fixture.review(), []);
  fixture.state.before = ({ origin }) =>
    origin === "https://uploads.github.com"
      ? new Response("sensitive provider body", { status: 502 })
      : undefined;
  fixture.state.after = undefined;
  fixture.effects.length = 0;
  assert.deepEqual(await fixture.run("publish"), ["Release asset mutation did not reconcile"]);
  assert.equal(fixture.effects.length, 1);
  assert.deepEqual(fixture.state.assets, []);
  fixture.state.before = undefined;
  fixture.state.after = ({ origin }) =>
    origin === "https://uploads.github.com" ? new Response(null, { status: 502 }) : undefined;
  fixture.effects.length = 0;
  assert.deepEqual(await fixture.run("publish"), []);
  assert.equal(fixture.effects.length, fixture.names.size);
  assert.equal(fixture.state.assets.length, fixture.names.size);
});

void test("publisher fails closed on stale authority, changed evidence and redirects", async (t) => {
  const fixture = await publisherFixture(t);
  assert.deepEqual(await fixture.review(), []);
  for (const [env, expected] of [
    [
      { LINUX_AUTHORIZED_AT: "malformed" },
      "Linux release authorization timestamp is missing or invalid",
    ],
    [
      { LINUX_AUTHORIZED_AT: new Date(fixtureNow - 901000).toISOString() },
      "Linux release authorization is stale",
    ],
    [
      { LINUX_AUTHORIZED_AT: new Date(fixtureNow + 1000).toISOString() },
      "Linux release authorization is stale",
    ],
    [{ LINUX_RISK_EXPIRES_AT: new Date(fixtureNow).toISOString() }, "Linux risk approval expired"],
  ] as const)
    assert.deepEqual(await fixture.run("publish", env), [expected]);
  assert.deepEqual(fixture.requests.slice(1), []);
  const checksum = fixture.file("release-assets-aggregate/SHA256SUMS.txt");
  const manifest = await readFile(checksum, "utf8");
  await writeFile(checksum, manifest.replace(/^[a-f0-9]{64}/u, "0".repeat(64)));
  assert.deepEqual(await fixture.run("publish"), ["Attested release asset checksum changed"]);
  await writeFile(checksum, manifest);
  fixture.state.tagSha = "b".repeat(40);
  assert.deepEqual(await fixture.run("publish"), ["Release tag identity changed"]);
  fixture.state.tagSha = commit;
  fixture.state.before = ({ path: route }) =>
    route.endsWith(`/git/ref/tags/${tag}`)
      ? new Response(null, {
          status: 302,
          headers: { location: "https://unadmitted.example/sensitive" },
        })
      : undefined;
  assert.deepEqual(await fixture.run("publish"), [
    "Could not verify or reconcile the draft release",
  ]);
  assert.deepEqual(fixture.effects, []);
  assert.ok(fixture.requests.every(({ origin }) => origin === "https://api.github.com"));
});

void test("publisher rejects incomplete asset pages and rechecks expiry before mutation", async (t) => {
  const fixture = await publisherFixture(t);
  assert.deepEqual(await fixture.review(), []);
  assert.deepEqual(await fixture.run("publish"), []);
  assert.deepEqual(await fixture.review(), []);
  fixture.effects.length = 0;
  const inventoryPath = `${releasePath}/assets`;
  const repeatedPage = Array.from({ length: 100 }, (_, index) =>
    fixtureAsset(3000 + index, `fixture-${index}.zip`, "fixture"),
  );
  fixture.state.before = ({ path: route }) =>
    route === inventoryPath ? Response.json(repeatedPage) : undefined;
  assert.deepEqual(await fixture.run("publish"), ["Release asset identity is invalid"]);
  assert.ok(
    fixture.requests.some(
      ({ path: route, query }) => route === inventoryPath && query.get("page") === "2",
    ),
  );
  assert.deepEqual(fixture.effects, []);

  fixture.state.assets.push(fixtureAsset(995, "old asset.zip", "old"));
  let observations = 0;
  fixture.state.before = ({ path: route }) => {
    if (route === inventoryPath && ++observations === 2) fixture.state.now += 1000;
    return undefined;
  };
  const env = { LINUX_RISK_EXPIRES_AT: new Date(fixtureNow + 1000).toISOString() };
  assert.deepEqual(await fixture.run("publish", env), ["Linux risk approval expired"]);
  assert.deepEqual(fixture.effects, []);
});

void test("publisher verifies draft state after asset pagination before delete and upload", async (t) => {
  for (const mutation of ["delete", "upload"]) {
    await t.test(mutation, async (caseContext) => {
      const fixture = await publisherFixture(caseContext);
      assert.deepEqual(await fixture.review(), []);
      assert.deepEqual(await fixture.run("publish"), []);
      assert.deepEqual(await fixture.review(), []);
      fixture.effects.length = 0;
      if (mutation === "delete") {
        fixture.state.assets.push(fixtureAsset(995, "old asset.zip", "old"));
      } else {
        fixture.state.assets.pop();
      }
      const draft = fixture.state.draft;
      assert.ok(draft);
      const inventoryPath = `${releasePath}/assets`;
      let firstPages = 0;
      fixture.state.before = ({ path: route, query }) => {
        if (route !== inventoryPath) return;
        if (query.get("page") === "1" && ++firstPages === 2) {
          const page = [...fixture.state.assets];
          while (page.length < 100) {
            page.push(fixtureAsset(3000 + page.length, `fixture-${page.length}.zip`, "fixture"));
          }
          return Response.json(page);
        }
        if (query.get("page") === "2") draft.draft = false;
        return undefined;
      };
      assert.deepEqual(await fixture.run("publish"), ["Refusing to modify non-draft release"]);
      assert.deepEqual(fixture.effects, []);
      assert.equal(fixture.requests.at(-2)?.query.get("page"), "2");
      assert.equal(fixture.requests.at(-1)?.path, releasePath);
    });
  }
});

void test("read-only lookup rejects upstream errors and publisher refuses unreviewed or published state", async (t) => {
  const fixture = await publisherFixture(t);
  let transient = true;
  fixture.state.before = ({ path: route }) => {
    if (route !== "/graphql" || !transient) return;
    transient = false;
    return new Response("sensitive provider body", { status: 503 });
  };
  assert.deepEqual(await fixture.review(), []);
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(await fixture.run("publish"), []);
  fixture.effects.length = 0;
  assert.deepEqual(await fixture.run("publish"), [
    "Release draft differs from the reviewed metadata",
  ]);
  assert.deepEqual(await fixture.review(), []);
  assert.ok(fixture.state.draft);
  fixture.state.draft.body += "\nchanged externally";
  assert.deepEqual(await fixture.run("publish"), [
    "Release draft differs from the reviewed metadata",
  ]);
  fixture.state.draft.draft = false;
  assert.deepEqual(await fixture.review(), ["Refusing to modify non-draft release"]);
  await writeFile(fixture.file("release-metadata/reviewed-draft.json"), "null");
  assert.deepEqual(await fixture.run("publish"), ["Refusing to modify non-draft release"]);
  fixture.state.before = ({ path: route }) =>
    route === "/graphql"
      ? Response.json({ errors: [{ message: "sensitive response" }] })
      : undefined;
  assert.deepEqual(await fixture.review(), ["Could not verify existing release metadata"]);
  assert.deepEqual(fixture.effects, []);
});

void test("assembly and draft publication retain custody until downstream handoff or expiry", () => {
  assert.equal(workflowData.jobs.cleanup, undefined);
  assert.doesNotMatch(
    workflow,
    /actions: write|actions\/artifacts\/.*artifact_id|Delete verified transient artifacts/,
  );
});

void test("release job semantics survive YAML key and job reordering", () => {
  const reordered = structuredClone(workflowData);
  reordered.jobs = Object.fromEntries(
    Object.entries(reordered.jobs)
      .reverse()
      .map(([name, job]) => [name, Object.fromEntries(Object.entries(job).reverse())]),
  );
  assert.deepEqual(parsedWorkflow(stringify(reordered, { indent: 4 })), workflowData);
  const wrongPermission = structuredClone(reordered);
  wrongPermission.jobs.publish!.permissions = { contents: "read" };
  assert.throws(() => assertWriteAuthority(parsedWorkflow(stringify(wrongPermission))));
  assertWriteAuthority(parsedWorkflow(stringify(reordered, { indent: 4 })));
  const wrongDependency = structuredClone(reordered);
  wrongDependency.jobs.publish!.needs = ["assemble"];
  assert.throws(() =>
    needs(
      "publish",
      ["assemble", "attest", "authorize_publication"],
      parsedWorkflow(stringify(wrongDependency)),
    ),
  );
  needs(
    "publish",
    ["assemble", "attest", "authorize_publication"],
    parsedWorkflow(stringify(reordered, { indent: 4 })),
  );
  const expectedArtifact = { name: "release-final-${{ github.run_id }}-${{ github.run_attempt }}" };
  artifact("publish", "download-artifact", expectedArtifact, parsedWorkflow(stringify(reordered)));
  const wrongArtifact = structuredClone(reordered);
  const download = steps("publish", wrongArtifact).find(
    (step) =>
      isRecord(step.with) &&
      step.with.name === "release-final-${{ github.run_id }}-${{ github.run_attempt }}",
  )!;
  download.with = { name: "foreign-final" };
  assert.throws(() =>
    artifact(
      "publish",
      "download-artifact",
      expectedArtifact,
      parsedWorkflow(stringify(wrongArtifact)),
    ),
  );
});

void test("PowerShell release consumers execute library identity and prefixed plist fixtures", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portcove-release-consumers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const helper = path.join(root, "respond.mjs");
  await writeFile(
    helper,
    'let text="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>{if(text.trim()!=="Y"||process.env.PAGER!=="/bin/cat")process.exit(9);process.stdout.write("license text\\n<?xml version=\\"1.0\\"?><plist/>");});',
  );
  const fixture = path.join(root, "fixture.ps1");
  const buildScript = path.join(root, "build.ps1");
  await writeFile(
    buildScript,
    inlineRunScript("build", "Build desktop bundles").replaceAll("${{ matrix.bundles }}", "dmg"),
  );
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  await writeFile(
    fixture,
    `
$ErrorActionPreference = 'Stop'
function Parse-Source($path) {
  $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors)
  if ($errors.Count) { throw 'production parse failure' }
  return $ast
}
$buildScript = ${quote(buildScript)}
function pnpm { $global:observedArguments = @($args); $global:LASTEXITCODE = 0 }
foreach ($target in @('', 'aarch64-apple-darwin')) {
  $env:RELEASE_TARGET = $target
  & $buildScript
  $expected = @('tauri','build','--bundles','dmg')
  if ($target) { $expected += @('--target',$target) }
  if (($global:observedArguments | ConvertTo-Json -Compress) -cne ($expected | ConvertTo-Json -Compress)) { throw 'desktop bundle arguments differ' }
}
$ast = Parse-Source ${quote(fileURLToPath(new URL("./smoke-test-cli-archive.ps1", import.meta.url)))}
$temporaryParent = ${quote(root)}
$pathAssignments = $ast.FindAll({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -in @('$unicodeMarker','$temporaryDirectory','$extractDirectory','$library')}, $false)
foreach ($statement in $pathAssignments) { . ([scriptblock]::Create($statement.Extent.Text)) }
if ($pathAssignments.Count -ne 4 -or $library -notmatch '[^\\x00-\\x7f]' -or $library -notmatch '\\s' -or $extractDirectory -notmatch '\\s') { throw 'CLI fixture paths omit spaces or Unicode' }
[IO.Directory]::CreateDirectory($library) | Out-Null

$assignment = $ast.Find({param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$selectionOutput'}, $true)
$statements = @($assignment.Parent.Statements)
$first = [Array]::IndexOf($statements, $assignment)
$last = [Array]::FindIndex($statements, [Predicate[object]]{param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$doctorOutput'})
if ($first -lt 0 -or $last -le $first) { throw 'library consumer unavailable' }
$consumer = [scriptblock]::Create(($statements[$first..($last-1)] | ForEach-Object { $_.Extent.Text }) -join "\n")
$PlatformLabel = 'windows-x86_64'
$executable = 'Invoke-FixtureCli'
function Invoke-FixtureCli {
  $global:LASTEXITCODE = 0
  if ($args[-1] -eq 'capabilities') { return $script:capabilities | ConvertTo-Json -Compress }
  return $script:selection | ConvertTo-Json -Compress
}
foreach ($case in @('valid','wrong-library','wrong-provenance','missing-root','missing-exec','missing-show','missing-recover','wrong-capabilities-command')) {
  $script:selection = @{ok=$true; command='library.show'; data=@{source='invocation';root=$library}}
  $script:capabilities = @{ok=$true; command='capabilities'; data=@{raw_stream_commands=@('exec');commands=@('launch.show','launch.recover')}}
  if ($case -eq 'missing-exec') { $script:capabilities.data.raw_stream_commands = @() }
  if ($case -eq 'missing-show') { $script:capabilities.data.commands = @('launch.recover') }
  if ($case -eq 'missing-recover') { $script:capabilities.data.commands = @('launch.show') }
  if ($case -eq 'wrong-capabilities-command') { $script:capabilities.command = 'other' }
  if ($case -eq 'valid') { $script:selection.data.root = "  $library  " }
  if ($case -eq 'wrong-library') { $script:selection.data.root = [IO.Path]::GetTempPath() }
  if ($case -eq 'wrong-provenance') { $script:selection.data.source = 'environment' }
  if ($case -eq 'missing-root') { $script:selection.data.root = Join-Path $library 'absent' }
  $rejected = $false
  try { & $consumer } catch { $rejected = $true }
  if ($rejected -eq ($case -eq 'valid')) { throw "library case $case result differs" }
}
$ast = Parse-Source ${quote(fileURLToPath(new URL("./verify-macos-release.ps1", import.meta.url)))}
$definition = $ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Invoke-CheckedWithResponse'}, $true)
. ([scriptblock]::Create($definition.Extent.Text))
$attach = Invoke-CheckedWithResponse ${quote(process.execPath)} @(${quote(helper)}) 'Y'
$try = $ast.Find({param($n) $n -is [Management.Automation.Language.TryStatementAst] -and $n.Body.Statements[0].Extent.Text -like '$attach =*'}, $false)
$statements = @($try.Body.Statements)
$last = [Array]::FindIndex($statements, [Predicate[object]]{param($n) $n -is [Management.Automation.Language.AssignmentStatementAst] -and $n.Left.Extent.Text -eq '$attachJson'})
if ($last -lt 2) { throw 'plist consumer unavailable' }
$consumer = [scriptblock]::Create(($statements[1..($last-1)] | ForEach-Object { $_.Extent.Text }) -join "\n")
$temporaryRoot = ${quote(root)}
& $consumer
if ([IO.File]::ReadAllText((Join-Path $temporaryRoot 'attach.plist')) -cne '<?xml version="1.0"?><plist/>') { throw 'prefixed plist extraction differs' }
$attach = 'license text without property list'
$rejected = $false
try { & $consumer } catch { $rejected = $true }
if (-not $rejected) { throw 'missing property list accepted' }
`,
  );
  const result = spawnSync("pwsh", ["-NoProfile", "-File", fixture], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
