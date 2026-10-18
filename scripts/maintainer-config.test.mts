import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkIgdbCredentialsFile,
  readIgdbCredentials,
  resolveIgdbCredentialsFile,
  setIgdbCredentialsFile,
} from "./maintainer-config.mts";
import { createIgdbInspector } from "./inspect-igdb-artwork.mts";

void test("maintainer configuration saves only a validated path and explicit paths bypass bad config", () => {
  const root = mkdtempSync(path.join(tmpdir(), "maintainer-config-"));
  try {
    const config = path.join(root, "user", "maintainer.json");
    const credentials = path.join(root, "private.json");
    const secret = { client_id: "PRIVATE_ID_SENTINEL", client_secret: "PRIVATE_SECRET_SENTINEL" };
    writeFileSync(credentials, JSON.stringify(secret));
    assert.equal(resolveIgdbCredentialsFile(undefined, config), undefined);
    assert.deepEqual(checkIgdbCredentialsFile(config), {
      configured: false,
      available: false,
      valid: false,
      reason: "not-configured",
    });
    assert.deepEqual(setIgdbCredentialsFile(credentials, config), {
      configured: true,
      valid: true,
    });
    const before = readFileSync(config, "utf8");
    assert.deepEqual(JSON.parse(before), { format_version: 1, igdb_credentials_file: credentials });
    assert(!before.includes(secret.client_id));
    assert(!before.includes(secret.client_secret));
    assert.equal(resolveIgdbCredentialsFile(undefined, config), credentials);
    assert.deepEqual(checkIgdbCredentialsFile(config), {
      configured: true,
      available: true,
      valid: true,
    });
    assert.throws(() => setIgdbCredentialsFile(path.join(root, "absent"), config));
    assert.equal(readFileSync(config, "utf8"), before);
    assert.throws(() => setIgdbCredentialsFile("relative", config));
    writeFileSync(config, '{"format_version":99,"secret":"PRIVATE_SECRET_SENTINEL"}');
    const invalidBefore = readFileSync(config, "utf8");
    assert.equal(resolveIgdbCredentialsFile(credentials, config), credentials);
    assert.throws(
      () => resolveIgdbCredentialsFile(undefined, config),
      /configuration is unavailable or invalid/,
    );
    assert.throws(() => setIgdbCredentialsFile(credentials, config));
    assert.equal(readFileSync(config, "utf8"), invalidBefore);
    const redacted = JSON.stringify(checkIgdbCredentialsFile(config));
    assert(!redacted.includes(secret.client_secret));
    assert(!redacted.includes(credentials));
    for (const bytes of [
      "malformed",
      JSON.stringify({ client_id: secret.client_id }),
      "a".repeat(65537),
    ]) {
      writeFileSync(credentials, bytes);
      assert.throws(() => readIgdbCredentials(credentials), {
        message: "Private IGDB credentials are unavailable or invalid.",
      });
    }
    mkdirSync(path.join(root, "directory"));
    assert.throws(
      () => readIgdbCredentials(path.join(root, "directory")),
      /unavailable or invalid/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("inspector construction never reads missing credentials or contacts a provider", () => {
  let calls = 0;
  const inspector = createIgdbInspector(
    "missing-private-file",
    () => assert.fail("no image decode"),
    async () => {
      calls++;
      assert.fail("construction must not request network access");
    },
  );
  assert.equal(calls, 0);
  assert.equal(inspector.providerMetrics.authentication_requests, 0);
});

void test("actual CLI is redacted and provider resolves local config only at first authentication", () => {
  const root = mkdtempSync(path.join(tmpdir(), "maintainer-cli-"));
  try {
    const credentials = path.join(root, "private.json");
    writeFileSync(
      credentials,
      JSON.stringify({
        client_id: "PRIVATE_ID_SENTINEL",
        client_secret: "PRIVATE_SECRET_SENTINEL",
      }),
    );
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    const cli = fileURLToPath(new URL("./maintainer-config.mts", import.meta.url));
    for (const args of [["set-igdb-credentials-file", credentials], ["check"]]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        env,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
      assert(!result.stdout.includes(credentials));
      assert(!result.stdout.includes("SENTINEL"));
      assert.equal(result.stderr, "");
    }
    const script = `
      import assert from 'node:assert/strict';
      import {writeFileSync} from 'node:fs';
      import {createIgdbInspector} from ${JSON.stringify(new URL("./inspect-igdb-artwork.mts", import.meta.url).href)};
      import {maintainerConfigPath} from ${JSON.stringify(new URL("./maintainer-config.mts", import.meta.url).href)};
      let calls=0;
      const fetchMock=async(url)=>{calls++;return new Response(url.includes('oauth2')?'${JSON.stringify({ access_token: "fixture-token" })}':'[]')};
      const identity={names:['Port'],project_url:'https://example.org/port',evidence_url:'https://example.org/port'};
      const provider=createIgdbInspector(undefined,()=>{},fetchMock);
      assert.equal(calls,0);
      await provider.inspectGame(identity);
      writeFileSync(maintainerConfigPath(),'malformed PRIVATE_SECRET_SENTINEL');
      await provider.inspectGame(identity);
      assert.equal(provider.providerMetrics.authentication_requests,1);
      assert.equal(calls,3);
      const bad=createIgdbInspector(undefined,()=>{},fetchMock);
      assert.equal(calls,3);
      await assert.rejects(bad.inspectGame(identity),/configuration is unavailable or invalid/);
      const explicit=createIgdbInspector(${JSON.stringify(credentials)},()=>{},fetchMock);
      await explicit.inspectGame(identity);
      const invalid=createIgdbInspector(${JSON.stringify(path.join(root, "missing"))},()=>{},fetchMock);
      await assert.rejects(invalid.inspectGame(identity),/credentials are unavailable or invalid/);
      assert.equal(calls,5);
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    const checked = spawnSync(process.execPath, [cli, "check"], {
      env,
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(checked.status, 1);
    assert(!checked.stdout.includes("SENTINEL"));
    assert(!checked.stdout.includes(credentials));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
