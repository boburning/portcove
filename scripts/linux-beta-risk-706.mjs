// One owner-approved disposition, not a general advisory exception mechanism.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubApiClient } from "./github-api.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export const approval706 =
  "https://github.com/boburning/portcove/issues/706#issuecomment-6182222682";
export const expiry706 = "2026-11-15T04:59:00.000Z";
export const target706 = "x86_64-unknown-linux-gnu";
const approvalPath = ".github/linux-beta-risk-706.json";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => hash(JSON.stringify(value));
const sha = /^[a-f0-9]{40}$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const groups = ["advisories", "bans", "licenses", "sources"];
const canonicalText = (value) => value.replaceAll("\r\n", "\n");

// Recognize a retained qualification decision for diagnostics, not fresh release eligibility.
export function recordsAcceptedQualification706(payload, source) {
  return (
    payload?.success === false &&
    payload.originalExitCode === 1 &&
    payload.policyDecision?.disposition === "accepted-risk" &&
    payload.policyDecision.approvalUrl === approval706 &&
    payload.policyDecision.candidate === source &&
    payload.policyDecision.purpose === "qualification" &&
    payload.policyDecision.scanPassed === false &&
    payload.policyDecision.scanExitCode === 1 &&
    Array.isArray(payload.stages) &&
    payload.stages.filter((stage) => stage?.status === "failed").length === 1 &&
    payload.stages.every(
      (stage) =>
        stage?.status === "passed" ||
        (stage?.id === "dependency-policy" && stage.status === "failed" && stage.exitCode === 1),
    )
  );
}

function command(commandName, args, cwd) {
  return execFileSync(commandName, args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

export function candidate706(cwd = root, execute = command) {
  const head = execute("git", ["rev-parse", "HEAD"], cwd);
  if (!sha.test(head)) throw new Error("#706 candidate lacks exact source identity");
  if (
    execute(
      "git",
      [
        "diff",
        "HEAD",
        "--name-only",
        "--",
        "Cargo.toml",
        "Cargo.lock",
        "rust-toolchain.toml",
        ".cargo",
        "apps/desktop/src-tauri",
        "crates/portcove-core",
      ],
      cwd,
    )
  )
    throw new Error("#706 candidate must have clean tracked native inputs");
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA !== head)
    throw new Error("#706 checkout does not match the workflow candidate");
  const files = execute(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps/desktop/src-tauri/src",
      "apps/desktop/src-tauri/build.rs",
      "apps/desktop/src-tauri/Cargo.toml",
      "apps/desktop/src-tauri/capabilities",
      "crates/portcove-core/src",
      "crates/portcove-core/Cargo.toml",
      "crates/portcove-core/build.rs",
      "rust-toolchain.toml",
      ".cargo",
      "Cargo.toml",
    ],
    cwd,
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const inputs = files.map((name) => {
    const bytes = readFileSync(path.join(cwd, name));
    let text = canonicalText(bytes.toString("utf8"));
    if (name === "Cargo.toml")
      text = text.replace(
        /(\[workspace\.package\][\s\S]*?\nversion\s*=\s*)"[^"]+"/u,
        '$1"release-version"',
      );
    return [name, hash(/\.(?:rs|json|toml|txt|sql)$/u.test(name) ? text : bytes)];
  });
  const config = JSON.parse(
    readFileSync(path.join(cwd, "apps/desktop/src-tauri/tauri.conf.json"), "utf8"),
  );
  delete config.version; // A release version bump does not change iterator reachability.
  inputs.push(["apps/desktop/src-tauri/tauri.conf.json (except version)", digest(config)]);
  inputs.push([
    "native-build-environment",
    digest(
      [
        "RUSTFLAGS",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_BUILD_RUSTFLAGS",
        "RUSTC_BOOTSTRAP",
        "RUSTC_WRAPPER",
      ].map((name) => [name, process.env[name] ?? null]),
    ),
  ]);
  const metadata = JSON.parse(
    execute(
      "cargo",
      [
        "metadata",
        "--locked",
        "--format-version",
        "1",
        "--filter-platform",
        target706,
        "--features",
        "tauri/custom-protocol",
      ],
      cwd,
    ),
  );
  const packages = new Map(metadata.packages.map((p) => [p.id, p]));
  const nodes = new Map(metadata.resolve.nodes.map((n) => [n.id, n]));
  const selected = new Set(
    metadata.packages.filter((p) => p.name === "glib" && p.version === "0.18.5").map((p) => p.id),
  );
  // Every normal-edge ancestor can import the affected Rust type, including re-exports.
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of nodes.values())
      if (
        !selected.has(n.id) &&
        n.deps.some((d) => selected.has(d.pkg) && d.dep_kinds.some((k) => k.kind === null))
      ) {
        selected.add(n.id);
        changed = true;
      }
  }
  // Pin code generators and their dependency closure as well as the runtime family.
  const todo = metadata.packages
    .filter((p) =>
      /^(glib-macros|gtk3-macros|tauri-macros|tauri-codegen|tauri-build)$/u.test(p.name),
    )
    .map((p) => p.id);
  const visited = new Set();
  while (todo.length) {
    const id = todo.pop();
    if (visited.has(id)) continue;
    visited.add(id);
    selected.add(id);
    todo.push(
      ...nodes
        .get(id)
        .deps.filter((d) => d.dep_kinds.some((k) => k.kind !== "dev"))
        .map((d) => d.pkg),
    );
  }
  const lock = readFileSync(path.join(cwd, "Cargo.lock"));
  const checksums = new Map(
    lock
      .toString()
      .split("[[package]]")
      .slice(1)
      .map((block) => [
        `${block.match(/name = "([^"]+)"/u)?.[1]}@${block.match(/version = "([^"]+)"/u)?.[1]}`,
        block.match(/checksum = "([^"]+)"/u)?.[1] ?? null,
      ]),
  );
  const identity = (id) => {
    const p = packages.get(id);
    return p.source ? `${p.name}@${p.version}:${p.source}` : `${p.name}@workspace`;
  };
  const native = [...selected]
    .map((id) => {
      const p = packages.get(id),
        n = nodes.get(id);
      return {
        id: identity(id),
        checksum: p.source ? checksums.get(`${p.name}@${p.version}`) : null,
        features: n.features.toSorted(),
        dependencies: n.deps
          .filter((d) => selected.has(d.pkg))
          .map((d) => identity(d.pkg))
          .toSorted(),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id, "en"));
  const desktop = metadata.packages.find((p) => p.name === "portcove-desktop");
  const features = nodes.get(desktop.id).features.toSorted();
  if (features.length) throw new Error("#706 does not cover Desktop qualification features");
  return {
    head,
    lockSha256: hash(lock),
    target: target706,
    features: ["default", "tauri/custom-protocol"],
    inputsSha256: digest(inputs),
    dependenciesSha256: digest(native),
    inputs,
    native,
  };
}

