import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";

// Evidence binding only; this does not authorize signing, installation or publication.
export async function verifyNormalPackageEvidence(file, revision, executable, root) {
  assert.ok(file && path.isAbsolute(file), "Normal package evidence requires an absolute path");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  assert.equal(manifest.revision, revision, "Package source must match the current candidate");
  assert.deepEqual(manifest.build_command, [
    "corepack",
    "pnpm",
    "tauri",
    "build",
    "--bundles",
    "nsis",
  ]);
  assert.deepEqual(manifest.qualification_features, []);
  const identities = [await fileIdentity(file)];
  for (const binding of [
    manifest.installer,
    manifest.installer_evidence,
    ...manifest.configuration,
  ]) {
    assert.ok(path.isAbsolute(binding.path));
    const identity = await fileIdentity(binding.path);
    assert.equal(identity.sha256, binding.sha256, "Package evidence input changed");
    identities.push(identity);
  }
  assert.deepEqual(
    manifest.configuration.map((binding) => path.resolve(binding.path)),
    [
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      path.join(root, "apps/desktop/src-tauri/tauri.windows.conf.json"),
      path.join(root, "apps/desktop/src-tauri/Cargo.toml"),
    ],
  );
  const receipt = JSON.parse(await readFile(manifest.installer_evidence.path, "utf8"));
  assert.equal(receipt.details.installer_sha256, manifest.installer.sha256);
  assert.equal(receipt.details.installed_executable_sha256, executable.sha256);
  const context = manifest.execution_context ?? "retained-installed-bytes";
  assert.ok(
    ["retained-installed-bytes", "current-installed"].includes(context),
    "Unknown normal package execution context",
  );
  if (context === "current-installed") {
    assert.equal(receipt.phase, "current_installed_boundary_ready");
    assert.equal(receipt.details.uninstall_registration_count, 1);
    assert.match(
      receipt.details.registration_path,
      /HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\/i,
    );
    assert.equal(path.resolve(receipt.details.installed_executable_path), executable.path);
    assert.equal(
      path.dirname(executable.path),
      path.resolve(receipt.details.install_root),
      "Native executable must remain in the verified installation",
    );
    const installed = await fileIdentity(executable.path);
    assert.equal(installed.sha256, executable.sha256);
    identities.push(installed);
    assert.equal(receipt.details.application_responding, true);
    assert.equal(receipt.details.application_exit_code, 0);
    assert.equal(receipt.details.persistent_data_preserved, true);
    return { manifest, receipt, identities, execution_context: context };
  }
  assert.equal(receipt.phase, "complete");
  for (const field of [
    "application_responding",
    "persistent_data_preserved",
    "managed_files_removed",
    "registration_removed",
  ])
    assert.equal(receipt.details[field], true, field);
  assert.equal(receipt.details.application_exit_code, 0);
  return { manifest, receipt, identities, execution_context: context };
}

