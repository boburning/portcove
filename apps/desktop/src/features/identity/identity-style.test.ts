import { expect, it } from "vite-plus/test";
import { canonicalIdentityId, identityLabel, identityStyle } from "./identity-style";
import palette from "./platform-palette.json";

it("keeps the 54 supplied identity colors separate from release and readiness", () => {
  expect(Object.keys(palette)).toHaveLength(54);
  expect(identityStyle("stable", true)).toEqual({ "--identity-base": "#22C55E" });
  expect(identityStyle("beta", true)).toEqual({ "--identity-base": "#F59E0B" });
  expect(identityStyle("rolling", true)).toEqual({ "--identity-base": "#3B82F6" });
  expect(identityStyle("alpha", true)).toBeUndefined();
  expect(identityLabel("not-specified")).toBe("Not specified");
});

it("uses canonical system aliases without guessing an unknown system", () => {
  expect(canonicalIdentityId("snes")).toBe("super-nintendo");
  expect(identityLabel("ps1")).toBe("PlayStation");
  expect(identityStyle("windows-x86-64")).toEqual(identityStyle("windows"));
  expect(identityStyle("unknown-system")).toBeUndefined();
});
