import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { By, Key, until } from "selenium-webdriver";
import { fileIdentity } from "../../../scripts/development-evidence.mjs";

export const EXTERNAL_FIXTURE_ID = "portcove-external-runtime-fixture";

export function externalFixtureTreeDigest(files) {
  const digest = createHash("sha256").update("portcove-external-tree-v1\n");
  for (const [name, bytes] of [...files].sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  )) {
    assert.match(name, /^[a-z0-9_.-]+$/u);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    digest
      .update(name)
      .update(Buffer.from([0]))
      .update(size);
    digest.update(createHash("sha256").update(bytes).digest());
  }
  return digest.digest("hex");
}

export async function createExternalRuntimeFixture(output) {
  assert.ok(path.isAbsolute(output), "External fixture output must be absolute");
  const outputStat = await lstat(output);
  assert.ok(
    outputStat.isDirectory() && !outputStat.isSymbolicLink(),
    "External fixture needs a regular owned output directory",
  );
  const directory = path.join(output, "player-owned-runtime");
  await mkdir(directory);
  const immutable = new Map([
    ["game.exe", Buffer.from("Inert qualification bytes; never execute.\n")],
    ["unknown-save.bin", Buffer.from("Retained unknown player save.\n")],
  ]);
  for (const [name, bytes] of immutable)
    await writeFile(path.join(directory, name), bytes, { flag: "wx" });
  await writeFile(path.join(directory, "general.json"), "{}\n", { flag: "wx" });
  const port = {
    id: EXTERNAL_FIXTURE_ID,
    name: "Portcove External Runtime Fixture",
    summary: "Private inert prepared runtime for non-owning native qualification.",
    project_url: "https://example.invalid/portcove-external-runtime-fixture",
    support_tier: "beta",
    channels: ["stable"],
    platforms: ["windows-x86-64"],
    adapter: "n64-recomp-portable",
    release: {
      provider: "user-prepared",
      user_prepared: {
        "windows-x86-64": {
          version: "1.0.0-fixture",
          archive_name: "inert-fixture.zip",
          archive_size: 1,
          archive_sha256: "a".repeat(64),
          executable: "game.exe",
          immutable_tree_sha256: externalFixtureTreeDigest(immutable),
          mutable_paths: ["general.json"],
        },
      },
    },
    executable_hints: { "windows-x86-64": ["game.exe"] },
    persistent_paths: [],
  };
  const catalogPath = path.join(output, "external-runtime-qualification-catalog.json");
  await writeFile(
    catalogPath,
    JSON.stringify({
      schema_version: 2,
      source_catalog: { evidence: [], identities: [], contracts: [], validators: [] },
      ports: [port],
    }),
    { flag: "wx" },
  );
  const identities = await Promise.all(
    [...immutable.keys(), "general.json"].map((name) => fileIdentity(path.join(directory, name))),
  );
  return { directory, port, catalogPath, identities };
}

async function tracePickerInvocation({ browser, action, output, artifacts }) {
  await browser.executeScript(() => {
    const original = window.__TAURI_INTERNALS__.invoke;
    const trace = { original, calls: [] };
    trace.wrapper = async (...args) => {
      if (args[0] !== "plugin:dialog|open") return original(...args);
      const call = {
        directory: args[1]?.options?.directory === true,
        title_supplied: typeof args[1]?.options?.title === "string",
        status: "pending",
      };
      trace.calls.push(call);
      try {
        const result = await original(...args);
        call.status = result === null ? "cancelled" : "returned";
        return result;
      } catch (error) {
        call.status = "rejected";
        call.error = String(error);
        throw error;
      }
    };
    window.__portcoveExternalPickerTrace = trace;
    window.__TAURI_INTERNALS__.invoke = trace.wrapper;
  });
  try {
    return await action();
  } finally {
    const observation = await browser.executeScript(() => {
      const trace = window.__portcoveExternalPickerTrace;
      const unchanged = window.__TAURI_INTERNALS__.invoke === trace.wrapper;
      if (unchanged) window.__TAURI_INTERNALS__.invoke = trace.original;
      delete window.__portcoveExternalPickerTrace;
      return { calls: trace.calls, restored: unchanged };
    });
    const report = path.join(output, "external-runtime-picker-invocation.json");
    await writeFile(report, JSON.stringify(observation, null, 2), { flag: "wx" });
    artifacts.push(report);
    assert.equal(observation.restored, true);
  }
}

export async function externalRuntimePickerObservation({
  browser,
  fixture,
  observePicker,
  output,
  artifacts,
}) {
  await browser.findElement(By.xpath('//nav//button[contains(., "Port catalog")]')).click();
  const search = await browser.findElement(By.id("port-search"));
  await search.sendKeys(Key.chord(Key.CONTROL, "a"), Key.BACK_SPACE, fixture.port.name);
  const card = By.xpath(
    `//button[contains(@class,"port-card") and starts-with(@aria-label,"${fixture.port.name}.")]`,
  );
  await browser.wait(until.elementLocated(card), 15_000);
  await browser.findElement(card).click();
  const choose = By.xpath('//button[normalize-space(.)="Choose game folder"]');
  await browser.wait(until.elementLocated(choose), 15_000);
  const observation = await tracePickerInvocation({
    browser,
    output,
    artifacts,
    action: async () => {
      await browser.findElement(choose).click();
      return observePicker("external-runtime-picker-observation");
    },
  });
  assert.equal(observation.cancelled, true);
  for (const before of fixture.identities) {
    const after = await fileIdentity(before.path);
    assert.equal(after.bytes, before.bytes);
    assert.equal(after.sha256, before.sha256);
  }
  assert.equal(await browser.findElement(choose).isEnabled(), true);
  return observation;
}
