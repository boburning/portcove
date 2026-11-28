import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { credentialFree, requireCatalogReleaseAttestation } from "./catalog-released-reader.mts";
import { fileIdentity } from "./development-evidence.mts";
import {
  recoveryPreviewVersion,
  verifyPublishedRecoveryObservation,
} from "./hosted-installed-windows-recovery.mts";
import { parseSha256Sums } from "./hosted-installed-update.mts";
import { unpackFixedLinuxCli } from "./release-compiler-outputs.mts";
import { isRecord } from "./runtime-values.mts";

const repository = "boburning/portcove";
const scenario = "native-library-recovery-bundle";
const output = path.resolve("work/linux-installed-recovery");
const native = path.join(output, "desktop-verify", "installed", "native");
const temporary = path.join(process.env.RUNNER_TEMP ?? "", "portcove-installed-linux-recovery");
const app = path.join(temporary, "Portcove.AppImage");
const cli = path.join(temporary, "portcove");
const probe = path.join(process.env.RUNNER_TEMP ?? "", "portcove-linux-owned-probe");
const keep = (leaf: string, value: unknown) =>
  writeFile(path.join(output, leaf), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });

assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
assert.equal(process.env.GITHUB_REPOSITORY, repository);
assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(path.isAbsolute(temporary));
assert.ok(
  !process.env.APPIMAGE_EXTRACT_AND_RUN,
  "Extraction mode cannot qualify AppImage recovery",
);

const environment = credentialFree(process.env);
const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", env: environment, timeout: 60_000 }).trim();
const revision = git(["rev-parse", "HEAD"]);
assert.equal(revision, process.env.GITHUB_SHA);

if (process.argv[2] === "prepare") {
  const tag = process.env.PORTCOVE_INSTALLED_RECOVERY_TAG ?? "";
  const version = recoveryPreviewVersion(tag);
  const tagRef = `refs/tags/${tag}`;
  const refs = new Map(
    git(["ls-remote", "--tags", "origin", tagRef, tagRef + "^{}"])
      .split("\n")
      .map((line) => {
        const [sha, ref] = line.split("\t");
        return [ref, sha] as const;
      }),
  );
  const tagObject = refs.get(tagRef);
  const source = refs.get(tagRef + "^{}");
  assert.ok(
    tagObject && source && /^[a-f0-9]{40}$/u.test(tagObject) && /^[a-f0-9]{40}$/u.test(source),
  );
  git(["merge-base", "--is-ancestor", source, "origin/main"]);
  const packageName = `Portcove_${version}_amd64.AppImage`;
  const archiveName = `portcove-cli-${version}-linux-x86_64.tar.gz`;
  const sumsName = "SHA256SUMS";
  const selected = [packageName, packageName + ".sig", archiveName, sumsName];
  const gh = (args: string[], timeout: number) =>
    execFileSync("gh", [...args, "--repo", repository], { encoding: "utf8", timeout });
  await mkdir(temporary);
  await mkdir(path.dirname(native), { recursive: true });
  await keep("selection.json", {
    revision,
    platform: "linux-x86_64",
    scenario,
    version,
    tag,
    tagObject,
    source,
  });
  gh(
    [
      "release",
      "download",
      tag,
      "--dir",
      temporary,
      ...selected.flatMap((asset) => ["--pattern", asset]),
    ],
    240_000,
  );
  const identities = Object.fromEntries(
    await Promise.all(
      selected.map(
        async (asset) =>
          [
            asset,
            await fileIdentity(path.join(temporary, asset), { maxBytes: 128 * 1024 * 1024 }),
          ] as const,
      ),
    ),
  );
  const verified: unknown = JSON.parse(
    gh(
      ["release", "verify-asset", tag, path.join(temporary, packageName), "--format", "json"],
      60_000,
    ),
  );
  assert.ok(isRecord(verified) && isRecord(verified.verificationResult));
  const releaseId = requireCatalogReleaseAttestation(verified.verificationResult.statement, {
    tag,
    tagObject,
    subjects: Object.fromEntries(selected.map((asset) => [asset, identities[asset]!.sha256])),
  });
  const sums = parseSha256Sums(await readFile(path.join(temporary, sumsName), "utf8"));
  for (const asset of [packageName, archiveName]) {
    assert.equal(sums.get(asset), identities[asset]!.sha256);
  }
  const image = path.join(temporary, packageName);
  await writeFile(
    cli,
    unpackFixedLinuxCli(await readFile(path.join(temporary, archiveName)), 128 * 1024 * 1024),
    { flag: "wx", mode: 0o700 },
  );
  await rename(image, app);
  await chmod(app, 0o700);
  const product = {
    app: await fileIdentity(app),
    "preparation-cli": await fileIdentity(cli),
    "preparation-tool": await fileIdentity(probe),
  };
  assert.equal(product.app.sha256, identities[packageName]!.sha256);
  await keep("package-custody.json", {
    verified,
    release_id: releaseId,
    release_source: source,
    tag_object: tagObject,
    identities,
    product,
  });
  await keep("harness-config.json", {
    format_version: 1,
    stage: "harness",
    xvfb: "/usr/bin/Xvfb",
    xkbcomp: "/usr/bin/xkbcomp",
    output_root: output,
    harness_args: [
      "--app",
      app,
      "--driver",
      path.join(process.env.RUNNER_TEMP ?? "", "installed-linux-driver/bin/tauri-driver"),
      "--native-driver",
      "/usr/bin/WebKitWebDriver",
      "--output",
      native,
      "--scenario",
      scenario,
      "--preparation-cli",
      cli,
      "--preparation-tool",
      probe,
    ],
  });
} else if (process.argv[2] === "verify") {
  const before: unknown = JSON.parse(
    await readFile(path.join(output, "package-custody.json"), "utf8"),
  );
  assert.ok(isRecord(before));
  const after = {
    app: await fileIdentity(app),
    "preparation-cli": await fileIdentity(cli),
    "preparation-tool": await fileIdentity(probe),
  };
  assert.deepEqual(after, before.product);
  const recovery = await verifyPublishedRecoveryObservation(native, revision, after, "linux");
  await keep("installed-recovery-result.json", {
    product: after,
    recovery,
    outcome: "passed",
    mode: "ordinary AppImage",
  });
} else if (process.argv[2] === "collect-session") {
  const directories = (await readdir(output, { withFileTypes: true })).filter((directory) =>
    /^private-x11-[a-zA-Z0-9]+$/u.test(directory.name),
  );
  assert.ok(directories.length <= 1);
  for (const directory of directories) {
    assert.ok(directory.isDirectory());
    const base = path.join(output, directory.name);
    const leaves = new Set(await readdir(base));
    for (const leaf of [
      "failed-outer-join.json",
      "outer-join.json",
      "preflight.json",
      "recovery-keyring-readiness.json",
      "runtime-receipt.json",
    ]) {
      if (!leaves.has(leaf)) continue;
      const evidence = await fileIdentity(path.join(base, leaf), { maxBytes: 1024 * 1024 });
      const bytes = await readFile(evidence.path);
      await writeFile(path.join(output, "private-x11-" + leaf), bytes, { flag: "wx" });
    }
  }
} else {
  throw new Error("Select prepare, verify or collect-session");
}