export function parseScan706(stdout, stderr) {
  const lines = `${stdout}\n${stderr}`.split(/\r?\n/u).filter((line) => line.trim());
  const diagnostics = [];
  let summary;
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === "diagnostic") {
      if (!["error", "warning", "note", "help"].includes(entry.fields?.severity))
        throw new Error("unknown cargo-deny diagnostic severity");
      diagnostics.push(entry.fields);
    } else if (entry.type === "summary" && !summary) summary = entry.fields;
    else throw new Error("unexpected or duplicate cargo-deny output");
  }
  if (!summary || Object.keys(summary).sort().join() !== groups.toSorted().join())
    throw new Error("incomplete cargo-deny check coverage");
  for (const group of groups)
    for (const key of ["errors", "warnings", "notes", "helps"])
      if (!Number.isSafeInteger(summary[group]?.[key]) || summary[group][key] < 0)
        throw new Error("incomplete cargo-deny summary");
  const errors = diagnostics.filter((d) => d.severity === "error");
  if (errors.length !== groups.reduce((n, group) => n + summary[group].errors, 0))
    throw new Error("cargo-deny diagnostic/summary mismatch");
  return { errors, summary, diagnostics };
}

export function validateApproval706(approval, now = new Date().toISOString()) {
  if (
    approval?.approvalUrl !== approval706 ||
    approval.owner !== "boburning" ||
    approval.expiresAt !== expiry706 ||
    approval.approvedAt !== "2026-10-15T01:21:44.000Z" ||
    approval.advisory !== "RUSTSEC-2024-0429" ||
    approval.alias !== "GHSA-wrw7-89jp-8q8g" ||
    approval.package !== "glib" ||
    approval.version !== "0.18.5"
  )
    throw new Error("#706 approval is absent or out of scope");
  const instant = Date.parse(now);
  if (
    !Number.isFinite(instant) ||
    instant < Date.parse(approval.approvedAt) ||
    instant >= Date.parse(expiry706)
  )
    throw new Error("#706 approval is not valid at this instant");
}