export async function normalPackageBoundaryScenario({
  browser,
  invoke,
  library,
  output,
  artifacts,
  packageEvidence,
}) {
  const observations = { package: packageEvidence };
  const requests = [];
  const marker = `__untrustedBoundary_${randomUUID().replaceAll("-", "")}`;
  const beacon = `/untrusted/executed-${marker}`;
  let phase = "main-controls";
  observations.navigationPhases = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      user_agent: request.headers["user-agent"] ?? null,
      observed_at: new Date().toISOString(),
      phase,
    });
    response.setHeader("Content-Type", "text/html");
    response.end(
      `<!doctype html><title>Owned untrusted origin</title><script>window[${JSON.stringify(marker)}] = true; new Image().src = ${JSON.stringify(beacon)}</script>`,
    );
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const initialUrl = await browser.getCurrentUrl();
    assert.equal(new URL(initialUrl).origin, "http://tauri.localhost");
    await browser.manage().setTimeouts({ script: 10_000, pageLoad: 10_000 });
    await assertMainWebviewAccess({ browser, invoke, library, observations });
    await assertReviewedLinkRefusals({ browser, invoke, library, observations });
    observations.qualificationCommands = {};
    for (const command of [
      "create_boundary_windows",
      "queue_boundary_reply",
      "recreate_boundary_owner",
    ]) {
      const result = await invoke(command);
      observations.qualificationCommands[command] = result;
      assert.equal(result.ok, false);
      assert.match(result.error, /command .* not found/i);
    }
    observations.assets = await browser.executeScript(() =>
      [...document.scripts].filter((script) => script.src).map((script) => script.src),
    );
    assert.ok(observations.assets.length > 0);
    assert.ok(
      observations.assets.every((source) => new URL(source).origin === new URL(initialUrl).origin),
    );
    const fixtureUrl = `http://127.0.0.1:${server.address().port}/untrusted`;
    await assertMainWebviewContainment({
      browser,
      invoke,
      library,
      observations,
      initialUrl,
      fixtureUrl,
      onNavigation: (destination) => {
        phase = destination === fixtureUrl ? "navigation-http" : "navigation-alias";
        observations.navigationPhases.push({ destination, started_at: new Date().toISOString() });
      },
    });
    phase = "returned-main";
    observations.returnedMain = await invoke("get_bootstrap_status");
    assert.equal(observations.returnedMain.ok, true);
    assert.equal(path.resolve(observations.returnedMain.value.library_root), library);
    observations.remoteMarkerExecuted = await browser.executeScript(
      (name) => window[name] === true,
      marker,
    );
    assert.equal(observations.remoteMarkerExecuted, false);
    const diagnostics = (
      await readFile(path.join(library, "logs", "portcove-desktop.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    observations.nativePermissionDenials = diagnostics.filter(
      (entry) => entry.fields.operation_id === "webview-permission",
    );
    assert.ok(
      observations.nativePermissionDenials.length > 0,
      "Actual native permission denial is required",
    );
    // WebView2 NavigationStarting cancellation preserves the page but explicitly
    // permits a speculative GET while the host responds. Do not claim network silence.
  } finally {
    observations.fixtureCloseStartedAt = new Date().toISOString();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    observations.fixtureClosedAt = new Date().toISOString();
    observations.fixtureRequests = requests;
    observations.remoteExecutionBeacon = {
      path: beacon,
      requests: requests.filter((request) => request.path === beacon),
    };
    const report = path.join(output, "normal-package-boundary.json");
    await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
    artifacts.push(report);
  }
  return requests;
}

export function assertOwnedBoundaryRequests(requests) {
  for (const request of requests) {
    assert.equal(request.method, "GET", "Unexpected fixture request method");
    assert.equal(
      request.path,
      "/untrusted",
      "Popup or remote execution beacon must receive no request",
    );
    assert.equal(
      request.phase,
      "navigation-http",
      "Fixture requests must belong to attempted HTTP navigation",
    );
  }
}

async function assertReviewedLinkRefusals({ browser, invoke, library, observations }) {
  observations.reviewedLinkRefusals = [];
  const context = async () => {
    const bootstrap = await invoke("get_bootstrap_status");
    assert.equal(bootstrap.ok, true);
    assert.equal(bootstrap.value.ready, true, "Link refusal requires a ready library");
    assert.equal(bootstrap.value.error, null);
    assert.equal(path.resolve(bootstrap.value.library_root), path.resolve(library));
    assert.ok(Number.isSafeInteger(bootstrap.value.generation) && bootstrap.value.generation > 0);
    assert.equal(path.resolve(bootstrap.value.selection.root), path.resolve(library));
    const identity = await invoke("get_library_identity", {
      generation: bootstrap.value.generation,
    });
    assert.equal(identity.ok, true, "Library identity must remain available");
    assert.ok(typeof identity.value?.id === "string" && identity.value.id.length > 0);
    assert.equal(path.resolve(identity.value.root), path.resolve(library));
    return {
      bootstrap: bootstrap.value,
      identity: identity.value,
      url: await browser.getCurrentUrl(),
    };
  };
  for (const request of [
    {
      command: "open_external_url",
      args: { url: "https://unreviewed.portcove.invalid/boundary" },
      expected: {
        code: "usage",
        message: "only reviewed project, artwork source and GitHub sign-in links may be opened",
      },
    },
    {
      command: "open_source_evidence",
      args: { evidenceId: "portcove-boundary-unknown-evidence" },
      expected: {
        code: "not_found",
        message: "unknown source evidence id: portcove-boundary-unknown-evidence",
      },
    },
  ]) {
    const record = { ...request };
    observations.reviewedLinkRefusals.push(record);
    record.before = await context();
    assert.equal(new URL(record.before.url).origin, "http://tauri.localhost");
    record.result = await invoke(request.command, request.args);
    assert.equal(record.result.ok, false, "Unreviewed link must be refused");
    assert.equal(record.result.error?.code, request.expected.code, "Require the actual link guard");
    assert.equal(record.result.error?.message, request.expected.message);
    record.after = await context();
    assert.deepEqual(record.after, record.before, "Refusal must preserve main and library context");
  }
}

