import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { LocalizationProvider } from "../localization";
import { LanguageSettings } from "./LanguageSettings";

const lifecycle = vi.hoisted(() => ({
  props: null as null | {
    triggerId: string;
    disabled: boolean;
    onChange(value: "en"): void;
    onOpenChange(open: boolean, reason: string): void;
    onOpenChangeComplete(open: boolean): void;
  },
  lagDisabled: true,
}));
vi.mock("./ChoiceSelect", () => ({
  ChoiceSelect: (props: NonNullable<typeof lifecycle.props>) => {
    lifecycle.props = props;
    return (
      <button id={props.triggerId} disabled={props.disabled || lifecycle.lagDisabled}>
        Language
      </button>
    );
  },
}));

it("waits for both close completion and the enabled trigger commit", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  let resolveWrite!: (snapshot: { locale: string }) => void;
  const write = new Promise<{ locale: string }>((resolve) => {
    resolveWrite = resolve;
  });
  try {
    await act(async () =>
      root.render(
        <LocalizationProvider
          api={{
            localePreference: vi.fn().mockResolvedValue({ locale: null }),
            setLocalePreference: vi.fn().mockReturnValue(write),
          }}
        >
          <LanguageSettings />
        </LocalizationProvider>,
      ),
    );
    const trigger = host.querySelector("button")!;
    const focus = vi.spyOn(trigger, "focus");
    await act(async () => {
      lifecycle.props!.onOpenChange(true, "trigger-press");
      lifecycle.props!.onChange("en");
      lifecycle.props!.onOpenChange(false, "item-press");
    });
    await act(async () => resolveWrite({ locale: "en" }));
    expect(lifecycle.props!.disabled).toBe(false);
    expect(focus).not.toHaveBeenCalled();
    await act(async () => lifecycle.props!.onOpenChangeComplete(false));
    expect(trigger.disabled).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    // The child store commits its enabled state after the parent's save/close effects.
    await act(async () => {
      trigger.disabled = false;
    });
    expect(document.activeElement).toBe(trigger);
    expect(focus).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
