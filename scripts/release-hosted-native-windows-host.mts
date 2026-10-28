/** Pure observed Windows host data. No account, capture, provenance or authority. */
import assert from "node:assert/strict";
import { hostedWindowsContinuityPlatform } from "./release-native-qualification-contract.mts";
import { isRecord } from "./runtime-values.mts";

type Minimum = "windows-11-26h2-x64" | typeof hostedWindowsContinuityPlatform;
function exact(raw: unknown, keys: string): asserts raw is Record<string, unknown> {
  assert.ok(
    isRecord(raw) && Object.keys(raw).sort().join(",") === keys,
    "Windows host observation schema differs",
  );
}
function atLeast(raw: string, minimum: string) {
  const parse = (value: string) => {
    assert.match(value, /^[0-9]{1,10}(?:\.[0-9]{1,10}){1,3}$/u);
    return value.split(".").map(BigInt);
  };
  const actual = parse(raw),
    floor = parse(minimum);
  for (let index = 0; index < 4; index++) {
    if ((actual[index] ?? 0n) !== (floor[index] ?? 0n))
      return (actual[index] ?? 0n) > (floor[index] ?? 0n);
  }
  return true;
}

/** Server continuity never establishes the separately selected client floor. */
export function inspectHostedWindowsOperatingSystem(
  raw: unknown,
  minimum: Minimum,
  expectedVersion: string,
  clientFloor: string,
) {
  exact(raw, "build_number,caption,display_version,product_type,version");
  assert.ok(
    typeof raw.caption === "string" && raw.caption.length <= 128 && typeof raw.version === "string",
  );
  assert.equal(raw.version, expectedVersion, "Windows observed version differs");
  assert.match(clientFloor, /^[0-9]{1,10}(?:\.[0-9]{1,10}){1,3}$/u);
  if (minimum === hostedWindowsContinuityPlatform) {
    assert.equal(raw.product_type, 3);
    assert.match(raw.caption, /^Microsoft Windows Server 2022(?: |$)/u);
    assert.equal(raw.display_version, "21H2");
    assert.match(raw.version, /^10\.0\.20348(?:\.[0-9]{1,10})?$/u);
    assert.equal(raw.build_number, "20348");
  } else {
    assert.equal(minimum, "windows-11-26h2-x64");
    assert.equal(raw.product_type, 1);
    assert.match(raw.version, /^10\.0\.[0-9]{1,10}(?:\.[0-9]{1,10})?$/u);
    assert.match(raw.caption, /^Microsoft Windows 11(?: |$)/u);
    assert.equal(raw.display_version, "26H2");
    assert.ok(atLeast(raw.version, "10.0.26200") && atLeast(raw.version, clientFloor));
    assert.equal(raw.build_number, raw.version.split(".")[2]);
  }
  return Object.freeze({
    caption: raw.caption,
    version: raw.version,
    product_type: raw.product_type,
    display_version: raw.display_version,
    build_number: raw.build_number,
  });
}

export function inspectHostedNativeWindowsHost(
  raw: unknown,
  nonce: string,
  minimum: Minimum,
  clientFloor: string,
) {
  exact(raw, "architecture,broker_sid,machine_id_sha256,nonce,os,schema_version");
  assert.equal(raw.schema_version, 1);
  assert.match(nonce, /^[a-f0-9]{64}$/u);
  assert.equal(raw.nonce, nonce);
  assert.equal(raw.architecture, "x86_64");
  assert.ok(
    typeof raw.machine_id_sha256 === "string" && /^[a-f0-9]{64}$/u.test(raw.machine_id_sha256),
  );
  assert.ok(
    typeof raw.broker_sid === "string" &&
      raw.broker_sid.length <= 184 &&
      /^S-1-5-21-(?:[0-9]{1,10}-){3}[0-9]{1,10}$/u.test(raw.broker_sid),
  );
  assert.ok(
    raw.broker_sid
      .split("-")
      .slice(4)
      .every((part) => BigInt(part) <= 4294967295n && BigInt(part).toString() === part),
  );
  assert.ok(isRecord(raw.os) && typeof raw.os.version === "string");
  const os = inspectHostedWindowsOperatingSystem(raw.os, minimum, raw.os.version, clientFloor);
  return Object.freeze({
    architecture: "x86_64" as const,
    broker_sid: raw.broker_sid,
    machine_id_sha256: raw.machine_id_sha256,
    os,
    authority: "none" as const,
  });
}
