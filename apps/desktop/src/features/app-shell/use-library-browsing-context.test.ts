import { expect, it } from "vite-plus/test";
import { libraryBrowsingKey } from "./use-library-browsing-context";
it("uses one browsing key for regular and namespaced Windows paths", () => {
  expect(libraryBrowsingKey("E:\\Library")).toBe("E:\\Library");
  expect(libraryBrowsingKey("\\\\?\\E:\\Library")).toBe("E:\\Library");
  expect(libraryBrowsingKey("\\\\?\\UNC\\server\\share")).toBe("\\\\server\\share");
});
