import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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
  assert.equal(receipt.phase, "complete");
  assert.equal(receipt.details.installer_sha256, manifest.installer.sha256);
  assert.equal(receipt.details.installed_executable_sha256, executable.sha256);
  for (const field of [
    "application_responding",
    "persistent_data_preserved",
    "managed_files_removed",
    "registration_removed",
  ])
    assert.equal(receipt.details[field], true, field);
  assert.equal(receipt.details.application_exit_code, 0);
  return { manifest, receipt, identities };
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
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      user_agent: request.headers["user-agent"] ?? null,
      observed_at: new Date().toISOString(),
    });
    response.setHeader("Content-Type", "text/html");
    response.end(
      "<!doctype html><title>Owned untrusted origin</title><script>window.__untrustedBoundary = true</script>",
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
    await assertMainWebviewContainment({
      browser,
      invoke,
      library,
      observations,
      initialUrl,
      fixtureUrl: `http://127.0.0.1:${server.address().port}/untrusted`,
    });
    observations.returnedMain = await invoke("get_bootstrap_status");
    assert.equal(observations.returnedMain.ok, true);
    assert.equal(path.resolve(observations.returnedMain.value.library_root), library);
    observations.remoteMarkerExecuted = await browser.executeScript(
      () => window.__untrustedBoundary === true,
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
    assert.deepEqual(
      requests.filter((request) => request.path.endsWith("/popup")),
      [],
      "Refused popup must receive no fixture request",
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    observations.fixtureRequests = requests;
    const report = path.join(output, "normal-package-boundary.json");
    await writeFile(report, JSON.stringify(observations, null, 2), { flag: "wx" });
    artifacts.push(report);
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
