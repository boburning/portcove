import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vite-plus/test";
import { Boxes, Library } from "lucide-react";
import { userEvent } from "vite-plus/test/browser";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { CommandPalette, type PaletteCommand } from "./CommandPalette";

const commands: [PaletteCommand, PaletteCommand] = [
  {
    id: "library",
    label: "Open library",
    description: "Installed ports",
    keywords: "collection",
    icon: Library,
    action: vi.fn(),
  },
  {
    id: "catalog",
    label: "Open Find games",
    description: "Browse supported ports",
    keywords: "discover",
    icon: Boxes,
    action: vi.fn(),
  },
];

describe("command palette", () => {
  it("has an exact dialog name and labelled search control in the rendered DOM", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(createElement(CommandPalette, { open: true, commands, close: vi.fn() })),
      );
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(dialog?.getAttribute("aria-labelledby")).toBe("command-palette-title");
      expect(dialog?.querySelector("#command-palette-title")?.textContent).toBe(
        "Portcove commands",
      );
      expect(dialog?.querySelector('input[aria-label="Search commands"]')).not.toBeNull();
      expect(host.contains(dialog)).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("announces an empty command set without an empty listbox or active option", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    try {
      await act(async () =>
        root.render(
          createElement(CommandPalette, {
            open: true,
            commands: [],
            close: vi.fn(),
          }),
        ),
      );
      const search = document.body.querySelector('[role="combobox"]');
      expect(search?.getAttribute("aria-expanded")).toBe("false");
      expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
        "No commands are available.",
      );
      expect(document.body.querySelector('[role="listbox"]')).toBeNull();
      expect(search?.hasAttribute("aria-controls")).toBe(false);
      expect(search?.hasAttribute("aria-activedescendant")).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });
});

