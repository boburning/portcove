import { workflowJobs } from "./qualification-coverage.mts";
import { readWorkflow } from "./ci-workflow-fixture.mts";
import assert from "node:assert/strict";

import { isRecord } from "./runtime-values.mts";

import { readFile } from "node:fs/promises";
import test from "node:test";

import { parseDocument } from "yaml";

import {
  requiredFixture,
  workflowJob,
  workflowStep,
  workflowJobSource,
  nativeDesignCompatibilityWorkflow,
  windowsStorage,
  catalog,
} from "./ci-workflow-fixture.mts";

void test("ordinary Linux package operation is fixed and isolated from fixture builds and broader dispatch", async () => {
  const sections = nativeDesignCompatibilityWorkflow.split(/^  (?=[a-z_]+:)/mu);
  const block = sections.find((section) => section.startsWith("linux_package_boundary:\n"));
  assert.ok(block);
  const owner = workflowJob("linux_package_boundary", nativeDesignCompatibilityWorkflow);
  assert.ok(Array.isArray(owner.steps));
  const shipping: unknown = owner.steps.find(
    (step: unknown) =>
      isRecord(step) &&
      step.name === "Run the unchanged shipping boundary with synthetic media readiness",
  );
  assert.ok(isRecord(shipping) && isRecord(shipping.env));
  assert.equal(shipping["timeout-minutes"], 10);
  assert.equal(
    shipping.env.PORTCOVE_RETAINED_EVIDENCE_DIR,
    "${{ runner.temp }}/pcv-package2-retained-inputs",
  );
  assert.equal(
    shipping.run,
    "node scripts/run-rust-tests.mts --guard-command node scripts/desktop-linux-media.mts --run",
  );
  assert.doesNotMatch(requiredFixture(block.split("    steps:")[0]), /\$\{\{ runner\./u);
  assert.match(block, /\$\{\{ runner\.temp \}\}\/pcv-package2-retained-inputs\/\*\*/u);
  const mediaAdapter = await readFile(
    new URL("./desktop-linux-media.mts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(mediaAdapter, /PORTCOVE_RETAINED_EVIDENCE_DIR\s*:/u);
  assert.match(mediaAdapter, /PORTCOVE_SHARED_TOOL_CACHE: toolCachePaths\(\)\.sharedRoot/u);
  assert.match(
    mediaAdapter,
    /acquireNativeSessionLock\(\{\s*workspace: root,\s*scenarios: \["native-linux-packaged-webview-boundary"\],\s*namespaceDelegation: true,/u,
  );
  assert.match(
    block,
    /if: \$\{\{ inputs\.operation == 'linux-package-boundary' && \(inputs\.runner == 'ubuntu-22\.04' \|\| inputs\.runner == 'ubuntu-24\.04'\) && !inputs\.edge_driver_proof \}\}/u,
  );
  assert.match(block, /runs-on: \$\{\{ inputs\.runner \}\}/u);
  assert.doesNotMatch(
    block,
    /VITE_PORTCOVE_DESIGN_COMPATIBILITY_FIXTURE|--features|secrets\.|continue-on-error|sysctl|apparmor_parser/u,
  );
  assert.deepEqual(
    sections
      .filter((section) => /^\w+:\n    if:.*linux-package-boundary/mu.test(section))
      .map((section) => section.split(":")[0]),
    ["linux_package_boundary"],
  );
  assert.match(
    block,
    /desktop-linux-media\.mts --prepare[\s\S]*desktop-linux-media\.mts --build[\s\S]*desktop-linux-media\.mts --run/u,
  );
  assert.match(
    block,
    /if: \$\{\{ always\(\) && steps\.media_preparation\.outcome != 'skipped' \}\}[\s\S]*desktop-linux-media\.mts --cleanup/u,
  );
  assert.ok(
    block.indexOf("desktop-linux-namespace-preflight.mts") <
      block.indexOf("desktop-linux-media.mts --prepare"),
  );
  assert.match(block, /desktop-linux-namespace-profile\.mts --prepare/u);
  assert.match(
    block,
    /PORTCOVE_NAMESPACE_ORIGINAL_NODE.*desktop-linux-namespace-profile\.mts --cleanup/u,
  );
  assert.match(block, /!\*\*\/private-authority/u);
  assert.match(block, /!\*\*\/auth\.cookie/u);
});

void test("Windows updater rehearsal adopts manifest-pinned prebuilt tools before Desktop bootstrap", async () => {
  const rehearsal = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  const owner = workflowJob("packages", rehearsal);
  assert.ok(Array.isArray(owner.steps));
  const steps: unknown[] = owner.steps;
  const readerIndex = steps.findIndex(
    (step) => isRecord(step) && step.name === "Read pinned Windows quality-tool versions",
  );
  assert.ok(readerIndex >= 0, "Windows bootstrap must receive the existing prebuilt tool pins");
  const reader = steps[readerIndex],
    prebuilt = steps[readerIndex + 1],
    bootstrap = steps[readerIndex + 2];
  for (const step of [reader, prebuilt, bootstrap]) {
    assert.ok(isRecord(step));
    assert.equal(step.if, "runner.os == 'Windows'");
  }
  assert.ok(
    isRecord(reader) && isRecord(prebuilt) && isRecord(prebuilt.with) && isRecord(bootstrap),
  );
  assert.equal(reader.id, "windows-quality-pins");
  assert.equal(reader.shell, "pwsh");
  assert.equal(reader.run, "node scripts/quality-tools.mts --github-output >> $env:GITHUB_OUTPUT");
  assert.equal(prebuilt.uses, "taiki-e/install-action@1e29709c0ec63babbe8f266397a465f29a825f91");
  assert.equal(prebuilt.with.tool, "${{ steps.windows-quality-pins.outputs.required_prebuilt }}");
  assert.equal(prebuilt.with.checksum, undefined);
  assert.equal(prebuilt.with.fallback, undefined);
  assert.doesNotMatch(String(prebuilt.with.tool), /^(?:just|cargo-)/u);
  assert.equal(
    bootstrap.name,
    "Install pinned Windows native driver for installed NSIS renderer qualification",
  );
  assert.equal(bootstrap.run, "./scripts/bootstrap-quality-tools.ps1 -Desktop");
});

void test("EdgeDriver trust proof is manual, isolated, and does not launch the application", () => {
  const job = workflowJobSource(nativeDesignCompatibilityWorkflow, "edge_driver_proof");
  assert.ok(job);
  assert.match(
    job,
    /if: \$\{\{ inputs\.operation == 'compatibility' && inputs\.edge_driver_proof \}\}/u,
  );
  assert.match(job, /runs-on: windows-2022/u);
  assert.match(job, /persist-credentials: false/u);
  assert.doesNotMatch(
    job,
    /upload-artifact|actions\/cache|cache:|cargo|bootstrap-quality-tools\.ps1 -Desktop|desktop-verify/u,
  );
  assert.match(job, /Test-VerifiedEdgeDriver \$downloaded \$version/u);
  assert.match(job, /Test-VerifiedEdgeDriver \$cached \$version/u);
  assert.match(job, /Test-VerifiedEdgeDriver \$cached '0\.0\.0\.0'/u);
  assert.match(job, /https:\/\/msedgedriver\.microsoft\.com/u);
  assert.match(job, /bootstrap_sha256/u);
  assert.match(job, /driver_sha256/u);
  assert.match(
    nativeDesignCompatibilityWorkflow,
    /if: \$\{\{ inputs\.operation == 'compatibility' && !inputs\.edge_driver_proof && inputs\.runner != 'windows-2022' \}\}/u,
  );
});

void test("ordinary AppImage observations use restored source and default production configuration", async () => {
  const workflow = await readWorkflow(
    new URL("../.github/workflows/updater-artifact-rehearsal.yml", import.meta.url),
  );
  const owner = workflowJob("packages", workflow);
  assert.ok(Array.isArray(owner.steps));
  const step: unknown = owner.steps.find(
    (candidate: unknown) =>
      isRecord(candidate) &&
      candidate.name === "Prove ordinary default-feature AppImage startup and IPC",
  );
  assert.ok(isRecord(step) && typeof step.run === "string");
  assert.equal(step.if, "runner.os == 'Linux'");
  const ordinary = step.run;
  assert.match(
    ordinary,
    /git diff --exit-code HEAD -- Cargo\.toml Cargo\.lock apps\/desktop\/package\.json apps\/desktop\/src-tauri\/tauri\.conf\.json/u,
  );
  assert.match(
    ordinary,
    /node scripts\/run-rust-tests\.mts --guard-command pnpm --dir apps\/desktop tauri build --bundles appimage --ci/u,
  );
  assert.doesNotMatch(ordinary, /--features|--config|native-linux-packaged-webview-boundary/u);
  for (const variable of [
    "TAURI_CONFIG",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_SIGNING_PRIVATE_KEY_PATH",
    "APPIMAGE_EXTRACT_AND_RUN",
  ]) {
    assert.ok(ordinary.includes(`test -z "\${${variable}:-}"`));
  }
  assert.match(ordinary, /--app "\$ordinary\/Portcove\.AppImage"/u);
  assert.match(ordinary, /--scenario native-error-recovery/u);
  for (const artifact of [
    "Portcove.AppImage",
    "artifact.sha256",
    "native/*.json",
    "native/*.png",
    "native/*.log",
  ]) {
    assert.ok(workflow.includes(`work/updater-rehearsal/ordinary-appimage/${artifact}`));
  }
});

void test("Linux package ownership rehearsal is focused and preserves managed executables", async () => {
  const rehearsal = await readWorkflow(
    new URL("../.github/workflows/linux-package-ownership-rehearsal.yml", import.meta.url),
  );
  const qualification = await readFile(
    new URL("./test-linux-package-ownership.sh", import.meta.url),
    "utf8",
  );

  assert.match(rehearsal, /^on:\r?\n {2}pull_request:\r?\n {4}paths:/m);
  const settings: unknown = parseDocument(rehearsal).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.on));
  assert.ok(Object.hasOwn(settings.on, "workflow_dispatch"));
  for (const governedPath of [
    "apps/desktop/src-tauri/src/application_update_linux.rs",
    "apps/desktop/src-tauri/src/application_update_recovery.rs",
    "apps/desktop/src-tauri/tauri.conf.json",
    "scripts/test-linux-package-ownership.sh",
  ]) {
    assert.ok(rehearsal.includes(`- ${governedPath}`));
  }
  assert.match(rehearsal, /runs-on: ubuntu-22\.04/);
  assert.match(rehearsal, /container: fedora:44/);
  assert.match(
    rehearsal,
    /PORTCOVE_SOURCE_COMMIT: \$\{\{ github\.event\.pull_request\.head\.sha \|\| github\.sha \}\}/,
  );
  assert.equal(rehearsal.match(/ref: \$\{\{ env\.PORTCOVE_SOURCE_COMMIT \}\}/g)?.length, 3);
  assert.match(rehearsal, /pnpm tauri build --bundles deb,rpm --ci/);
  assert.match(rehearsal, /pnpm\/setup@[a-f0-9]{40}/);
  const setupSteps = Object.values(workflowJobs(rehearsal))
    .flatMap((job): unknown[] => (Array.isArray(job.steps) ? job.steps : []))
    .filter(
      (step) =>
        isRecord(step) && typeof step.uses === "string" && step.uses.startsWith("pnpm/setup@"),
    );
  assert.ok(setupSteps.length);
  for (const step of setupSteps) {
    assert.ok(isRecord(step) && isRecord(step.with));
    assert.equal(step.with.install, false);
    assert.equal(step.with["node-version-file"], ".node-version");
    assert.equal(step.with.cache, true);
  }
  assert.doesNotMatch(rehearsal, /pnpm\/action-setup|actions\/setup-node/);
  assert.match(rehearsal, /Verify pinned frontend runtime and store[\s\S]*pnpm store path/);
  assert.match(rehearsal, /pnpm install --frozen-lockfile/);
  assert.match(rehearsal, /actions\/download-artifact@/);
  assert.match(rehearsal, /test-linux-package-ownership\.sh deb/);
  assert.match(rehearsal, /test-linux-package-ownership\.sh rpm/);
  assert.match(rehearsal, /dnf --assumeyes install findutils git nodejs rpm/);
  assert.match(
    rehearsal,
    /Install Fedora qualification tools[\s\S]*actions\/checkout@[\s\S]*Verify installed RPM ownership guidance/,
  );
  assert.doesNotMatch(rehearsal, /appimage|desktop-test|e2e/iu);
  assert.match(rehearsal, /\.\/scripts\/test-linux-package-ownership\.sh/);
  assert.match(rehearsal, /retention-days: 1/);

  assert.match(qualification, /env -u APPIMAGE -u APPDIR -u DISPLAY/);
  assert.match(qualification, /--application-update-recovery eligibility/);
  assert.match(qualification, /dpkg-query --search/);
  assert.match(qualification, /rpm --query --queryformat .* --file/);
  assert.match(qualification, /dnf --assumeyes --setopt=install_weak_deps=False install/);
  assert.match(qualification, /\$format-owners\.txt/);
  assert.match(qualification, /hash_before.*hash_after/s);
  assert.match(
    qualification,
    /git -c safe\.directory="\$repo_root" -C "\$repo_root" rev-parse HEAD/,
  );
  assert.doesNotMatch(qualification, /safe\.directory=(?:"?\*)/);
  assert.match(qualification, /checkout_commit.*PORTCOVE_SOURCE_COMMIT/s);
  assert.match(qualification, /package_managed_files_unchanged: true/);
});

void test("validation recipes separate routine, release, and packaged Windows contracts", async () => {
  const recipes = await readFile(new URL("../justfile", import.meta.url), "utf8");
  const routine = recipes.match(/^check: (.+)$/m)?.[1] ?? "";
  assert.match(
    routine,
    /check-rust check-ui script-lint repository-tools roadmap-check development-tools/,
  );
  assert.doesNotMatch(routine, /release-check|windows-qualification/);
  const release = recipes.match(/^release-check:\r?\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  assert.match(release, /check-release-metadata\.test\.mts/);
  assert.match(release, /release-package-policy\.test\.mts/);
  assert.match(release, /updater-artifact-inventory\.test\.mts/);
  assert.match(release, /reconstruct-application-update-records\.test\.mts/);
  assert.match(release, /windows-qualification-session\.test\.mts/);
  assert.doesNotMatch(release, /windows-qualification-session\.integration\.test\.mts/);
  for (const generic of [
    "ci-workflow.test.mts",
    "ci-health.test.mts",
    "test-duration-reporter.test.mts",
    "quality-tools.test.mts",
    "repository-settings.test.mts",
    "pr-conventions.test.mts",
    "dev-storage.test.mts",
  ])
    assert.doesNotMatch(release, new RegExp(generic.replaceAll(".", "\\.")));
  const windows = recipes.match(/^windows-qualification-check:\r?\n([\s\S]*?)(?=^\S)/m)?.[1] ?? "";
  assert.match(windows, /process\.platform !== 'win32'/);
  assert.match(windows, /run-windows-qualification\.ps1/);
  assert.match(catalog, /check-release-metadata\.test\.mts/);
  assert.match(catalog, /release-package-policy\.test\.mts/);
  assert.match(windowsStorage, /run-windows-qualification\.ps1/);
  const ui = recipes.match(/^check-ui: (.+)$/m)?.[1] ?? "";
  assert.equal(ui, "ui-check ui-lint-contracts");
  const auditUi = recipes.match(/^ui-check: (.+)$/m)?.[1] ?? "";
  assert.doesNotMatch(auditUi, /fmt-frontend-check/);
  const recipeBody = (name: string) =>
    recipes.match(new RegExp(`^${name}:\\r?\\n([\\s\\S]*?)(?=^\\S)`, "m"))?.[1] ?? "";
  for (const scan of [
    "fmt-frontend-check",
    "oxlint",
    "stylelint",
    "python-lint",
    "shell-lint",
    "actions-lint",
    "powershell-lint",
  ])
    assert.doesNotMatch(recipeBody(scan), /lint-tools\.integration\.mts/);
  assert.match(
    recipeBody("ui-lint-contracts"),
    /lint-tools\.integration\.mts oxfmt oxlint stylelint/,
  );
  assert.match(
    recipeBody("script-lint-contracts"),
    /lint-tools\.integration\.mts ruff shellcheck actionlint psscriptanalyzer/,
  );
  assert.match(
    recipes.match(/^script-lint: (.+)$/m)?.[1] ?? "",
    /python-lint shell-lint actions-lint powershell-lint script-lint-contracts/,
  );
});

void test("release and deep preflights require a fresh audit", async () => {
  const release = await readWorkflow(new URL("../.github/workflows/release.yml", import.meta.url));
  const deep = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  const localPreflight = await readFile(
    new URL("./release-preflight.ps1", import.meta.url),
    "utf8",
  );
  assert.match(release, /just audit --fresh/);
  assert.match(release, /id: aqua-version/);
  assert.match(release, /aquaproj\/aqua-installer@611554c6f0137ba41c8dd15aca8bee82504ea461/);
  assert.match(release, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(release, /enable_aqua_install: "false"/);
  assert.match(deep, /just audit --fresh/);
  assert.match(deep, /id: aqua-version/);
  assert.match(deep, /aquaproj\/aqua-installer@611554c6f0137ba41c8dd15aca8bee82504ea461/);
  assert.match(deep, /aqua_version: \$\{\{ steps\.aqua-version\.outputs\.version \}\}/);
  assert.match(deep, /enable_aqua_install: "false"/);
  assert.match(localPreflight, /just audit --fresh/);
});

void test("manual deep workflow preserves fresh default with explicit bounded audit reuse", async () => {
  const deep = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  assert.match(deep, /^name: Deep audit$/m);
  assert.match(deep, /^ {2}audit:\r?$/m);
  assert.match(deep, /just audit --fresh/);
  const settings: unknown = parseDocument(deep).toJS();
  assert.ok(
    isRecord(settings) &&
      isRecord(settings.on) &&
      isRecord(settings.on.workflow_dispatch) &&
      isRecord(settings.on.workflow_dispatch.inputs),
  );
  const operation = settings.on.workflow_dispatch.inputs.operation;
  assert.ok(isRecord(operation));
  assert.equal(operation.default, "audit");
  assert.deepEqual(operation.options, ["audit", "audit-reuse", "local-check", "fallow"]);
  assert.doesNotMatch(deep, /GH_TOKEN: \$\{\{ github.token \}\}/);
  assert.match(deep, /if: always\(\) && inputs.operation != 'audit-reuse'/);
  assert.doesNotMatch(deep, /actions: read|actions: write|contents: write/);
  assert.doesNotMatch(deep, /^ {2}(?:hawk|duplicates):/m);
  assert.doesNotMatch(deep, /semdup|cargo-hawk|run-hawk|run-semdup|dead-public/i);
});

void test("live upstream health has bounded independent triggers while catalog stays offline", async () => {
  assert.doesNotMatch(catalog, /check-catalog-repositories\.mts/);
  assert.match(catalog, /check-retcomm-upstreams\.mts --offline/);
  const health = await readWorkflow(
    new URL("../.github/workflows/upstream-health.yml", import.meta.url),
  );
  assert.match(health, /schedule:\r?\n {4}- cron:/);
  assert.match(health, /workflow_dispatch:/);
  assert.match(health, /timeout-minutes: 10/);
  assert.match(health, /^permissions:\r?\n {2}contents: read$/m);
  assert.doesNotMatch(health, /pull_request_target|continue-on-error/);
  const settings: unknown = parseDocument(health).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.on));
  for (const trigger of ["pull_request", "push"]) {
    const section = settings.on[trigger];
    assert.ok(isRecord(section) && Array.isArray(section.paths));
    for (const path of [
      "crates/portcove-core/catalog/**",
      "scripts/retcomm-psx-upstreams.json",
      "scripts/check-catalog-repositories.mts",
      "scripts/check-retcomm-upstreams.mts",
      "scripts/upstream-health-plan.mts",
      "scripts/upstream-health-inputs.mts",
      "scripts/upstream-health-monitor.mts",
      "scripts/upstream-health-*.test.mts",
      "scripts/upstream-lineage.mts",
      "scripts/observe-configured-upstream.mts",
      "scripts/release-path-safety.mts",
      "scripts/runtime-values.mts",
      "scripts/json-values.mts",
      "scripts/select-ci-plan.mts",
      ".github/upstream-health-accounting.json",
      ".node-version",
      ".github/workflows/upstream-health.yml",
    ]) {
      assert.ok(section.paths.includes(path), `${trigger} must cover ${path}`);
    }
  }
  assert.match(health, /run: node scripts\/upstream-health-plan\.mts/);
  assert.match(health, /PR_BASE_SHA: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(health, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(health, /fetch-depth: 0/);
  assert.match(health, /run: node scripts\/upstream-health-monitor\.mts/);
  assert.match(health, /HEALTH_MODE: \$\{\{ steps\.scope\.outputs\.mode \}\}/);
  assert.match(health, /HEALTH_PORT_IDS: \$\{\{ steps\.scope\.outputs\.port_ids \}\}/);
  assert.match(health, /!cancelled\(\) && steps\.monitor\.outputs\.retcomm == 'true'/);
  assert.match(
    health,
    /node scripts\/check-retcomm-upstreams\.mts --port-ids="\$RETCOMM_PORT_IDS"/,
  );
  assert.match(health, /RETCOMM_PORT_IDS: \$\{\{ steps\.monitor\.outputs\.retcomm_port_ids \}\}/);
  const document = parseDocument(health, { uniqueKeys: true });
  assert.deepEqual(document.errors, []);
  const parsed: unknown = document.toJS();
  assert.ok(isRecord(parsed) && isRecord(parsed.jobs));
  const job = parsed.jobs["upstream-health"];
  assert.ok(isRecord(job) && Array.isArray(job.steps));
  const steps: unknown[] = job.steps;
  const monitor = steps.find((entry) => isRecord(entry) && entry.id === "monitor");
  assert.ok(isRecord(monitor));
  assert.equal(monitor.if, "${{ !cancelled() }}");
  const step = (name: string) => {
    const entry: unknown = steps.find((value) => isRecord(value) && value.name === name);
    assert.ok(isRecord(entry) && isRecord(entry.with), `Missing workflow step: ${name}`);
    return { uses: entry.uses, if: entry.if, with: entry.with };
  };
  const restore = step("Restore main observation history");
  const save = step("Preserve trusted main observation history");
  const upload = step("Retain monitoring report");
  assert.equal(restore.uses, "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
  assert.equal(save.uses, "actions/cache/save@55cc8345863c7cc4c66a329aec7e433d2d1c52a9");
  assert.equal(restore.with.path, "work/upstream-health/checkpoint.json");
  assert.equal(save.with.path, restore.with.path);
  assert.equal(restore.with["restore-keys"], "upstream-health-history-v1-main-");
  assert.equal(save.with.key, restore.with.key);
  assert.ok(typeof save.if === "string");
  assert.match(save.if, /!cancelled\(\)/);
  assert.match(save.if, /github\.repository == 'boburning\/portcove'/);
  assert.match(save.if, /github\.ref == 'refs\/heads\/main'/);
  assert.match(save.if, /github\.event_name != 'pull_request'/);
  assert.match(save.if, /steps\.monitor\.outputs\.checkpoint_updated == 'true'/);
  assert.equal(upload.if, "${{ !cancelled() }}");
  assert.ok(typeof upload.with.path === "string");
  assert.match(upload.with.path, /work\/upstream-health\/report\.json/);
  assert.match(upload.with.path, /work\/upstream-health\/summary\.md/);
  assert.doesNotMatch(upload.with.path, /checkpoint\.json/);
  assert.equal(upload.with["retention-days"], 7);
  const release = await readWorkflow(new URL("../.github/workflows/release.yml", import.meta.url));
  assert.match(release, /run: node scripts\/check-retcomm-upstreams\.mts\r?$/m);
});

void test("deep audit evidence retains audit status without privilege changes", async () => {
  const deep = await readWorkflow(
    new URL("../.github/workflows/deep-quality.yml", import.meta.url),
  );
  const auditJob = requiredFixture(
    requiredFixture(deep.split("  audit:")[1]).split(/\n  [a-z_]+:/u)[0],
  );
  assert.match(auditJob, /runs-on: ubuntu-22\.04/u);
  assert.match(auditJob, /^    timeout-minutes: 55$/m);
  const localJob = requiredFixture(
    requiredFixture(deep.split("  local_check:")[1]).split(/\n  [a-z_]+:/u)[0],
  );
  assert.match(localJob, /^    timeout-minutes: 30$/m);
  assert.match(auditJob, /shared-key: deep-quality-ubuntu-22\.04/u);
  assert.match(auditJob, /key: quality-rscheck-binaries-v2-ubuntu-22\.04-/u);
  assert.match(deep, /id: fresh-audit/);
  assert.match(
    deep,
    /if \[\[ "\$AUDIT_OPERATION" == "audit-reuse" \]\]; then\r?\n {12}just audit\r?\n {10}else\r?\n {12}just audit --fresh\r?\n {10}fi\r?\n {10}audit_status=\$\?/,
  );
  assert.match(deep, /exit "\$audit_status"/);
  assert.match(deep, /node scripts\/deep-audit-summary\.mts --start/);
  assert.match(deep, /node scripts\/deep-audit-summary\.mts --finish "\$audit_status"/);
  const summary = workflowStep("audit", "Summarize structured audit evidence", deep);
  assert.equal(summary.if, "always() && inputs.operation != 'audit-reuse'");
  assert.match(deep, /AUDIT_OUTCOME: \$\{\{ steps\.fresh-audit\.outcome \}\}/);
  assert.match(deep, /AUDIT_EXIT_CODE: \$\{\{ steps\.fresh-audit\.outputs\.exit_code \}\}/);
  assert.match(
    deep,
    /run: node scripts\/deep-audit-summary\.mts \|\| echo "Structured audit evidence unavailable"/,
  );
  assert.match(deep, /^permissions:\r?\n {2}contents: read$/m);
  assert.doesNotMatch(deep, /continue-on-error|secrets:|schedule:|tee /);
  assert.match(deep, /PORTCOVE_AUDIT_CAPTURE: "1"/);
  const exporter = workflowStep("audit", "Export attempt-bound audit evidence", deep);
  assert.equal(exporter.id, "audit-evidence");
  assert.equal(exporter.if, "always() && steps.fresh-audit.outputs.capture_available == 'true'");
  assert.match(deep, /node scripts\/audit-evidence.mts/);
  assert.match(deep, /if: always\(\) && steps.fresh-audit.outputs.capture_available == 'true'/);
  assert.match(deep, /if: always\(\) && steps.audit-evidence.outputs.available == 'true'/);
  assert.match(deep, /uses: actions\/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9/);
  assert.match(
    deep,
    /name: audit-evidence-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/,
  );
  assert.match(
    deep,
    /path: work\/audit-bundles\/\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}\//,
  );
  const audit = workflowJob("audit", deep);
  assert.ok(Array.isArray(audit.steps));
  const bundle: unknown = audit.steps.find(
    (step: unknown) =>
      isRecord(step) &&
      isRecord(step.with) &&
      step.with.name === "audit-evidence-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  assert.ok(isRecord(bundle) && isRecord(bundle.with));
  assert.equal(bundle.with["retention-days"], 7);
  assert.equal(bundle.with["compression-level"], 6);
  assert.equal(bundle.with["if-no-files-found"], "error");
});

void test("ordinary controller tool rebuilds cover Windows driver acquisition and parser policy", async () => {
  const workflow = await readWorkflow(
    new URL("../.github/workflows/controller-tool-build-fixture.yml", import.meta.url),
  );
  const settings: unknown = parseDocument(workflow).toJS();
  assert.ok(isRecord(settings) && isRecord(settings.on));
  for (const trigger of ["pull_request", "push"]) {
    const section = settings.on[trigger];
    assert.ok(isRecord(section) && Array.isArray(section.paths));
    for (const file of [
      "scripts/release-windows-webview-driver.mts",
      "scripts/release-windows-webview-driver.test.mts",
      "scripts/windows-webview-driver-policy.psm1",
      "scripts/bounded-zip.mts",
    ])
      assert.ok(section.paths.includes(file), `${trigger}/${file}`);
  }
});
