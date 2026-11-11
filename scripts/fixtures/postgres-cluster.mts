import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { registerDisposableDirectory } from "./disposable-directory.mts";
import { clientEnvironment, libpqEnvironmentFromUrl } from "../maintenance-store.mts";

export const postgresPrerequisite = "PostgreSQL server prerequisite unavailable";

/** Non-root PostgreSQL 16+ server binaries, or the declared prerequisite skip reason. */
export function postgresServer(): { directory?: string; skip?: string } {
  if (process.platform === "win32")
    return { skip: `${postgresPrerequisite}: Linux/macOS cluster fixture` };
  if (process.getuid?.() === 0)
    return { skip: `${postgresPrerequisite}: initdb refuses the root user` };
  const configured = process.env.PORTCOVE_POSTGRES_BIN?.trim();
  const candidates = configured
    ? [configured]
    : existsSync("/usr/lib/postgresql")
      ? readdirSync("/usr/lib/postgresql")
          .filter((name) => /^\d+$/u.test(name) && Number(name) >= 16)
          .sort((left, right) => Number(right) - Number(left))
          .map((name) => `/usr/lib/postgresql/${name}/bin`)
      : [];
  const directory = candidates.find((candidate) => existsSync(path.join(candidate, "initdb")));
  return directory
    ? { directory }
    : { skip: `${postgresPrerequisite}: PostgreSQL 16+ server binaries not found` };
}

let nextPort = 15_400 + (process.pid % 400) * 2;

function run(binary: string, args: string[]) {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${path.basename(binary)} ${args.join(" ")}\n${result.stderr}`);
}

export interface ClusterFixture {
  root: string;
  start(name: string): { owner: NodeJS.ProcessEnv; as(user: string): NodeJS.ProcessEnv };
}

/** Disposable clusters on private Unix sockets; servers stop before their directory is removed. */
export function postgresFixture(context: TestContext, bin: string): ClusterFixture {
  // Short path: Unix socket paths are limited to about 100 bytes.
  const root = mkdtempSync(path.join(os.tmpdir(), "pcm-"));
  const stops: (() => void)[] = [];
  registerDisposableDirectory(context, root, {
    drain() {
      const failures: unknown[] = [];
      for (const stop of stops.splice(0))
        try {
          stop();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length) throw new AggregateError(failures, "PostgreSQL fixture did not stop");
    },
  });
  return {
    root,
    start(name) {
      const data = path.join(root, name);
      const port = nextPort++;
      run(path.join(bin, "initdb"), [
        "-D",
        data,
        "-U",
        "owner",
        "--auth=trust",
        "--no-locale",
        "-E",
        "UTF8",
      ]);
      run(path.join(bin, "pg_ctl"), [
        "-D",
        data,
        "-l",
        `${data}.log`,
        "-w",
        "-o",
        `-k ${root} -c listen_addresses= -p ${port}`,
        "start",
      ]);
      stops.push(() =>
        run(path.join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]),
      );
      const as = (user: string) =>
        clientEnvironment(
          libpqEnvironmentFromUrl(
            `postgresql://${user}@localhost/postgres?host=${root}&port=${port}`,
          ),
          { ...process.env, PORTCOVE_POSTGRES_BIN: bin },
        );
      return { owner: as("owner"), as };
    },
  };
}
