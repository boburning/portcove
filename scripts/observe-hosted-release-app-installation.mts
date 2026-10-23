/** Ordinary private setup only. Never loads a default token or reviewer cache. */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireOrdinaryHostedAppSetupSource } from "./register-hosted-release-app.mts";
import { createAppRegistrationStore } from "./release-app-registration-capture.mts";
import { readBoundedPublicBuildInputFile } from "./release-public-build-inputs.mts";
import { observeHostedAppInstallationScope } from "./release-hosted-app-installation.mts";
import type { HostedReleaseAppRole } from "./release-hosted-app-setup.mts";
import { isRecord } from "./runtime-values.mts";

async function privateFile(directory: string, name: string) {
  const filename = path.join(directory, name);
  if ((await realpath(filename)) !== filename) throw new Error("linked setup input refused");
  const stat = await lstat(filename);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    stat.size < 1 ||
    stat.size > 16384
  )
    throw new Error("private setup input identity differs");
  return readBoundedPublicBuildInputFile(directory, name, 16384);
}
const json = (bytes: Buffer): unknown => {
  if (!Buffer.from(bytes.toString("utf8")).equals(bytes))
    throw new Error("setup input text differs");
  return JSON.parse(bytes.toString("utf8")) as unknown;
};
async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--role" ||
    !["semantic", "protection_observer"].includes(args[1] ?? "") ||
    args[2] !== "--expected-source" ||
    args[4] !== "--registration-source" ||
    !/^[a-f0-9]{40}$/u.test(args[5] ?? "")
  )
    throw new Error(
      "fixed role, reviewed observation source and retained registration source required",
    );
  requireOrdinaryHostedAppSetupSource(args[3]!);
  const role = args[1] as HostedReleaseAppRole;
  const directory = `/home/boburning/.local/share/portcove/app-registration/${role}`;
  // Validates canonical owner/non-writable ancestry. Refuses an existing attempt;
  // no private record is overwritten and no mint can be repeated by this CLI.
  const store = await createAppRegistrationStore(path.join(directory, "installation-observation"));
  const session = json(await privateFile(directory, "session.json"));
  const terminal = json(await privateFile(directory, "terminal.json"));
  const captured = json(await privateFile(directory, "result.json"));
  if (
    !isRecord(session) ||
    session.role !== role ||
    session.source_revision !== args[5] ||
    !isRecord(terminal) ||
    terminal.completed !== true ||
    !isRecord(captured) ||
    captured.role !== role ||
    typeof captured.app_id !== "number" ||
    typeof captured.public_key_sha256 !== "string"
  )
    throw new Error("retained complete registration identity required");
  const key = await privateFile(directory, "app.pem");
  try {
    await store.write(
      "source.json",
      Buffer.from(
        JSON.stringify({
          source_revision: args[3],
          registration_source: args[5],
          role,
          app_id: captured.app_id,
          public_key_sha256: captured.public_key_sha256,
          automatic_retry: false,
        }),
      ),
    );
    const result = await observeHostedAppInstallationScope(
      role,
      key,
      { app_id: captured.app_id, public_key_sha256: captured.public_key_sha256 },
      store,
    );
    process.stdout.write(
      `${JSON.stringify({ ...result, source_revision: args[3], registration_source: args[5] })}\n`,
    );
  } finally {
    key.fill(0);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1;
    process.stderr.write(
      "Installation observation stopped. Preserve the exact private attempt; no automatic retry.\n",
    );
  });
}
