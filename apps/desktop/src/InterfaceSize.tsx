import { RotateCcw } from "lucide-react";
import { Icon } from "./components/ui";
import { Tooltip } from "./components/ui/tooltip";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useAppTranslation } from "./localization";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { ChoiceSelect } from "./components/ChoiceSelect";
import { Button } from "./components/ui/button";
import { Notice, SettingsRow } from "./components/ui/patterns";
import { commandShortcut } from "./keyboard-shortcuts";
import { InterfaceSizeController, INTERFACE_SIZES } from "./interface-size-controller";

const InterfaceSizeContext = createContext<InterfaceSizeController | undefined>(undefined);

async function applyNativeZoom(factor: number) {
  if (!isTauri()) {
    if (factor === 1) return;
    throw new Error("Whole-interface enlargement requires the desktop WebView");
  }
  await getCurrentWebview().setZoom(factor);
}

export function InterfaceSizeProvider({
  children,
  controller,
}: {
  children: ReactNode;
  controller?: InterfaceSizeController;
}) {
  const [owner] = useState(
    () => controller ?? new InterfaceSizeController(applyNativeZoom, () => window.localStorage),
  );
  const { t } = useAppTranslation("shell");
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  useEffect(() => {
    owner.start();
    const keydown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.altKey ||
        !(event.ctrlKey || event.metaKey)
      )
        return;
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        owner.step(1);
      } else if (event.key === "-") {
        event.preventDefault();
        owner.step(-1);
      } else if (event.key === "0") {
        event.preventDefault();
        owner.request(100);
      }
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [owner]);
  return (
    <InterfaceSizeContext value={owner}>
      <div className="interface-root flex h-full min-h-0 flex-col">
        {state.error && (
          <Notice intent="warning" role="alert" className="shrink-0">
            <div data-slot="notice-body">
              <p>{t("interfaceSize.unconfirmed", { ratio: 1 })}</p>
              <Button variant="outline" onClick={() => owner.request(100)}>
                {t("interfaceSize.resetAction")}
              </Button>
              <Button variant="ghost" onClick={owner.dismissError}>
                {t("interfaceSize.dismiss")}
              </Button>
            </div>
          </Notice>
        )}
        <div className="interface-workspace min-h-0 flex-1">{children}</div>
        <p role="status" className="sr-only">
          {state.error
            ? t("interfaceSize.unconfirmedStatus", { ratio: 1 })
            : state.pending
              ? t("interfaceSize.applying", { ratio: state.requested / 100 })
              : state.sessionOnly
                ? t("interfaceSize.appliedSessionOnly", { ratio: state.applied / 100 })
                : t("interfaceSize.applied", { ratio: state.applied / 100 })}
        </p>
      </div>
    </InterfaceSizeContext>
  );
}

export function InterfaceSizeSettings() {
  const owner = useContext(InterfaceSizeContext);
  return owner ? <InterfaceSizeControl owner={owner} /> : null;
}

function InterfaceSizeControl({ owner }: { owner: InterfaceSizeController }) {
  const { t } = useAppTranslation("shell");
  const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
  return (
    <SettingsRow className="settings-field-row" data-focus-group>
      <div className="settings-field-copy">
        <h3>{t("interfaceSize.title")}</h3>
        <p>{t("interfaceSize.description")}</p>
        <p>
          {t("interfaceSize.shortcuts", {
            enlarge: commandShortcut("+"),
            reduce: commandShortcut("−"),
            reset: commandShortcut("0"),
          })}
        </p>
        {state.sessionOnly && <p>{t("interfaceSize.sessionOnly")}</p>}
      </div>
      <div className="settings-field-control settings-size-controls">
        <ChoiceSelect
          inline
          showInlineLabel={false}
          label={t("interfaceSize.title")}
          value={String(state.requested)}
          onChange={(value) => owner.request(Number(value))}
          options={INTERFACE_SIZES.map((size) => ({
            value: String(size),
            label: t("interfaceSize.value", { ratio: size / 100 }),
          }))}
        />
        <Tooltip
          label={t("interfaceSize.resetWithShortcut", { ratio: 1, shortcut: commandShortcut("0") })}
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("interfaceSize.reset", { ratio: 1 })}
            onClick={() => owner.request(100)}
          >
            <Icon glyph={RotateCcw} />
          </Button>
        </Tooltip>
      </div>
    </SettingsRow>
  );
}
