import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdentityIcon } from "./IdentityIcon";
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

it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])(
  "preserves the unknown identity %s without inherited aliases, colors or icons",
  (id) => {
    expect(canonicalIdentityId(id)).toBe(id);
    expect(identityLabel(id)).toBe(id);
    expect(identityStyle(id)).toBeUndefined();
    expect(identityStyle(id, true)).toBeUndefined();
    expect(renderToStaticMarkup(createElement(IdentityIcon, { name: id }))).toBe("");
    expect(renderToStaticMarkup(createElement(IdentityIcon, { name: id, channel: true }))).toBe("");
  },
);
