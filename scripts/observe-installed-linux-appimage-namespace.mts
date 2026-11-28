import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import { launchLinuxNativeSession } from "../apps/desktop/scripts/desktop-linux-native-session.mts";

assert.equal(process.platform, "linux");
assert.equal(process.env.GITHUB_REPOSITORY, "boburning/portcove");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.env.FUSERMOUNT_PROG, "/usr/bin/fusermount3");

const inner = process.argv[2] === "inner";
const program = inner ? "/usr/bin/python3" : process.execPath;
const args = inner
  ? ["scripts/observe-installed-linux-appimage-mount.py"]
  : [fileURLToPath(import.meta.url), "inner"];
const child = await launchLinuxNativeSession(program, args, {
  ...process.env,
  PORTCOVE_APPIMAGE_MOUNT_SCOPE: "private",
});
child.child.stdout.pipe(process.stdout);
child.child.stderr.pipe(process.stderr);
let outcome: unknown;
try {
  await child.ready();
  const deadline = performance.now() + 50_000;
  while (performance.now() < deadline) {
    outcome = child.receipt.events.find((event) => event.kind === "driver-exited");
    if (outcome) break;
    await setTimeout(50);
  }
} finally {
  const joined = await child.stop();
  const leaf = inner ? "private-package-inner-join.json" : "private-package-outer-join.json";
  await writeFile(
    path.join("work/linux-installed-recovery", leaf),
    JSON.stringify({ joined, outcome }, null, 2) + "\n",
    { flag: "wx" },
  );
}
assert.deepEqual(
  outcome && typeof outcome === "object" && "code" in outcome && "signal" in outcome
    ? { code: outcome.code, signal: outcome.signal }
    : outcome,
  { code: 0, signal: null },
  "The package failed to mount through both maintained private namespaces",
);