export async function assertMainWebviewAccess({ browser, invoke, library, observations }) {
  observations.permissionPolicy = await browser.executeScript(() => {
    const policy = document.permissionsPolicy ?? document.featurePolicy;
    return {
      secureContext: window.isSecureContext,
      features: Object.fromEntries(
        ["camera", "microphone", "geolocation"].map((name) => [
          name,
          policy?.allowsFeature(name) ?? null,
        ]),
      ),
    };
  });
  observations.permissionStates = await browser.executeAsyncScript((done) => {
    Promise.all(
      ["camera", "microphone", "geolocation", "notifications"].map(async (name) => {
        try {
          return [name, (await navigator.permissions.query({ name })).state];
        } catch {
          return [name, "unsupported"];
        }
      }),
    ).then((entries) => done(Object.fromEntries(entries)));
  });
  const positive = await invoke("get_bootstrap_status");
  observations.main = positive;
  assert.equal(positive.ok, true);
  observations.mainMutation = await invoke("set_locale_preference", {
    locale: "en",
  });
  assert.equal(observations.mainMutation.ok, true);
  assert.equal(path.resolve(positive.value.library_root), path.resolve(library));
}

export async function assertMainWebviewContainment({
  browser,
  invoke,
  library,
  observations,
  fixtureUrl,
  initialUrl,
  onNavigation = () => {},
}) {
  observations.preservedLocale = await invoke("get_locale_preference");
  assert.equal(observations.preservedLocale.value.locale, "en");
  observations.popup = await browser.executeAsyncScript((url, done) => {
    const popup = window.open(`${url}/popup`, "_blank");
    if (!popup) {
      done({ refused: true, result: "null" });
      return;
    }
    const deadline = Date.now() + 5000;
    const timer = setInterval(() => {
      if (popup.closed || Date.now() >= deadline) {
        clearInterval(timer);
        done({ refused: popup.closed, result: "window-proxy" });
      }
    }, 100);
  }, fixtureUrl);
  assert.equal(observations.popup.refused, true);
  observations.cspInline = await browser.executeAsyncScript((done) => {
    const handler = (event) => {
      if (event.violatedDirective.startsWith("script-src")) {
        document.removeEventListener("securitypolicyviolation", handler);
        done({
          directive: event.violatedDirective,
          blockedUri: event.blockedURI,
          executed: window.__boundaryInline === true,
        });
      }
    };
    document.addEventListener("securitypolicyviolation", handler);
    const script = document.createElement("script");
    script.textContent = "window.__boundaryInline = true";
    document.body.append(script);
  });
  assert.equal(observations.cspInline.executed, false);
  assert.equal(observations.cspInline.blockedUri, "inline");
  observations.permissionRequests = await browser.executeAsyncScript((done) => {
    Promise.all([
      Notification.requestPermission().then((value) => ["notifications", value]),
      new Promise((resolve) =>
        navigator.geolocation.getCurrentPosition(
          () => resolve(["geolocation", "unexpected-grant"]),
          (error) => resolve(["geolocation", { code: error.code }]),
          { timeout: 5000 },
        ),
      ),
      navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then(
        (stream) => {
          stream.getTracks().forEach((track) => track.stop());
          return ["media", "unexpected-grant"];
        },
        (error) => ["media", { name: error.name }],
      ),
    ]).then((entries) => done(Object.fromEntries(entries)));
  });
  assert.equal(observations.permissionRequests.notifications, "denied");
  assert.equal(observations.permissionRequests.geolocation.code, 1);
  assert.equal(observations.permissionRequests.media.name, "NotAllowedError");
  const diagnosticPath = path.join(library, "logs", "portcove-desktop.jsonl");
  const navigationRefusals = async () =>
    (await readFile(diagnosticPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (entry) =>
          entry.fields.operation_id === "webview-navigation" &&
          entry.fields.webview_label === "main",
      );
  observations.navigationRefusals = [];
  const inactiveAlias = new URL(initialUrl);
  inactiveAlias.protocol = inactiveAlias.protocol === "http:" ? "https:" : "http:";
  for (const destination of [fixtureUrl, inactiveAlias.href]) {
    onNavigation(destination);
    const previous = (await navigationRefusals()).length;
    await browser.get(destination);
    const deadline = Date.now() + 10_000;
    while ((await navigationRefusals()).length <= previous) {
      if (Date.now() >= deadline)
        throw new Error("New navigation refusal was not observed by the native host");
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const currentUrl = await browser.getCurrentUrl();
    assert.equal(currentUrl, initialUrl);
    observations.navigationRefusals.push({
      attempted: destination,
      current: currentUrl,
      native: (await navigationRefusals()).at(-1),
    });
  }
  observations.mainNavigatedUrl = await browser.getCurrentUrl();
  assert.equal(observations.mainNavigatedUrl, initialUrl);
}
