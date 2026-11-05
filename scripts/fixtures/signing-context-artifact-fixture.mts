/** Inert public artifact/provider fixture. No real hosted identity or authority. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAuditZip } from "./audit-zip-fixture.mts";
import { releaseCanonicalDigest as digest } from "../release-canonical.mts";
import { productionControllerWorkflow } from "../production-controller-admission.mts";
import { signingContextPredicateType } from "../release-signing-context-artifact.mts";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function signingContextArtifactFixture(
  kind: "release-signing-context" | "metadata-signing-context" = "release-signing-context",
) {
  const metadata = kind === "metadata-signing-context";
  let files = new Map(
    [
      ["context.json", Buffer.from("{}")],
      ["trusted-root.json", Buffer.from("public root")],
      ["offline-targets.json", Buffer.from("offline public targets")],
      ["payload.json", Buffer.from("public keys")],
      ["prior/repository-manifest.json", Buffer.from("{}")],
      ["records/reconstruction-manifest.json", Buffer.from("{}")],
      ["records/releases/1.0.0/windows-x86_64/nsis.json", Buffer.from("record fixture")],
    ].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)) as [string, Buffer][],
  );
  const recordDigest = digest(
    [...files]
      .filter(([name]) => name.startsWith("records/releases/"))
      .map(([name, bytes]) => ({ path: name.slice(8), bytes: bytes.length, sha256: hash(bytes) })),
  );
  const roles = ["targets", "releases", "preview", "stable", "snapshot", "timestamp"];
  const descriptor = {
    schema_version: 1,
    kind: "application-tuf-metadata-renewal",
    generated_at: "2026-10-20T00:00:00Z",
    root_sha256: "3".repeat(64),
    offline_targets_sha256: "6".repeat(64),
    prior_repository_sha256: "4".repeat(64),
    prior_timestamp_sha256: "7".repeat(64),
    prior_snapshot_sha256: "8".repeat(64),
    unchanged_records_sha256: recordDigest,
    current_versions: Object.fromEntries(roles.map((role) => [role, "1"])),
    next_versions: Object.fromEntries(roles.map((role) => [role, role === "targets" ? "1" : "2"])),
    current_expires: Object.fromEntries(roles.map((role) => [role, "2026-10-21T00:00:00Z"])),
    next_expires: Object.fromEntries(
      roles.map((role) => [
        role,
        role === "targets" ? "2026-10-21T00:00:00Z" : "2026-10-22T00:00:00Z",
      ]),
    ),
  };
  if (metadata) {
    files.set("renewal.json", Buffer.from(JSON.stringify(descriptor)));
    files = new Map([...files].sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  const identities = [...files].map(([name, bytes]) => ({
    path: name,
    bytes: bytes.length,
    sha256: hash(bytes),
  }));
  const controller = {
    controller_revision: "a".repeat(40),
    source_tree: "b".repeat(40),
    controller_ref: "refs/tags/portcove-production-controller-fixture",
    run_id: "123",
    run_attempt: 1,
  };
  const binding = metadata
    ? {
        kind: "metadata-renewal",
        descriptor_sha256: digest(descriptor),
        records_sha256: recordDigest,
      }
    : {
        aggregate_sha256: "c".repeat(64),
        native_checks: [{ id: 11 }, { id: 22 }],
        pending_obligations: ["post-sign-native-compatible-update-rollback-journal"],
        records_sha256: digest(
          identities
            .filter((entry) => entry.path.startsWith("records/releases/"))
            .map((entry) => ({ ...entry, path: entry.path.slice(8) })),
        ),
        run_attempt: 1,
        run_id: "456",
        sbom_sha256: "d".repeat(64),
        signatures_sha256: "e".repeat(64),
        source_commit: "f".repeat(40),
        source_tree: "1".repeat(40),
        version: "1.0.0",
      };
  const previous_site_pins = {
    root_sha256: "3".repeat(64),
    repository_sha256: "4".repeat(64),
    site_generation_sha256: "5".repeat(64),
  };
  const facts = metadata
    ? {
        mode: "renewal",
        descriptor,
        namespace: "portcove-fixture",
        checkpoint: "2".repeat(40),
        previous_site_pins,
        setup_plan_sha256: "9".repeat(64),
        public_source_commit: "c".repeat(40),
      }
    : { checkpoint: "2".repeat(40), fixture: true };
  const manifest = {
    schema_version: 1,
    kind,
    controller,
    control_facts: { fixture: true },
    previous_site_pins: {
      root_sha256: "3".repeat(64),
      repository_sha256: "4".repeat(64),
      site_generation_sha256: "5".repeat(64),
    },
    binding,
    facts,
    facts_sha256: digest(facts),
    files: identities,
    authority: "none",
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest)),
    packed = Buffer.concat([...files.values()]);
  const archiveFor = (bytes = manifestBytes, content = packed) =>
    createAuditZip([
      ["signing-context-manifest.json", bytes],
      ["signing-context-bytes.bin", content],
    ]);
  const archive = archiveFor(),
    bundle = createAuditZip([
      ["signing-context-attestation.json", Buffer.from("fixture public bundle")],
    ]);
  const expected = {
    ...controller,
    artifact: { id: 101, sha256: hash(archive) },
    bundle: { id: 202, sha256: hash(bundle) },
    manifest_sha256: hash(manifestBytes),
    binding_sha256: digest(binding),
    facts_sha256: digest(facts),
  };
  const artifactIdentity = { id: 101, bytes: archive.length, sha256: hash(archive) };
  const producer = { run_id: "123", run_attempt: 1, job_id: 501, check_run_id: "777" };
  const predicate = {
    schema_version: 1,
    role: kind,
    controller,
    producer,
    artifact: artifactIdentity,
    manifest_sha256: hash(manifestBytes),
    binding,
    facts_sha256: digest(facts),
    stage: metadata ? "coordinator" : "payload-signing",
    publication_admission: "not-established",
    authority: "none",
  };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: signingContextPredicateType,
    subject: [{ name: `${kind}-manifest`, digest: { sha256: hash(manifestBytes) } }],
    predicate,
  };
  const certificate = {
    issuer: "https://token.actions.githubusercontent.com",
    sourceRepositoryIdentifier: "1354613114",
    sourceRepositoryURI: "https://github.com/boburning/portcove",
    buildSignerURI: `https://github.com/boburning/portcove/${productionControllerWorkflow}@${controller.controller_ref}`,
    buildSignerDigest: controller.controller_revision,
    sourceRepositoryDigest: controller.controller_revision,
    sourceRepositoryRef: controller.controller_ref,
    runnerEnvironment: "github-hosted",
    runInvocationURI: "https://github.com/boburning/portcove/actions/runs/123/attempts/1",
  };
  let requests = 0,
    downloads = 0;
  const faults = { value: "" };
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: controller.controller_revision,
    path: productionControllerWorkflow,
    event: "workflow_dispatch",
    status: "in_progress",
    conclusion: null as string | null,
    repository: { id: 1354613114, full_name: "boburning/portcove" },
    head_repository: { id: 1354613114 },
  };
  const options = {
    metadata: {
      async commit(sha: string) {
        requests++;
        assert.equal(sha, controller.controller_revision);
        return { sha, tree: { sha: controller.source_tree } };
      },
      async job(id: number) {
        requests++;
        assert.equal(id, 501);
        return {
          id,
          run_id: 123,
          run_attempt: 1,
          head_sha: controller.controller_revision,
          name:
            faults.value === "wrong-role-job"
              ? "Sign admitted updater payloads"
              : metadata
                ? "Coordinate application release"
                : "Sign admitted updater payloads",
          status: "completed",
          conclusion: faults.value === "job-failure" ? "failure" : "success",
          check_run_url: `https://api.github.com/repos/boburning/portcove/check-runs/${faults.value === "job" ? "778" : "777"}`,
        };
      },
      async artifact(id: number) {
        requests++;
        assert.ok(id === 101 || id === 202);
        const isBundle = id === 202,
          bytes = isBundle ? bundle : archive;
        return {
          id,
          name: `trusted-${metadata ? "coordinator" : "payload"}-signing-context${isBundle ? "-attestation" : ""}-123-1`,
          expired: false,
          digest: `sha256:${faults.value === "drift" && requests > 7 ? "0".repeat(64) : hash(bytes)}`,
          size_in_bytes: bytes.length,
          workflow_run: {
            id: 123,
            repository_id: 1354613114,
            head_repository_id: 1354613114,
            head_sha: controller.controller_revision,
          },
        };
      },
      async run(id: string) {
        requests++;
        assert.equal(id, "123");
        return structuredClone(run);
      },
      async attempt(id: string, attempt: number) {
        requests++;
        assert.equal(id, "123");
        assert.equal(attempt, 1);
        return structuredClone(run);
      },
    },
    download: (endpoint: string) => {
      downloads++;
      return endpoint.includes("/202/") ? Buffer.from(bundle) : Buffer.from(archive);
    },
    spawn: (_command: string, args: readonly string[]) => {
      assert.ok(
        args.includes("--deny-self-hosted-runners") &&
          args.includes("--source-digest") &&
          args.includes(controller.controller_revision),
      );
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            verificationResult: {
              signature: {
                certificate:
                  faults.value === "certificate"
                    ? { ...certificate, sourceRepositoryIdentifier: "1" }
                    : certificate,
              },
              verifiedTimestamps: [{}],
              statement,
            },
          },
        ]),
        stderr: "",
      };
    },
  };
  return {
    files,
    manifest,
    manifestBytes,
    packed,
    archive,
    archiveFor,
    expected,
    options,
    faults,
    run,
    counts: () => ({ requests, downloads }),
  };
}

/** Simulate only the default OS transport. Production still owns receiver joins. */
export function signingContextRetainedSpawn(f: ReturnType<typeof signingContextArtifactFixture>) {
  return (command: unknown, args: readonly string[]) => {
    assert.equal(command, "gh");
    let stdout: string | Buffer;
    if (args[0] === "attestation") stdout = f.options.spawn("gh", args).stdout;
    else {
      const endpoint = args.find((value) => value.startsWith("repos/boburning/portcove/"));
      assert.ok(endpoint);
      assert.ok(endpoint.endsWith("/zip"));
      stdout = f.options.download(endpoint);
    }
    return {
      pid: 1,
      output: [],
      status: 0,
      signal: null,
      stdout,
      stderr: typeof stdout === "string" ? "" : Buffer.alloc(0),
    };
  };
}

export const signingContextFixtureToken = "ghs_SYNTHETIC_CONTEXT_READER";

export function signingContextProviderFetch(
  f: ReturnType<typeof signingContextArtifactFixture>,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(url.origin, "https://api.github.com");
    assert.equal(url.search, "");
    assert.equal(request.headers.get("authorization"), `token ${signingContextFixtureToken}`);
    assert.equal(request.headers.get("x-github-api-version"), "2022-11-28");
    assert.equal(request.headers.get("accept"), "application/vnd.github+json");
    const route = url.pathname,
      base = "/repos/boburning/portcove";
    const ops = f.options.metadata;
    if (route === `${base}/actions/runs/123`) return Response.json(await ops.run("123"));
    if (route === `${base}/actions/runs/123/attempts/1`)
      return Response.json(await ops.attempt("123", 1));
    if (route === `${base}/actions/jobs/501`) return Response.json(await ops.job(501));
    if (route === `${base}/actions/artifacts/101`) return Response.json(await ops.artifact(101));
    if (route === `${base}/actions/artifacts/202`) return Response.json(await ops.artifact(202));
    assert.equal(route, `${base}/git/commits/${f.expected.controller_revision}`);
    return Response.json(await ops.commit(f.expected.controller_revision));
  };
}
