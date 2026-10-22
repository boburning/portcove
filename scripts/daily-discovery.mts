import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { withCheckpointLock } from "./observe-configured-upstream.mts";
import { assertOwnedUnlinkedPath } from "./release-path-safety.mts";
import { selectDiscoveryProfile, discoveryProfiles } from "./discovery-budget.mts";
import { errorCode, errorMessage } from "./runtime-values.mts";
import { readDiscoveryCache } from "./discovery-cache.mts";
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (args: string[]) =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  }).trim();
async function optional(file: string) {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch (e) {
    if (errorCode(e) === "ENOENT") return undefined;
    throw e;
  }
}
export async function dailyDiscoveryMain(args: string[]) {
  const command = args[0];
  if (
    !["plan", "run", "status"].includes(command ?? "") ||
    args.length > 3 ||
    (args.length > 1 && (args[1] !== "--state-dir" || !args[2]))
  )
    throw new Error(
      "usage: node scripts/daily-discovery.mts plan|run|status [--state-dir work/daily-discovery]",
    );
  const state = await assertOwnedUnlinkedPath(
    path.join(root, "work"),
    path.resolve(root, args[2] ?? "work/daily-discovery"),
    "daily discovery state",
  );
  if (command === "status") {
    console.log(
      JSON.stringify({
        receipt: await optional(path.join(state, "latest-receipt.json")),
        lock: await optional(path.join(state, "investigation.lock")),
        startup: await optional(path.join(state, "latest-startup.json")),
      }),
    );
    return;
  }
  if (command === "plan") {
    const profile = selectDiscoveryProfile(readDiscoveryCache(path.join(state, "inventory.json")));
    console.log(
      JSON.stringify({
        profile,
        limits: discoveryProfiles[profile],
        state,
        head: git(["rev-parse", "HEAD"]),
        lock: await optional(path.join(state, "investigation.lock")),
        journal_file: path.join(state, "active-run.json"),
        launch: { tty: true, login: false, keep_session_open_until: "explicit finish" },
      }),
    );
    return;
  }
  await mkdir(state, { recursive: true });
  const startedAt = new Date().toISOString();
  try {
    if (!process.stdin.isTTY)
      throw new Error(
        "Discovery run requires persistent interactive stdin; use exec_command tty:true and keep its session open through explicit finish",
      );
    await withCheckpointLock(path.join(state, "investigation"), async () => {
      if (git(["status", "--porcelain=v1"]))
        throw new Error("Dedicated metadata checkout is dirty; preserve and stop");
      if (git(["branch", "--show-current"]))
        throw new Error(
          "Discovery requires the detached dedicated metadata checkout; preserve named branch ownership",
        );
      if (
        !path.relative(
          path.resolve(root, git(["rev-parse", "--git-common-dir"])),
          path.resolve(root, git(["rev-parse", "--git-dir"])),
        )
      )
        throw new Error(
          "Discovery requires a dedicated linked metadata checkout; preserve the primary checkout",
        );
      const bootstrap = [
        "daily-discovery.mts",
        "discovery-budget.mts",
        "discovery-cache.mts",
        "github-api.mts",
        "release-coordinator-deadline.mts",
        "release-readonly-child-environment.mts",
        "json-values.mts",
        "observe-configured-upstream.mts",
        "release-path-safety.mts",
        "upstream-observer.mts",
        "runtime-values.mts",
      ];
      const loaded = await Promise.all(
        bootstrap.map(
          async (name) =>
            [
              name,
              createHash("sha256")
                .update(await readFile(path.join(root, "scripts", name)))
                .digest("hex"),
            ] as const,
        ),
      );
      git(["fetch", "--no-tags", "--no-recurse-submodules", "origin", "main"]);
      const head = git(["rev-parse", "origin/main"]);
      git(["cat-file", "-e", `${head}:scripts/daily-discovery.mts`]);
      git(["cat-file", "-e", `${head}:.agents/skills/portcove-daily-discovery/SKILL.md`]);
      git(["checkout", "--detach", head]);
      for (const [name, hash] of loaded)
        if (
          createHash("sha256")
            .update(await readFile(path.join(root, "scripts", name)))
            .digest("hex") !== hash
        )
          throw new Error(
            "Loaded bootstrap updated; restart with current main before investigation",
          );
      const { runDiscoverySession } = await import("./daily-discovery-session.mts");
      await runDiscoverySession(state, root, head, startedAt);
    });
  } catch (error) {
    const receipt = {
      format: 1,
      status: errorCode(error) === "EEXIST" ? "skipped-lock" : "blocked",
      at: new Date().toISOString(),
      reason: errorMessage(error),
    };
    await writeFile(path.join(state, `startup-${Date.now()}.json`), JSON.stringify(receipt), {
      flag: "wx",
    });
    if (receipt.status !== "skipped-lock")
      await writeFile(path.join(state, "latest-startup.json"), JSON.stringify(receipt));
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  dailyDiscoveryMain(process.argv.slice(2)).catch((e) => {
    console.error(errorMessage(e));
    process.exitCode = 1;
  });
