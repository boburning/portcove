import { execFileSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { observationHash } from "./upstream-observer.mjs";
import { collectRepositoryHealth } from "./check-catalog-repositories.mjs";
import { parseRawDiff } from "./select-ci-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const catalogPath = "crates/portcove-core/catalog/catalog.json";
const catalogInputs = new Set([
  catalogPath,
  "crates/portcove-core/catalog/catalog-current-authoring.json",
]);
const sha = /^[a-f0-9]{40}$/u;

// Removing only summary is deliberate: an unfamiliar semantic field or root
// structure remains part of the comparison instead of gaining an exemption.
function healthPort(port) {
  const { summary: _summary, ...inputs } = port;
  return inputs;
}

export async function selectUpstreamHealthScope(base, head, changes) {
  // Validate both complete inventories without performing any requests.
  for (const catalog of [base, head])
    await collectRepositoryHealth(catalog, {
      portIds: [],
      fetch: () => {
        throw new Error("Selection must not request");
      },
    });
  const full = (reason) => ({
    mode: "full",
    reason,
    port_ids: head.ports.map((port) => port.id),
    retcomm_port_ids: null,
  });
  if (!Array.isArray(changes) || !changes.length) return full("uncertain or empty Git diff");
  if (
    changes.some(
      (change) =>
        change.status !== "M" ||
        change.oldMode !== "100644" ||
        change.newMode !== "100644" ||
        change.oldPath !== change.newPath ||
        !catalogInputs.has(change.newPath),
    )
  )
    return full("shared tool, workflow, policy, mixed or uncertain change");
  const { ports: _basePorts, ...baseRoot } = base;
  const { ports: _headPorts, ...headRoot } = head;
  if (observationHash(baseRoot) !== observationHash(headRoot))
    return full("catalog root or historical evidence changed");
  const old = new Map(base.ports.map((port) => [port.id, port]));
  if (base.ports.some((port) => !head.ports.some((candidate) => candidate.id === port.id)))
    return full("port removal retains complete monitoring");
  const selected = head.ports.filter(
    (port) =>
      !old.has(port.id) ||
      observationHash(healthPort(old.get(port.id))) !== observationHash(healthPort(port)),
  );
  return {
    mode: selected.length ? "affected" : "none",
    reason: selected.length
      ? "changed port contracts"
      : "no changed upstream health inputs; global health unassessed",
    port_ids: selected.map((port) => port.id),
    retcomm_port_ids: selected
      .filter((port) => port.adapter === "psx-recomp-managed")
      .map((port) => port.id),
  };
}

export async function discoverUpstreamHealthScope(
  { event, baseSha, headSha, checkoutSha },
  git = (args) => execFileSync("git", args, { cwd: root, maxBuffer: 8 * 1024 * 1024 }),
  readCheckout = () => readFile(path.join(root, catalogPath), "utf8"),
) {
  const current = JSON.parse(await readCheckout());
  if (event !== "pull_request")
    return {
      mode: "full",
      reason: "main, scheduled and manual monitoring retain full inventory",
      port_ids: current.ports.map((port) => port.id),
      retcomm_port_ids: null,
    };
  if (![baseSha, headSha, checkoutSha].every((value) => sha.test(value ?? "")))
    throw new Error("PR health selection requires exact base, head and checkout SHAs");
  const read = (args) => String(git(args)).trim();
  for (const value of [baseSha, headSha, checkoutSha])
    if (read(["rev-parse", "--verify", `${value}^{commit}`]) !== value)
      throw new Error("Git identity differs");
  const mergeBase = read(["merge-base", baseSha, headSha]);
  if (!sha.test(mergeBase)) throw new Error("Missing unique merge base");
  const checkoutTree = read(["rev-parse", `${checkoutSha}^{tree}`]);
  const headTree = read(["rev-parse", `${headSha}^{tree}`]);
  const baseTree = read(["rev-parse", `${baseSha}^{tree}`]);
  // A synthetic checkout may contain target changes. Never select narrowly
  // unless its complete tree is the reviewed head tree.
  const changes = parseRawDiff(git(["diff", "--raw", "-z", "--find-renames", mergeBase, headSha]));
  const base = JSON.parse(read(["show", `${mergeBase}:${catalogPath}`]));
  const head = JSON.parse(read(["show", `${headSha}:${catalogPath}`]));
  let selection = await selectUpstreamHealthScope(base, head, changes);
  if (checkoutTree !== headTree || observationHash(current) !== observationHash(head))
    selection = {
      mode: "full",
      reason: "checkout or target interaction differs from exact head",
      port_ids: current.ports.map((port) => port.id),
      retcomm_port_ids: null,
    };
  return {
    ...selection,
    identities: {
      base: baseSha,
      merge_base: mergeBase,
      head: headSha,
      checkout: checkoutSha,
      base_tree: baseTree,
      head_tree: headTree,
      checkout_tree: checkoutTree,
    },
    base_catalog_sha256: observationHash(base),
    head_catalog_sha256: observationHash(head),
    changes,
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length) throw new Error("upstream-health-plan accepts only fixed workflow environment");
  const plan = await discoverUpstreamHealthScope({
    event: process.env.GITHUB_EVENT_NAME,
    baseSha: process.env.PR_BASE_SHA,
    headSha: process.env.PR_HEAD_SHA,
    checkoutSha: process.env.GITHUB_SHA,
  });
  console.log(JSON.stringify(plan, null, 2));
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `mode=${plan.mode}\nport_ids=${plan.port_ids.join(",")}\nretcomm_port_ids=${(plan.retcomm_port_ids ?? []).join(",")}\nretcomm=${plan.mode === "full" || plan.retcomm_port_ids.length > 0}\n`,
    );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(() => {
    console.error("Upstream health scope discovery failed; no narrower check is authorized.");
    process.exitCode = 1;
  });
