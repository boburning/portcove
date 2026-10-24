import { page } from "vite-plus/test/browser";

/** Opt-in ownership for one isolated browser fixture; scenario setup stays local. */
export function browserFixture({
  storage = false,
  attributes = [],
  styles = [],
  viewport = false,
}: {
  storage?: boolean;
  attributes?: readonly string[];
  styles?: readonly string[];
  viewport?: boolean;
} = {}) {
  const { document, localStorage, window } = globalThis;
  const cleanups: (() => void | Promise<void>)[] = [];
  if (viewport) {
    const width = window.innerWidth,
      height = window.innerHeight;
    cleanups.push(() => page.viewport(width, height));
  }
  for (const property of styles) {
    const value = document.documentElement.style.getPropertyValue(property),
      priority = document.documentElement.style.getPropertyPriority(property);
    cleanups.push(() => {
      if (value) document.documentElement.style.setProperty(property, value, priority);
      else document.documentElement.style.removeProperty(property);
    });
  }
  for (const name of attributes) {
    const value = document.documentElement.getAttribute(name);
    cleanups.push(() => {
      if (value === null) document.documentElement.removeAttribute(name);
      else document.documentElement.setAttribute(name, value);
    });
  }
  if (storage) {
    const values = new Map<string, string>();
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key !== null) {
        const value = localStorage.getItem(key);
        if (value !== null) values.set(key, value);
      }
    }
    cleanups.push(() => {
      localStorage.clear();
      for (const [key, value] of values) localStorage.setItem(key, value);
    });
  }
  let disposal: Promise<void> | undefined;
  return {
    defer(cleanup: () => void | Promise<void>) {
      if (disposal) throw new Error("Cannot add resources to a disposed browser fixture");
      cleanups.push(cleanup);
    },
    dispose() {
      disposal ??= Promise.resolve().then(async () => {
        const failures: unknown[] = [];
        for (const cleanup of cleanups.reverse()) {
          try {
            await cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, "Browser fixture cleanup failed");
      });
      return disposal;
    },
  };
}
