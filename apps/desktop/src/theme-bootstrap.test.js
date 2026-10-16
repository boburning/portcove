import { it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { runInNewContext } from "node:vm";
it.each([
  ["dark", true, "dark"],
  ["light", false, "light"],
  ["system", true, "light"],
  ["system", false, "dark"],
  ["invalid", true, "light"],
  [null, false, "dark"],
])("selects %s before rendering with system-light=%s", (preference, light, expected) => {
  const root = { dataset: {}, style: {} };
  const code = readFileSync(new URL("../public/theme-bootstrap.js", import.meta.url), "utf8");
  runInNewContext(code, {
    document: { documentElement: root },
    localStorage: { getItem: () => preference },
    matchMedia: () => ({ matches: light }),
  });
  expect(root).toEqual({ dataset: { theme: expected }, style: { colorScheme: expected } });
});

it("keeps first paint usable when preference storage is blocked", () => {
  const root = { dataset: {}, style: {} };
  const code = readFileSync(new URL("../public/theme-bootstrap.js", import.meta.url), "utf8");
  runInNewContext(code, {
    document: { documentElement: root },
    localStorage: {
      getItem() {
        throw new Error("blocked");
      },
    },
    matchMedia: () => ({ matches: true }),
  });
  expect(root.dataset).toEqual({ theme: "light" });
});
