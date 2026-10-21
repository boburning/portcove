/** Namespace data for the ordinary AppImage updater journey. No execution or
 * acceptance authority is created by inspecting or planning this input. */
import assert from "node:assert/strict";
import { isRecord } from "../../../scripts/runtime-values.mts";
import {
  inspectIsolatedNativeLinuxBinding,
  planIsolatedNativeLinuxCommand,
} from "./native-linux-isolated-plan.mts";

const MiB = 1024 * 1024;
const fixedMetadata = "https://boburning.github.io/portcove/application/metadata/";
const fixedTargets = "https://boburning.github.io/portcove/application/targets/";
const hosts = ["boburning.github.io", "github.com", "release-assets.githubusercontent.com"];
function exact(raw: unknown, fields: string): asserts raw is Record<string, unknown> {
  assert.ok(isRecord(raw) && Object.keys(raw).sort().join(",") === fields);
}
function sha(value: unknown) {
  assert.ok(typeof value === "string" && /^[a-f0-9]{64}$/u.test(value));
  return value;
}
function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function inspectPublicNativeLinuxBinding(raw: unknown) {
  const value: unknown = structuredClone(raw);
  exact(value, "candidate,network,profile_id,retained_state_bytes,schema_version,session,source");
  assert.equal(value.schema_version, 1);
  assert.ok(value.profile_id === "client-a" || value.profile_id === "client-b");
  const session = inspectIsolatedNativeLinuxBinding(value.session);
  const attempt = `${session.linux_root}/invocations/${session.invocation_id}`;
  exact(value.candidate, "bytes,path,sha256");
  assert.equal(value.candidate.path, `${attempt}/bank/Candidate.AppImage`);
  assert.ok(Number.isSafeInteger(value.candidate.bytes));
  const candidate = {
    path: String(value.candidate.path),
    bytes: Number(value.candidate.bytes),
    sha256: sha(value.candidate.sha256),
  };
  assert.ok(candidate.bytes > 0 && candidate.bytes <= 512 * MiB);
  assert.notEqual(candidate.sha256, session.application.sha256);
  assert.ok(Number.isSafeInteger(value.retained_state_bytes));
  const retainedStateBytes = Number(value.retained_state_bytes);
  assert.ok(retainedStateBytes >= 0 && retainedStateBytes <= 64 * MiB);
  // The active image, staged candidate and temporary replacement must fit the
  // SAME existing hard tmpfs as the user's retained state. This is a refusal
  // bound, never a reservation or evidence of currently available headroom.
  const requiredBytes =
    session.application.bytes + 2 * candidate.bytes + retainedStateBytes + 16 * MiB;
  assert.ok(
    requiredBytes <= 512 * MiB,
    "ordinary update cannot fit the fixed writable-storage boundary",
  );
  exact(value.source, "fuse_sha256,network_sha256,services_sha256");
  const source = {
    fuse_sha256: sha(value.source.fuse_sha256),
    network_sha256: sha(value.source.network_sha256),
    services_sha256: sha(value.source.services_sha256),
  };
  exact(value.network, "addresses,metadata_base_url,targets_base_url");
  assert.equal(value.network.metadata_base_url, fixedMetadata);
  assert.equal(value.network.targets_base_url, fixedTargets);
  exact(value.network.addresses, [...hosts].sort().join(","));
  const addressInputs = value.network.addresses;
  const addresses = Object.fromEntries(
    hosts.map((host) => {
      const values = addressInputs[host];
      assert.ok(Array.isArray(values) && values.length >= 1 && values.length <= 8);
      const list = values.map((address: unknown) => {
        assert.ok(typeof address === "string" && /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(address));
        const octets = address.split(".").map(Number);
        assert.ok(octets.every((octet) => octet <= 255));
        assert.equal(octets.join("."), address);
        // The shared fixed relay performs the complete public-address refusal
        // again. This projection cannot appoint an origin or relax that policy.
        assert.ok(![0, 10, 127].includes(octets[0]!) && octets[0]! < 224);
        return address;
      });
      assert.deepEqual(list, [...new Set(list)].sort());
      return [host, list];
    }),
  );
  return freeze({
    schema_version: 1 as const,
    session,
    candidate,
    source,
    retained_state_bytes: retainedStateBytes,
    required_writable_bytes: requiredBytes,
    profile_id: value.profile_id,
    profile_home: `/native/profile/${value.profile_id}`,
    state: `${session.home}/state`,
    installation: `${session.home}/installation`,
    active_application: `${session.home}/installation/Portcove.AppImage`,
    network: { metadata_base_url: fixedMetadata, targets_base_url: fixedTargets, addresses },
    authority: "none" as const,
  });
}

export function planPublicNativeLinuxCommand(raw: unknown, configurationPath: string) {
  const binding = inspectPublicNativeLinuxBinding(raw);
  const base = planIsolatedNativeLinuxCommand(binding.session, configurationPath);
  const args = [...base.arguments];
  const replace = (before: string[], after: string[]) => {
    const matches = args.flatMap((_, index) =>
      before.every((part, offset) => args[index + offset] === part) ? [index] : [],
    );
    assert.equal(matches.length, 1, "maintained namespace recipe changed");
    args.splice(matches[0]!, before.length, ...after);
  };
  replace(
    ["--cap-drop", "ALL"],
    [
      "--cap-drop",
      "ALL",
      "--cap-add",
      "CAP_SYS_ADMIN",
      "--cap-add",
      "CAP_NET_ADMIN",
      "--cap-add",
      "CAP_NET_BIND_SERVICE",
    ],
  );
  replace(
    ["--ro-bind", binding.session.application.path, "/native/application.AppImage"],
    ["--bind", binding.installation, "/native/installation"],
  );
  replace(
    ["--bind", binding.session.home, binding.session.home],
    ["--bind", binding.state, binding.profile_home],
  );
  replace(["--chdir", binding.session.home], ["--chdir", binding.profile_home]);
  const prefix = configurationPath.slice(0, -5);
  replace(
    ["--ro-bind", configurationPath, "/native/config.json"],
    [
      "--ro-bind",
      configurationPath,
      "/native/config.json",
      "--ro-bind",
      `${binding.session.controller.root}/apps/desktop/scripts/native-linux-public-fuse.py`,
      "/native/fuse.py",
      "--ro-bind",
      `${binding.session.controller.root}/apps/desktop/scripts/native-linux-public-network.py`,
      "/native/public-network.py",
      "--ro-bind",
      `${binding.session.controller.root}/apps/desktop/scripts/native-linux-public-services.py`,
      "/native/public-services.py",
      "--ro-bind",
      `${prefix}.fuse.json`,
      "/native/fuse.json",
      "--ro-bind",
      `${prefix}.network.json`,
      "/native/public-network.json",
      "--ro-bind",
      `${prefix}.hosts`,
      "/etc/hosts",
      "--ro-bind",
      `${prefix}.nsswitch`,
      "/etc/nsswitch.conf",
    ],
  );
  return freeze({
    ...base,
    arguments: args,
    inherited_fuse_descriptors: [7, 8, 9, 10, 11, 12, 13, 14],
    required_writable_bytes: binding.required_writable_bytes,
  });
}
