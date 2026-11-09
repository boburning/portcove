import { describe, expect, it } from "vite-plus/test";
import { replaceEqualDeep } from "@tanstack/react-query";
import { referenceIdentity } from "./reference-identity";

describe("reference identity tokens", () => {
  it("keeps a token for a retained reference and changes it for a new one", () => {
    const value = { ports: [{ id: "a" }] };
    expect(referenceIdentity(value)).toBe(referenceIdentity(value));
    expect(referenceIdentity({ ...value })).not.toBe(referenceIdentity(value));
  });

  it("follows structural sharing for unchanged and changed workspace values", () => {
    const previous = { catalog: { ports: [{ id: "a" }] }, statuses: [{ id: "a", launches: 1 }] };
    const unchanged = replaceEqualDeep(previous, structuredClone(previous));
    expect(referenceIdentity(unchanged.catalog)).toBe(referenceIdentity(previous.catalog));
    const changed = replaceEqualDeep(previous, {
      ...structuredClone(previous),
      statuses: [{ id: "a", launches: 2 }],
    });
    expect(referenceIdentity(changed.catalog)).toBe(referenceIdentity(previous.catalog));
    expect(referenceIdentity(changed.statuses)).not.toBe(referenceIdentity(previous.statuses));
  });

  it("encodes absent and primitive values without allocating identities", () => {
    expect(referenceIdentity(undefined)).toBe("undefined");
    expect(referenceIdentity(null)).toBe("null");
    expect(referenceIdentity("sha")).toBe('"sha"');
    expect(referenceIdentity(3)).toBe("3");
  });
});
