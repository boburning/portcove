import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { releasePublicBuildProvenanceFixture } from "./fixtures/release-public-build-provenance-fixture.mts";
import { createAuditZip } from "./fixtures/audit-zip-fixture.mts";
import { compiledCliTarFixture } from "./fixtures/compiled-cli-fixture.mts";
import { collectReleaseRunEvidence } from "./release-run-evidence.mts";
import { verifyReleasePublicBuildInputs } from "./release-public-build-provenance.mts";
import {
  collectReleaseCompilerEvidence,
  inspectReleaseCompilerReport,
  requireVerifiedReleaseCompilerEvidence,
} from "./release-compiler-evidence.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roles = [
  "node",
  "tauri-entrypoint",
  "tauri-main",
  "tauri-loader",
  "tauri-native",
  "tauri-manifest",
  "tauri-native-manifest",
  "js-lock",
  "rust-lock",
  "rust-channel",
  "cargo",
  "rustc",
];
async function fixture(t: test.TestContext) {
  const f = await releasePublicBuildProvenanceFixture(t);
  const evidence = collectReleaseRunEvidence(f.expected, { api: f.api });
  const publicInputs = await verifyReleasePublicBuildInputs(f.root, f.binding, evidence, {
    download: f.download,
  });
  const baselineArtifacts = structuredClone(evidence.artifacts);
  const cliPackages = new Map<string, Buffer>();
  const archives = new Map<number, Buffer>();
  const reports: {
    filename: string;
    raw: ReturnType<typeof report>;
    expected: Parameters<typeof inspectReleaseCompilerReport>[1];
  }[] = [];
  let nextId = 30;
  function report(platform: "windows-x86_64" | "linux-x86_64", inter: "cli" | "desktop") {
    const nativePath = platform.startsWith("windows") ? path.win32 : path.posix;
    const root = platform.startsWith("windows")
      ? "D:\\a\\portcove\\portcove"
      : "/home/runner/work/portcove/portcove";
    const pub = publicInputs.receipts.find((item) => item.platform === platform)!;
    const { platform: _platform, ...receipt } = pub;
    const cli = nativePath.join(root, "node_modules/@tauri-apps/cli/tauri.js");
    const cargo = nativePath.join(root, "tools/cargo");
    return {
      schema_version: 2,
      authority: "none",
      evidence_scope: "direct-build-process",
      producer_job: "build",
      state: "completed",
      exit_code: 0,
      failure: null,
      source_commit: f.request.source_commit,
      source_tree: f.request.source_tree,
      run_id: "12345",
      run_attempt: 1,
      platform,
      interface: inter,
      capture_module_sha256: "c".repeat(64),
      target_directory: nativePath.join(root, "target/release-attempt-fixture"),
      cargo_resource_policy: { jobs: 4, incremental: false, shared_target_cache: false },
      public_inputs: receipt,
      input_members: publicInputs.compiler_inputs.find((item) => item.platform === platform)!
        .members,
      rust_toolchain: {
        channel: "1.99.1",
        cargo,
        rustc: nativePath.join(root, "tools/rustc"),
        cargo_version: "cargo 1.99.1 (inert fixture)",
        rustc_version: "rustc 1.99.1 (inert fixture)",
      },
      node: { version: "v24.22.0" },
      tauri: {
        version: "2.12.2",
        native_package: platform.startsWith("windows")
          ? "@tauri-apps/cli-win32-x64-msvc"
          : "@tauri-apps/cli-linux-x64-gnu",
      },
      tools: roles.map((role) => ({
        role,
        bytes: 1,
        sha256: "d".repeat(64),
        file_identity: { dev: 1, ino: 1, nlink: 2, mtime_ms: 1, ctime_ms: 1 },
      })),
      invocation: {
        executable: inter === "cli" ? cargo : nativePath.join(root, "tools/node"),
        cwd: inter === "cli" ? root : nativePath.join(root, "apps/desktop"),
        args:
          inter === "cli"
            ? ["build", "--release", "-p", "portcove-cli"]
            : [
                cli,
                "build",
                "--bundles",
                platform.startsWith("windows") ? "nsis" : "appimage,deb,rpm",
                "--no-sign",
                "--config",
                nativePath.join(root, "public/tauri.release-public.conf.json"),
              ],
        started_at: `2026-10-20T00:0${inter === "cli" ? 1 : 3}:00Z`,
        finished_at: `2026-10-20T00:0${inter === "cli" ? 2 : 4}:00Z`,
      },
      outputs: [] as { filename: string; bytes: number; sha256: string }[],
    };
  }
  for (const [index, platform] of ["windows-x86_64", "linux-x86_64"].entries()) {
    const label = platform as "windows-x86_64" | "linux-x86_64";
    const binary = Buffer.from(`inert ${platform} compiler bytes; never execute`);
    const cli = f.request.files.find(
      (file) => file.platform_label === platform && file.filename.startsWith("portcove-cli-"),
    )!;
    const archive =
      label === "windows-x86_64"
        ? createAuditZip([["portcove.exe", binary]])
        : gzipSync(compiledCliTarFixture(binary));
    cli.bytes = archive.length;
    cli.sha256 = hash(archive);
    cliPackages.set(cli.filename, archive);
    const job = {
      id: 100 + index,
      name: `Build ${platform}`,
      status: "completed",
      conclusion: "success",
      runner_id: 50,
      runner_name: "inert-hosted",
      started_at: "2026-10-20T00:00:00Z",
      completed_at: "2026-10-20T00:10:00Z",
    };
    evidence.jobs.push(job);
    for (const inter of ["cli", "desktop"] as const) {
      const raw = report(label, inter);
      raw.outputs =
        inter === "cli"
          ? [
              {
                filename: label === "windows-x86_64" ? "portcove.exe" : "portcove",
                bytes: binary.length,
                sha256: hash(binary),
              },
            ]
          : f.request.files
              .filter(
                (file) =>
                  file.platform_label === label &&
                  !file.filename.startsWith("portcove-cli-") &&
                  !file.filename.startsWith("SHA256SUMS-") &&
                  !file.filename.startsWith("release-producer-"),
              )
              .map(({ filename, bytes, sha256 }) => ({ filename, bytes, sha256 }));
      const filename = `compiler-result-${inter}-${platform}.json`;
      reports.push({
        filename,
        raw,
        expected: {
          platform: label,
          interface: inter,
          source_commit: f.request.source_commit,
          source_tree: f.request.source_tree,
          run_id: "12345",
          run_attempt: 1,
          job,
          public_receipt: raw.public_inputs,
          input_members: raw.input_members,
        },
      });
    }
  }
  evidence.jobs.push({
    id: 200,
    name: "attest",
    status: "completed",
    conclusion: "success",
    runner_id: 50,
    runner_name: "inert-hosted",
    started_at: "2026-10-20T00:10:00Z",
    completed_at: "2026-10-20T00:11:00Z",
  });
  const subjects: { name: string; digest: { sha256: string } }[] = [];
  const refresh = () => {
    evidence.artifacts = structuredClone(baselineArtifacts);
    archives.clear();
    subjects.length = 0;
    for (const item of reports) {
      const result = Buffer.from(JSON.stringify(item.raw));
      const archive = createAuditZip([
        [item.filename, result],
        [
          item.filename.replace("result", "observation"),
          Buffer.from(
            JSON.stringify({
              ...item.raw,
              state: "started",
              exit_code: null,
              failure: null,
              outputs: [],
              invocation: { ...item.raw.invocation, finished_at: null },
            }),
          ),
        ],
      ]);
      const id = nextId++;
      archives.set(id, archive);
      subjects.push({ name: item.filename, digest: { sha256: hash(result) } });
      evidence.artifacts.push({
        id,
        name: `release-compiler-observation-${item.raw.interface}-${item.raw.platform}-12345-1`,
        bytes: archive.length,
        archive_sha256: hash(archive),
        expired: false,
        created_at: "2026-10-20T00:10:00Z",
        expires_at: null,
        producer_attempt: null,
        producer_job_id: null,
      });
    }
  };
  refresh();
  const ref = `refs/tags/portcove-fixture-prepared/v${f.request.version}`;
  const verified = [
    {
      verificationResult: {
        verifiedTimestamps: [{}],
        signature: {
          certificate: {
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryIdentifier: "1354613114",
            sourceRepositoryURI: "https://github.com/boburning/portcove",
            buildSignerURI: `https://github.com/boburning/portcove/.github/workflows/release.yml@${ref}`,
            buildSignerDigest: f.request.source_commit,
            sourceRepositoryDigest: f.request.source_commit,
            sourceRepositoryRef: ref,
            runnerEnvironment: "github-hosted",
            runInvocationURI: "https://github.com/boburning/portcove/actions/runs/12345/attempts/1",
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicateType: "https://slsa.dev/provenance/v1",
          subject: subjects,
          predicate: {},
        },
      },
    },
  ];
  const options = {
    preparedNamespace: "portcove-fixture",
    download: (endpoint: string) => {
      const bytes = archives.get(Number(endpoint.split("/").at(-2)));
      assert.ok(bytes);
      return bytes;
    },
    spawn: (_command: string, args: readonly string[]) => {
      assert.equal(args[args.indexOf("--hostname") + 1], "github.com");
      return { status: 0, stdout: JSON.stringify(verified), stderr: "" };
    },
  };
  return {
    ...f,
    evidence,
    publicInputs,
    cliPackages,
    reports,
    refresh,
    options,
    collect: () =>
      collectReleaseCompilerEvidence(
        f.root,
        f.request,
        evidence,
        publicInputs,
        cliPackages,
        {},
        options,
      ),
  };
}
void test("actual bounded report transport and complete cross-platform output/package joins remain fixture scope without actual source brand", async (t) => {
  const f = await fixture(t);
  const receipt = await f.collect();
  assert.equal(receipt.state, "verified-compiler-output-bindings");
  assert.equal(receipt.evidence_scope, "injected-provider");
  await assert.rejects(requireVerifiedReleaseCompilerEvidence(receipt), /actual same-process/);
  await assert.rejects(
    requireVerifiedReleaseCompilerEvidence(structuredClone(receipt)),
    /actual same-process/,
  );
});
void test("changed inputs/job/source/refusal/target/tool/invocation and report lifetime refuse", async (t) => {
  const f = await fixture(t);
  for (const item of f.reports)
    assert.equal(inspectReleaseCompilerReport(item.raw, item.expected).authority, "none");
  for (const change of [
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.evidence_scope = "injected-executor";
    },
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.source_commit = "f".repeat(40);
    },
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.invocation.finished_at = "2026-10-20T00:15:00Z";
    },
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.invocation.args = ["unsafe"];
    },
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.tools.pop();
    },
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.cargo_resource_policy.incremental = true;
    },
    (raw: (typeof f.reports)[number]["raw"]) => {
      raw.target_directory = "relative";
    },
  ]) {
    const item = f.reports[0]!;
    const raw = structuredClone(item.raw);
    change(raw);
    assert.throws(() => inspectReleaseCompilerReport(raw, item.expected));
  }
  f.reports[1]!.raw.outputs[0]!.sha256 = "e".repeat(64);
  f.refresh();
  await assert.rejects(f.collect(), /desktop compiler outputs differ/);
});
void test("missing matrix stays Unknown while changed CLI inner bytes and duplicate producer jobs refuse", async (t) => {
  const f = await fixture(t);
  f.evidence.artifacts.pop();
  assert.equal((await f.collect()).state, "unknown");
  f.refresh();
  f.cliPackages.set(f.cliPackages.keys().next().value!, Buffer.from("substituted"));
  await assert.rejects(f.collect(), /package bytes differ/);
  f.evidence.jobs.push({ ...f.evidence.jobs[0]!, id: 999 });
  await assert.rejects(f.collect(), /job identity missing or ambiguous/);
});
