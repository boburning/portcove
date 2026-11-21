import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { copyText } from "./clipboard";

let host: HTMLDivElement;
let temporaryFields: Set<HTMLTextAreaElement>;
const payload = "C:\\Games\\保存\\game.exe\n--channel beta";

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  temporaryFields = new Set();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const field of temporaryFields) field.remove();
  host.remove();
  document.getSelection()?.removeAllRanges();
});

function legacy(outcome: () => boolean) {
  vi.spyOn(navigator, "clipboard", "get").mockReturnValue(undefined as unknown as Clipboard);
  return vi.spyOn(document, "execCommand").mockImplementation((command) => {
    expect(command).toBe("copy");
    const temporary = [...document.querySelectorAll("textarea")].find(
      (field) => !host.contains(field),
    );
    expect(temporary?.value).toBe(payload);
    expect(temporary?.readOnly).toBe(true);
    if (temporary) temporaryFields.add(temporary);
    return outcome();
  });
}

it.each([true, false, "throw"] as const)(
  "cleans up the fallback field after legacy copy returns %s",
  async (outcome) => {
    const original = host.appendChild(document.createElement("button"));
    original.focus();
    const failure = new Error("legacy copy threw");
    legacy(() => {
      if (outcome === "throw") throw failure;
      return outcome;
    });
    const [result] = await Promise.allSettled([copyText(payload)]);
    expect(result).toEqual(
      outcome === true
        ? { status: "fulfilled", value: undefined }
        : {
            status: "rejected",
            reason: outcome === "throw" ? failure : new Error("Clipboard access is unavailable."),
          },
    );
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(original);
  },
);

it.each(["input", "textarea"] as const)(
  "preserves the original %s focus and backward selection",
  async (tag) => {
    const original = document.createElement(tag);
    original.value = "Keep this selection";
    host.append(original);
    original.focus();
    original.setSelectionRange(5, 9, "backward");
    legacy(() => true);
    await copyText(payload);
    expect(document.activeElement).toBe(original);
    expect(original.value).toBe("Keep this selection");
    expect(original.selectionStart).toBe(5);
    expect(original.selectionEnd).toBe(9);
    expect(original.selectionDirection).toBe("backward");
    expect(document.querySelectorAll("textarea").length).toBe(tag === "textarea" ? 1 : 0);
  },
);

it("preserves a backward DOM text selection and the focused copy control", async () => {
  const button = host.appendChild(document.createElement("button"));
  button.textContent = "Copy code";
  const text = host.appendChild(document.createTextNode("Keep this selected text"));
  button.focus();
  const selection = document.getSelection()!;
  selection.setBaseAndExtent(text, 9, text, 5);
  legacy(() => true);
  await copyText(payload);
  expect(document.activeElement).toBe(button);
  expect(selection.anchorNode).toBe(text);
  expect(selection.anchorOffset).toBe(9);
  expect(selection.focusNode).toBe(text);
  expect(selection.focusOffset).toBe(5);
  expect(selection.toString()).toBe("this");
});

it("does not revive an original control removed by a copy handler", async () => {
  const original = host.appendChild(document.createElement("input"));
  original.value = "Removed during copy";
  original.focus();
  original.select();
  legacy(() => {
    original.remove();
    return true;
  });
  await expect(copyText(payload)).resolves.toBeUndefined();
  expect(original.isConnected).toBe(false);
  expect(document.activeElement).not.toBe(original);
  expect(document.querySelector("textarea")).toBeNull();
});

it("does not select replacement DOM text with the previous selection offsets", async () => {
  const original = host.appendChild(document.createElement("button"));
  const text = host.appendChild(document.createTextNode("Keep this selected text"));
  original.focus();
  const selection = document.getSelection()!;
  selection.setBaseAndExtent(text, 9, text, 5);
  legacy(() => {
    text.textContent = "Different replacement text";
    return true;
  });
  await copyText(payload);
  expect(document.activeElement).toBe(original);
  expect(text.textContent).toBe("Different replacement text");
  expect(selection.toString()).toBe("");
});

it("retains a new focus target chosen by a copy handler", async () => {
  const original = host.appendChild(document.createElement("button"));
  const next = host.appendChild(document.createElement("button"));
  original.focus();
  legacy(() => {
    next.focus();
    return true;
  });
  await copyText(payload);
  expect(document.activeElement).toBe(next);
});

it("does not restore an input selection after its value changes during copying", async () => {
  const original = host.appendChild(document.createElement("input"));
  original.value = "Previous value";
  original.focus();
  original.setSelectionRange(0, 8);
  legacy(() => {
    original.value = "New";
    return true;
  });
  await copyText(payload);
  expect(document.activeElement).toBe(original);
  expect(original.value).toBe("New");
  expect(original.selectionStart).toBe(3);
  expect(original.selectionEnd).toBe(3);
});

it.each([true, false])(
  "preserves the copy outcome when focus restoration throws (success=%s)",
  async (ok) => {
    const original = host.appendChild(document.createElement("button"));
    original.focus();
    const focus = vi.spyOn(original, "focus").mockImplementation(() => {
      throw new Error("Focus unavailable");
    });
    const failure = new Error("original copy error");
    legacy(() => {
      [...temporaryFields][0]!.focus();
      if (!ok) throw failure;
      return true;
    });
    const [result] = await Promise.allSettled([copyText(payload)]);
    expect(result).toEqual(
      ok ? { status: "fulfilled", value: undefined } : { status: "rejected", reason: failure },
    );
    expect(focus).toHaveBeenCalledOnce();
    expect(document.querySelector("textarea")).toBeNull();
  },
);

it.each([true, false])(
  "keeps modern clipboard success=%s separate from the fallback",
  async (ok) => {
    const failure = new Error("modern clipboard denied");
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    if (ok) writeText.mockResolvedValue(undefined);
    else writeText.mockRejectedValue(failure);
    const fallback = vi.spyOn(document, "execCommand");
    const button = host.appendChild(document.createElement("button"));
    button.focus();
    const [result] = await Promise.allSettled([copyText(payload)]);
    expect(result).toEqual(
      ok ? { status: "fulfilled", value: undefined } : { status: "rejected", reason: failure },
    );
    expect(writeText).toHaveBeenCalledExactlyOnceWith(payload);
    expect(fallback).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
    expect(document.querySelector("textarea")).toBeNull();
  },
);
