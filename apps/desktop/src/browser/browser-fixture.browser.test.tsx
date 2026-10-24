import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";
import { browserFixture } from "../../test/browser-fixture";
import { installInteractiveTransport } from "../dev-scenarios/interactive/transport";

it("restores owned browser state and resources after a partial setup failure", async () => {
  const options = {
    storage: true,
    attributes: ["data-theme", "dir"],
    styles: ["font-size"],
    viewport: true,
  };
  const outer = browserFixture(options);
  try {
    localStorage.setItem("fixture-retained", "before");
    document.documentElement.setAttribute("data-theme", "light");
    document.documentElement.setAttribute("dir", "rtl");
    document.documentElement.style.setProperty("font-size", "17px", "important");
    const width = window.innerWidth,
      height = window.innerHeight;
    const fixture = browserFixture(options);
    const listener = vi.fn();
    const failure = new Error("owned setup failure after resources were created");
    const setup = async () => {
      try {
        const transport = installInteractiveTransport("collection", (message) => {
          throw new Error(message);
        });
        fixture.defer(() => transport.dispose());
        window.addEventListener("fixture-resource-probe", listener);
        fixture.defer(() => window.removeEventListener("fixture-resource-probe", listener));
        const host = document.body.appendChild(document.createElement("div"));
        host.dataset.fixtureResource = "owned";
        fixture.defer(() => host.remove());
        fixture.defer(() => cleanup());
        await render(<button type="button">Owned setup control</button>, { container: host });
        localStorage.clear();
        localStorage.setItem("fixture-added", "during setup");
        document.documentElement.setAttribute("data-theme", "dark");
        document.documentElement.removeAttribute("dir");
        document.documentElement.style.fontSize = "200%";
        await page.viewport(320, 600);
        window.dispatchEvent(new Event("fixture-resource-probe"));
        expect(listener).toHaveBeenCalledOnce();
        throw failure;
      } finally {
        await fixture.dispose();
      }
    };
    await expect(setup()).rejects.toBe(failure);
    await fixture.dispose();
    expect(localStorage.getItem("fixture-retained")).toBe("before");
    expect(localStorage.getItem("fixture-added")).toBeNull();
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.getAttribute("dir")).toBe("rtl");
    expect(document.documentElement.style.getPropertyValue("font-size")).toBe("17px");
    expect(document.documentElement.style.getPropertyPriority("font-size")).toBe("important");
    expect([window.innerWidth, window.innerHeight]).toEqual([width, height]);
    expect(document.querySelector('[data-fixture-resource="owned"]')).toBeNull();
    expect("__TAURI_INTERNALS__" in window).toBe(false);
    expect("__TAURI_EVENT_PLUGIN_INTERNALS__" in window).toBe(false);
    window.dispatchEvent(new Event("fixture-resource-probe"));
    expect(listener).toHaveBeenCalledOnce();
  } finally {
    await outer.dispose();
  }
});

it("drains every registered resource once when a cleanup fails", async () => {
  const fixture = browserFixture();
  const order: string[] = [];
  const failure = new Error("owned cleanup failure");
  fixture.defer(() => {
    order.push("first resource");
  });
  fixture.defer(() => {
    order.push("failing resource");
    throw failure;
  });
  fixture.defer(async () => {
    await Promise.resolve();
    order.push("last resource");
  });
  const first = fixture.dispose();
  expect(fixture.dispose()).toBe(first);
  expect(() => fixture.defer(() => {})).toThrow(/disposed/);
  await expect(first).rejects.toBe(failure);
  expect(order).toEqual(["last resource", "failing resource", "first resource"]);
});
