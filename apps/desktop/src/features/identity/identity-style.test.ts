import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdentityIcon } from "./IdentityIcon";
import { expect, it } from "vite-plus/test";
import { canonicalIdentityId, identityLabel, identityStyle } from "./identity-style";
import palette from "./platform-palette.json";

it("keeps the 54 supplied identity colors separate from release and readiness", () => {
  expect(Object.keys(palette)).toHaveLength(54);
  // Channels are neutral so green stays readiness and blue stays selection (#5058 V2).
  for (const channel of ["stable", "beta", "rolling", "alpha"])
    expect(identityStyle(channel, true)).toBeUndefined();
  // A system or platform with the same ID keeps its identity color.
  expect(identityStyle("windows", true)).toBeUndefined();
  expect(identityStyle("windows")).toBeDefined();
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
