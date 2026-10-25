import type { SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from "node:child_process";
import { isRecord } from "./runtime-values.mts";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export interface NextestProof {
  parser: "python-tomllib-v1";
  before: string;
  after: string;
}
export interface NextestChange {
  status: string;
  oldPath?: string | null;
  newPath?: string | null;
  oldMode?: string | null;
  newMode?: string | null;
  nextest_equivalence?: NextestProof;
}
type NextestRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "error">;

// A deliberately narrow TOML comparison. Parser absence or uncertainty keeps
// the normal workspace obligation. This helper never changes runner budgets.
export function compareNextest(
  before: unknown,
  after: unknown,
  spawn: NextestRunner = spawnSync,
): NextestProof | null {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    Buffer.byteLength(before) > 262144 ||
    Buffer.byteLength(after) > 262144
  )
    return null;
  const result = spawn(
    process.platform === "win32" ? "python" : "python3",
    [
      "-c",
      [
        "import sys,json,tomllib",
        "a,b=json.load(sys.stdin)",
        "def equal(a,b):",
        " if type(a) is not type(b): return False",
        " if isinstance(a,dict): return a.keys()==b.keys() and all(equal(a[k],b[k]) for k in a)",
        " if isinstance(a,list): return len(a)==len(b) and all(equal(x,y) for x,y in zip(a,b))",
        " return a==b",
        "print('equal' if equal(tomllib.loads(a),tomllib.loads(b)) else 'different')",
      ].join("\n"),
    ],
    {
      input: JSON.stringify([before, after]),
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.stdout.trim() !== "equal") return null;
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  return { parser: "python-tomllib-v1", before: hash(before), after: hash(after) };
}

export function isNextestProof(value: unknown): value is NextestProof {
  return (
    isRecord(value) &&
    value.parser === "python-tomllib-v1" &&
    [value.before, value.after].every(
      (hash) => typeof hash === "string" && /^[a-f0-9]{64}$/u.test(hash),
    )
  );
}

export function hasNextestEquivalence(change: NextestChange) {
  return (
    change.oldPath === ".config/nextest.toml" &&
    change.newPath === change.oldPath &&
    change.status === "M" &&
    change.oldMode === change.newMode &&
    isNextestProof(change.nextest_equivalence)
  );
}

export function annotateNextest<Change extends NextestChange>(
  changes: readonly Change[],
  readBefore: (file: string) => unknown,
  readAfter: (file: string) => unknown,
): (Change & { nextest_equivalence?: NextestProof })[] {
  return changes.map((change) => {
    if (
      change.oldPath !== ".config/nextest.toml" ||
      change.newPath !== change.oldPath ||
      change.status !== "M"
    )
      return change;
    try {
      const proof = compareNextest(readBefore(change.oldPath), readAfter(change.newPath));
      return proof ? { ...change, nextest_equivalence: proof } : change;
    } catch {
      return change;
    }
  });
}
