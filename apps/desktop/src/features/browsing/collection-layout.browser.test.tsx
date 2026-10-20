import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { collectionLayoutKey, useCollectionLayout } from "./use-collection-layout";
import { libraryBrowsingPreferenceKey } from "../app-shell/use-library-browsing-context";

it("restores each library's profile view without changing its existing browsing preferences", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const a = "fixture/collection/A",
    b = "fixture/collection/B";
  const untouched = '{"version":1,"retained":"existing browsing data"}';
  localStorage.setItem(libraryBrowsingPreferenceKey(a), untouched);
  localStorage.setItem(collectionLayoutKey(a), "invalid");
  const root = createRoot(document.createElement("div"));
  let current!: ReturnType<typeof useCollectionLayout>;
  function Fixture({ library }: { library: string }) {
    current = useCollectionLayout(library);
    return null;
  }
  try {
    await act(async () => root.render(<Fixture library={a} />));
    expect(current.value).toBe("covers");
    await act(async () => current.set("rows"));
    await act(async () => root.render(<Fixture library={b} />));
    expect(current.value).toBe("covers");
    await act(async () => root.render(<Fixture library={a} />));
    expect(current.value).toBe("rows");
    expect(localStorage.getItem(libraryBrowsingPreferenceKey(a))).toBe(untouched);
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    await act(async () => current.set("covers"));
    expect(current).toMatchObject({ value: "covers", failure: "write" });
    write.mockRestore();
    expect(localStorage.getItem(collectionLayoutKey(a))).toBe("rows");
  } finally {
    await act(async () => root.unmount());
    localStorage.removeItem(collectionLayoutKey(a));
    localStorage.removeItem(collectionLayoutKey(b));
    localStorage.removeItem(libraryBrowsingPreferenceKey(a));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
