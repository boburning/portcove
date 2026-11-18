import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
const file = process.argv[2];
const config = JSON.parse(await readFile(file, "utf8"));
const { acquireNativeSessionLock } = await import(config.sdk + "scripts/native-session-lock.mts");
const lease = await acquireNativeSessionLock({
  workspace: process.cwd(),
  profile: "freeorion-native-client-hosted",
  scenarios: config.scenarios,
});
try {
  await import("./freeorion-hosted-owner.mjs");
} finally {
  const dir = config.evidence_dir;
  const cleanup = JSON.parse(
    await readFile(path.join(dir, "cleanup.json"), "utf8").catch(() => "null"),
  );
  const expected = JSON.parse(
    await readFile(path.join(dir, "ui-attempts.json"), "utf8").catch(() => '{"prefixes":[]}'),
  ).prefixes;
  const proof = [];
  for (const name of await readdir(dir).catch(() => []))
    if (name.endsWith("-ui-cleanup.json"))
      proof.push(JSON.parse((await readFile(path.join(dir, name), "utf8")).replace(/^\uFEFF/, "")));
  const positive =
    cleanup?.positive_managed_command_exit === true &&
    proof.length === expected.length &&
    proof.every(
      (p) =>
        p.positive_exit === true &&
        p.input_released === true &&
        p.root_exited === true &&
        p.child_exited === true &&
        p.companions_quiescent === true,
    );
  if (positive) await lease.release();
  await writeFile(
    path.join(dir, "admission.json"),
    JSON.stringify(
      {
        released: positive,
        positive_owned_exit: positive,
        ui_observations: proof.length,
        scope: "hosted native claim; failed or missing process proof is retained",
      },
      null,
      2,
    ) + "\n",
  );
}
