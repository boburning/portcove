import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// A deliberately narrow TOML comparison. Parser absence or uncertainty keeps
// the normal workspace obligation. This helper never changes runner budgets.
export function compareNextest(before, after, spawn = spawnSync) {
  if (
    typeof before !== "string" ||
    typeof after !== "string" ||
    Buffer.byteLength(before) > 262144 ||
    Buffer.byteLength(after) > 262144
  )
    return null;
  const result = spawn(
    "python",
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
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  return { parser: "python-tomllib-v1", before: hash(before), after: hash(after) };
}

export function hasNextestEquivalence(change) {
  return (
    change.oldPath === ".config/nextest.toml" &&
    change.newPath === change.oldPath &&
    change.status === "M" &&
    change.oldMode === change.newMode &&
    change.nextest_equivalence?.parser === "python-tomllib-v1" &&
    [change.nextest_equivalence.before, change.nextest_equivalence.after].every((value) =>
      /^[a-f0-9]{64}$/u.test(value ?? ""),
    )
  );
}

export function annotateNextest(changes, readBefore, readAfter) {
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