describe("command search transitions", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("crosses presentation groups in registry order while skipping disabled commands", async () => {
    const action = vi.fn();
    const unavailable = vi.fn();
    const close = vi.fn();
    const grouped = [
      { ...commands[0], group: "Navigation" },
      {
        ...commands[1],
        id: "unavailable",
        group: "Library actions",
        disabled: true,
        action: unavailable,
      },
      { ...commands[1], group: "Library actions", action },
    ];
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands: grouped, close })),
    );
    const search = document.body.querySelector<HTMLInputElement>("input")!;
    const key = async (key: string) =>
      act(async () => {
        search.dispatchEvent(
          new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
        );
      });
    expect(
      [...document.body.querySelectorAll('[role="listbox"] [role="group"]')].map((group) =>
        group.getAttribute("aria-label"),
      ),
    ).toEqual(["Navigation", "Library actions"]);
    expect(
      [...document.body.querySelectorAll('[role="option"]')].map((option) => option.id),
    ).toEqual(["command-library", "command-unavailable", "command-catalog"]);
    await key("ArrowDown");
    expect(search.getAttribute("aria-activedescendant")).toBe("command-catalog");
    await key("ArrowUp");
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
    await key("ArrowDown");
    await key("Enter");
    expect(action).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(unavailable).not.toHaveBeenCalled();
  });

  it("keeps an empty search inert and restores keyboard selection when matches return", async () => {
    const action = vi.fn();
    const close = vi.fn();
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          open: true,
          commands: [{ ...commands[0], action }],
          close,
        }),
      ),
    );
    const search = document.body.querySelector("input")!;
    const change = async (value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
          search,
          value,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const key = async (value: string) =>
      act(async () => {
        search.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: value,
            bubbles: true,
            cancelable: true,
          }),
        );
      });
    await change("owned-no-matching-command");
    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(
      "No command matches",
    );
    expect(document.body.querySelector('[role="listbox"]')).toBeNull();
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(search.hasAttribute("aria-controls")).toBe(false);
    await key("ArrowDown");
    await key("Enter");
    expect(action).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    await change("library");
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
    expect(document.body.querySelector('[role="option"]')?.getAttribute("aria-selected")).toBe(
      "true",
    );
    await key("Enter");
    expect(action).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("recovers search focus when an asynchronous command update removes the focused option", async () => {
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands, close: vi.fn() })),
    );
    const search = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Search commands"]',
    )!;
    const focusedOption = document.body.querySelector<HTMLButtonElement>('[role="option"]')!;
    await expect.poll(() => document.activeElement).toBe(search);
    await act(async () => focusedOption.focus());
    expect(document.activeElement).toBe(focusedOption);
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands: [], close: vi.fn() })),
    );
    await act(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    await expect.poll(() => document.activeElement).toBe(search);
  });

  it("preserves the active command by stable ID across background reorder and removal", async () => {
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands, close: vi.fn() })),
    );
    const search = document.body.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(search.getAttribute("aria-activedescendant")).toBe("command-catalog");

    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          open: true,
          commands: [commands[1], commands[0]],
          close: vi.fn(),
        }),
      ),
    );
    expect(search.getAttribute("aria-activedescendant")).toBe("command-catalog");

    await act(async () =>
      root.render(
        createElement(CommandPalette, { open: true, commands: [commands[0]], close: vi.fn() }),
      ),
    );
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
  });

  it("moves to an eligible command when refresh disables the active one", async () => {
    const unavailableAction = vi.fn();
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands, close: vi.fn() })),
    );
    const search = document.body.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });
    expect(search.getAttribute("aria-activedescendant")).toBe("command-catalog");

    const refreshed = [commands[0], { ...commands[1], disabled: true, action: unavailableAction }];
    await act(async () =>
      root.render(
        createElement(CommandPalette, { open: true, commands: refreshed, close: vi.fn() }),
      ),
    );
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
    expect(document.body.querySelector<HTMLButtonElement>("#command-catalog")?.disabled).toBe(true);

    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(search.getAttribute("aria-activedescendant")).toBe("command-library");
    expect(unavailableAction).not.toHaveBeenCalled();
  });

  it("leaves unavailable-only results visible without an executable active descendant", async () => {
    const action = vi.fn();
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          open: true,
          commands: [{ ...commands[0], disabled: true, action }],
          close: vi.fn(),
        }),
      ),
    );
    const search = document.body.querySelector<HTMLInputElement>("input")!;
    expect(document.body.querySelector('[role="option"]')?.textContent).toContain("Open library");
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("selects an eligible query result and ignores composing Enter", async () => {
    const unavailable = {
      ...commands[0],
      id: "unavailable",
      label: "Open unavailable feature",
      disabled: true,
      action: vi.fn(),
    };
    const available = { ...commands[1], label: "Open available catalog", action: vi.fn() };
    const close = vi.fn();
    await act(async () =>
      root.render(
        createElement(CommandPalette, {
          open: true,
          commands: [unavailable, available],
          close,
        }),
      ),
    );
    const search = document.body.querySelector<HTMLInputElement>("input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search,
        "open",
      );
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(search.getAttribute("aria-activedescendant")).toBe("command-catalog");
    expect(document.body.querySelector("#command-unavailable")).not.toBeNull();

    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
          isComposing: true,
        }),
      );
    });
    expect(available.action).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    await act(async () => {
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });
    expect(available.action).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("command input ownership", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  let close: Mock<() => void>;
  let available: [PaletteCommand, PaletteCommand];
  const search = () => document.body.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const key = async (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      key: value,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    await act(async () => {
      search().dispatchEvent(event);
    });
    return event;
  };
  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    HTMLElement.prototype.scrollIntoView = vi.fn();
    host = document.body.appendChild(document.createElement("div"));
    root = createRoot(host);
    close = vi.fn();
    available = [
      { ...commands[0], action: vi.fn() },
      { ...commands[1], action: vi.fn() },
    ];
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands: available, close })),
    );
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("leaves composing arrows and Enter to the input, then resumes command navigation", async () => {
    for (const value of ["ArrowDown", "ArrowUp", "Enter"]) {
      expect((await key(value, { isComposing: true })).defaultPrevented).toBe(false);
      expect(search().getAttribute("aria-activedescendant")).toBe("command-library");
    }
    expect(close).not.toHaveBeenCalled();
    await key("ArrowDown");
    expect(search().getAttribute("aria-activedescendant")).toBe("command-catalog");
    await key("Enter");
    expect(available[0].action).not.toHaveBeenCalled();
    expect(available[1].action).toHaveBeenCalledOnce();
  });

  it("holds command input throughout composition even when a key omits its composing flag", async () => {
    await act(async () =>
      search().dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })),
    );
    expect((await key("ArrowDown")).defaultPrevented).toBe(false);
    expect((await key("Enter")).defaultPrevented).toBe(false);
    expect(search().getAttribute("aria-activedescendant")).toBe("command-library");
    expect(close).not.toHaveBeenCalled();
    await act(async () =>
      search().dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })),
    );
    await key("Enter", { keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    await key("Enter");
    expect(available[0].action).toHaveBeenCalledOnce();
  });

  it("does not treat a repeated Enter as a fresh activation", async () => {
    expect((await key("Enter", { repeat: true })).defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    await key("Enter");
    expect(close).toHaveBeenCalledOnce();
    expect(available[0].action).toHaveBeenCalledOnce();
  });

  it("consumes a dispatch before close, including reentrant and mixed input", async () => {
    close.mockImplementation(() => {
      document.querySelector<HTMLButtonElement>("#command-catalog")!.click();
    });
    await act(async () => {
      search().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      search().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      document.querySelector<HTMLButtonElement>("#command-library")!.click();
    });
    expect(close).toHaveBeenCalledOnce();
    expect(available[0].action).toHaveBeenCalledOnce();
    expect(available[1].action).not.toHaveBeenCalled();
  });

  it("prevents native repeat activation on a focused option", async () => {
    const option = document.querySelector<HTMLButtonElement>("#command-library")!;
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => option.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    await act(async () => option.click());
    expect(available[0].action).toHaveBeenCalledOnce();
  });

  it("admits a new command after close and reopen", async () => {
    await key("Enter");
    await act(async () =>
      root.render(createElement(CommandPalette, { open: false, commands: available, close })),
    );
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands: available, close })),
    );
    // Let the reopened dialog complete its initial-focus lifecycle before input.
    await vi.waitFor(() => expect(document.activeElement).toBe(search()));
    await key("ArrowDown");
    expect(search().getAttribute("aria-activedescendant")).toBe("command-catalog");
    await key("Enter");
    expect(close).toHaveBeenCalledTimes(2);
    expect(available[0].action).toHaveBeenCalledOnce();
    expect(available[1].action).toHaveBeenCalledOnce();
  });

  it("keeps keyboard selection when reopening under a stationary pointer", async () => {
    await act(async () =>
      userEvent.hover(document.querySelector<HTMLButtonElement>("#command-library")!),
    );
    await key("Enter");
    await act(async () =>
      root.render(createElement(CommandPalette, { open: false, commands: available, close })),
    );
    await act(async () =>
      root.render(createElement(CommandPalette, { open: true, commands: available, close })),
    );
    await key("ArrowDown");
    expect(search().getAttribute("aria-activedescendant")).toBe("command-catalog");
    // A popup appearing beneath a stationary pointer emits entry without movement.
    await act(async () => {
      document
        .querySelector("#command-library")!
        .dispatchEvent(
          new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body }),
        );
    });
    expect(search().getAttribute("aria-activedescendant")).toBe("command-catalog");
    await key("Enter");
    expect(close).toHaveBeenCalledTimes(2);
    expect(available[0].action).toHaveBeenCalledOnce();
    expect(available[1].action).toHaveBeenCalledOnce();
  });

  it("lets pointer movement and option focus choose a command", async () => {
    await key("ArrowDown");
    const library = document.querySelector<HTMLButtonElement>("#command-library")!;
    await act(async () => userEvent.hover(search()));
    await act(async () => userEvent.hover(library));
    expect(search().getAttribute("aria-activedescendant")).toBe("command-library");
    await key("ArrowDown");
    await act(async () => library.focus());
    expect(search().getAttribute("aria-activedescendant")).toBe("command-library");
    await act(async () => userEvent.keyboard("{Enter}"));
    expect(close).toHaveBeenCalledOnce();
    expect(available[0].action).toHaveBeenCalledOnce();
    expect(available[1].action).not.toHaveBeenCalled();
  });

  it("clicks an option directly without first changing the active command", async () => {
    expect(search().getAttribute("aria-activedescendant")).toBe("command-library");
    await act(async () => document.querySelector<HTMLButtonElement>("#command-catalog")!.click());
    expect(close).toHaveBeenCalledOnce();
    expect(available[0].action).not.toHaveBeenCalled();
    expect(available[1].action).toHaveBeenCalledOnce();
  });
});