export function decide706({
  approval,
  candidate,
  scan,
  releases,
  purpose = "qualification",
  publicationTag = null,
  now = new Date().toISOString(),
}) {
  validateApproval706(approval, now);
  if (
    !sha.test(candidate?.head) ||
    !sha256.test(candidate?.lockSha256) ||
    candidate.target !== target706 ||
    JSON.stringify(candidate.features) !== '["default","tauri/custom-protocol"]' ||
    candidate.inputsSha256 !== approval.inputsSha256 ||
    candidate.dependenciesSha256 !== approval.dependenciesSha256 ||
    !sha256.test(candidate.inputsSha256) ||
    !sha256.test(candidate.dependenciesSha256)
  )
    throw new Error("#706 candidate inputs changed: reassessment required");
  if (
    !scan ||
    scan.head !== candidate.head ||
    scan.lockSha256 !== candidate.lockSha256 ||
    scan.complete !== true ||
    scan.signal !== null ||
    scan.error !== null ||
    scan.exitCode !== 1 ||
    scan.unsoundAll !== true ||
    scan.configSha256 !== approval.policySha256 ||
    !sha256.test(approval.policySha256) ||
    scan.toolVersion !== "cargo-deny 0.20.2" ||
    scan.scope !== "workspace-default-all-targets-all-checks"
  )
    throw new Error(
      "#706 requires a complete exact-candidate failed scan with full unsoundness coverage",
    );
  const { errors, summary, diagnostics } = parseScan706(scan.stdout, scan.stderr);
  if (
    errors.length !== 1 ||
    errors[0].code !== "unsound" ||
    errors[0].advisory?.id !== "RUSTSEC-2024-0429" ||
    errors[0].advisory?.package !== "glib" ||
    !errors[0].labels?.some(
      (label) => label.span === "glib 0.18.5 registry+https://github.com/rust-lang/crates.io-index",
    )
  )
    throw new Error("#706 does not accept an additional or different finding");
  if (
    diagnostics.some(
      (d) =>
        d.advisory &&
        d !== errors[0] &&
        !(
          d.severity === "warning" &&
          d.code === "unmaintained" &&
          d.advisory.id === "RUSTSEC-2024-0370" &&
          d.advisory.package === "proc-macro-error"
        ),
    )
  )
    throw new Error("#706 does not accept additional advisory findings, including warnings");
  if (!Array.isArray(releases)) throw new Error("#706 release inventory is incomplete");
  const ids = new Set();
  for (const release of releases) {
    if (
      !Number.isSafeInteger(release.id) ||
      ids.has(release.id) ||
      typeof release.draft !== "boolean"
    )
      throw new Error("#706 release inventory has missing or duplicate identity");
    ids.add(release.id);
    if (
      !release.draft &&
      (!Number.isFinite(Date.parse(release.published_at)) ||
        typeof release.tag_name !== "string" ||
        !Array.isArray(release.assets))
    )
      throw new Error("#706 published release inventory is incomplete");
  }
  // Conservative: any published Linux x86-64 desktop package consumes the one-release budget,
  // irrespective of its marketing label. Drafts never consume it.
  const published = releases.filter(
    (r) =>
      !r.draft &&
      Date.parse(r.published_at) >= Date.parse(approval.approvedAt) &&
      r.assets.some(
        (a) =>
          typeof a.name === "string" && /(?:\.AppImage$|amd64\.deb$|x86_64\.rpm$)/iu.test(a.name),
      ),
  );
  if (published.some((r) => r.tag_name !== approval.firstPublicationTag) || published.length > 1)
    throw new Error("#706 expires before publication of the second ordinary Linux beta");
  if (!["qualification", "release"].includes(purpose))
    throw new Error("unknown #706 decision purpose");
  // A reviewed first tag is durable budget identity even if a release is later deleted.
  // It is intentionally unallocated until the actual first candidate is reconfirmed.
  if (
    purpose === "release" &&
    (!/^v\d+\.\d+\.\d+-(?:alpha|beta)\.\d+$/u.test(approval.firstPublicationTag ?? "") ||
      publicationTag !== approval.firstPublicationTag)
  )
    throw new Error("#706 first publication tag is not bound to this candidate");
  return {
    disposition: "accepted-risk",
    approvalUrl: approval706,
    candidate: candidate.head,
    lockSha256: candidate.lockSha256,
    evaluatedAt: now,
    expiresAt: expiry706,
    scanExitCode: scan.exitCode,
    scanPassed: false,
    purpose,
    publicationTag,
    summary,
    advisory: approval.advisory,
    owner: approval.owner,
  };
}

