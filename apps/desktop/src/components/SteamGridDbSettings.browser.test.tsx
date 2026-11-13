import { controlledAct as act } from "../../test/controlled-react-act";
import { render as renderComponent, cleanup, type RenderResult } from "vitest-browser-react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { desktopApi } from "../api";
import { SteamGridDbSettings } from "./SteamGridDbSettings";

let root: RenderResult;
let container: HTMLDivElement;
beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = await renderComponent(null, { container: document.body.appendChild(container) });
});
afterEach(async () => {
  await cleanup();
  container.remove();
  vi.restoreAllMocks();
});

const buttonNamed = (name: string) =>
  [...container.querySelectorAll("button")].find((item) => item.textContent === name);

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

it("saves the player's own key without ever showing it back, then removes it", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockResolvedValue({ configured: false });
  const save = vi.spyOn(desktopApi, "setSteamGridDbKey").mockResolvedValue({ configured: true });
  const clear = vi
    .spyOn(desktopApi, "clearSteamGridDbKey")
    .mockResolvedValue({ configured: false });
  await act(async () => {
    await root.rerender(<SteamGridDbSettings />);
  });
  await vi.waitFor(() => expect(container.textContent).toContain("No SteamGridDB API key"));
  const input = container.querySelector<HTMLInputElement>("#steamgriddb-api-key")!;
  expect(input.type).toBe("password");
  await type(input, "0123456789abcdef0123456789abcdef");
  await act(async () => buttonNamed("Save key")!.click());
  expect(save).toHaveBeenCalledWith("0123456789abcdef0123456789abcdef");
  await vi.waitFor(() => expect(container.textContent).toContain("key is saved on this device"));
  expect(container.querySelector("#steamgriddb-api-key")).toBeNull();
  await vi.waitFor(() => expect(document.activeElement?.textContent).toBe("Remove key"));
  expect(container.innerHTML).not.toContain("0123456789abcdef");
  await act(async () => buttonNamed("Remove key")!.click());
  expect(clear).toHaveBeenCalled();
  await vi.waitFor(() =>
    expect(container.textContent).toContain("Images you already chose stay in your library"),
  );
  await vi.waitFor(() => expect(document.activeElement?.id).toBe("steamgriddb-api-key"));
});

it("states a secure-store problem without exposing input it could not save", async () => {
  vi.spyOn(desktopApi, "steamGridDbKeyStatus").mockRejectedValue({
    code: "state",
    message: "store",
    presentation: {
      presentation_key: "credential_store_unavailable",
      summary: "This device has no secure credential storage that Portcove can use.",
      tone: "error",
      mutation_state: "no_changes",
      phase: null,
      recovery_actions: ["view_technical_details"],
      technical_message: "could not read the SteamGridDB key: No default store",
      technical_context: {},
    },
  });
  await act(async () => {
    await root.rerender(<SteamGridDbSettings />);
  });
  await vi.waitFor(() =>
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "no secure credential storage",
    ),
  );
});