export function scan706(cwd = root, filename = process.env.PORTCOVE_706_SCAN_RECEIPT) {
  const output = filename ?? path.join(cwd, "work", "linux-beta-risk-706", `${randomUUID()}.json`);
  mkdirSync(path.dirname(output), { recursive: true });
  const head = command("git", ["rev-parse", "HEAD"], cwd);
  const lockSha256 = hash(readFileSync(path.join(cwd, "Cargo.lock")));
  const policy = readFileSync(path.join(cwd, "deny.toml"), "utf8");
  // Execute all maintained checks, broadening only the already approved unsoundness
  // coverage when #1993's declarative candidate is not yet delivered. No ignore or
  // severity change; keep both original and execution configuration bytes.
  const strictPolicy = /^unsound\s*=\s*"all"\s*$/mu.test(policy)
    ? canonicalText(policy)
    : canonicalText(policy).replace(/(^ignore[ \t]*=[ \t]*\[\][ \t]*$)/mu, '$1\nunsound = "all"');
  const policyPath = `${output}.deny.toml`;
  writeFileSync(policyPath, strictPolicy, { flag: "wx" });
  const toolVersion = command("cargo", ["deny", "--version"], cwd);
  const run = spawnSync(
    "cargo",
    [
      "deny",
      "--format",
      "json",
      "--config",
      policyPath,
      "check",
      "--hide-inclusion-graph",
      "-W",
      "unmaintained",
    ],
    {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const scan = {
    head,
    lockSha256,
    scope: "workspace-default-all-targets-all-checks",
    unsoundAll: /^\[advisories\]\r?\n(?:(?!^\[)[\s\S])*?^unsound\s*=\s*"all"\s*$/mu.test(
      strictPolicy,
    ),
    configSha256: hash(strictPolicy),
    sourceConfigSha256: hash(canonicalText(policy)),
    sourceConfig: policy,
    executionConfig: strictPolicy,
    toolVersion,
    completedAt: new Date().toISOString(),
    exitCode: run.status,
    signal: run.signal,
    error: run.error ? String(run.error.message) : null,
    complete: !run.error && run.signal === null && [0, 1].includes(run.status),
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
  };
  // Raw streams and status are retained before a separate decision is attempted.
  writeFileSync(output, `${JSON.stringify(scan, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(scan.stdout);
  process.stderr.write(scan.stderr);
  console.log(`[dependency-policy] original cargo-deny exit ${scan.exitCode}; evidence ${output}`);
  return { scan, output };
}

export function decisionInputs706(cwd, scan, now, purpose = "qualification") {
  const approval = JSON.parse(readFileSync(path.join(cwd, approvalPath), "utf8"));
  const releases = new GitHubApiClient().paginateRest(
    "repos/boburning/portcove/releases?per_page=100",
    {
      identity: (r) => r.id,
      label: "#706 publication inventory",
    },
  );
  const api = new GitHubApiClient();
  for (const release of releases)
    if (!release.draft && Date.parse(release.published_at) >= Date.parse(approval.approvedAt))
      release.assets = api.paginateRest(
        `repos/boburning/portcove/releases/${release.id}/assets?per_page=100`,
        {
          identity: (asset) => asset.id,
          label: "#706 published asset inventory",
        },
      );
  return {
    approval,
    candidate: candidate706(cwd),
    scan,
    releases,
    now,
    purpose,
    publicationTag: purpose === "release" ? process.env.GITHUB_REF_NAME : null,
  };
}

export function disposition706(cwd, scan, now, purpose = "qualification") {
  return decide706(decisionInputs706(cwd, scan, now, purpose));
}

export function validateScan706(scan, approval) {
  if (
    !scan?.complete ||
    scan.signal !== null ||
    scan.error !== null ||
    scan.unsoundAll !== true ||
    scan.configSha256 !== approval?.policySha256 ||
    scan.toolVersion !== "cargo-deny 0.20.2"
  )
    throw new Error("incomplete or changed dependency-policy execution");
  const parsed = parseScan706(scan.stdout, scan.stderr);
  if ((scan.exitCode === 0) !== (parsed.errors.length === 0))
    throw new Error("scan exit/diagnostics mismatch");
  return parsed;
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    const [mode] = process.argv.slice(2);
    if (mode === "candidate") console.log(JSON.stringify(candidate706(), null, 2));
    else if (["scan", "check"].includes(mode)) {
      const { scan, output } = scan706();
      if (mode === "check") {
        validateScan706(scan, JSON.parse(readFileSync(path.join(root, approvalPath), "utf8")));
      }
      if (mode === "check" && scan.exitCode === 1) {
        const decision = disposition706(root, scan);
        writeFileSync(`${output}.decision.json`, `${JSON.stringify(decision, null, 2)}\n`, {
          flag: "wx",
        });
        console.log(JSON.stringify(decision));
      } else process.exitCode = scan.exitCode ?? 1;
    } else throw new Error("usage: linux-beta-risk-706.mjs scan|check|candidate");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
