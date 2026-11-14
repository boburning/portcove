import { useState } from "react";
import { desktopApi } from "../api";
import type { StoreGameInstalls } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";

const storeLabels: Record<string, string> = { steam: "Steam", gog: "GOG", epic: "Epic" };
const allStores = ["steam", "gog", "epic"];

export function storeLabel(store: string) {
  return Object.hasOwn(storeLabels, store) ? storeLabels[store] : "Another store";
}

function storeList(stores: readonly string[]) {
  const labels = stores.map(storeLabel);
  if (labels.length <= 1) return labels.join("");
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
}

// What Core read, kept distinct from what it could not read on this system.
export function storeInstallsSummary(installs: StoreGameInstalls) {
  const checked = installs.checked_stores;
  const unchecked = allStores.filter((store) => !checked.some((value) => value === store));
  const notChecked =
    unchecked.length > 0
      ? ` Portcove can't check ${storeList(unchecked)} games on this system.`
      : "";
  if (checked.length === 0) return "Portcove can't check Steam, GOG or Epic games on this system.";
  if (installs.installs.length === 0)
    return `No games installed by ${storeList(checked)} were found on this computer.${notChecked}`;
  return `Choose the game the required files come from. Portcove only reads its folder: you can copy matching files or use them where they are, but not move them out of the game.${notChecked}`;
}

// Games the stores installed on this computer, offered as search folders.
// Core finds them; choosing one only fills the search folder.
export function StoreInstallChoices({
  generation,
  disabled,
  onChoose,
}: {
  generation: number;
  disabled: boolean;
  onChoose: (path: string) => void;
}) {
  const [installs, setInstalls] = useState<StoreGameInstalls>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const load = async () => {
    setLoading(true);
    setError(undefined);
    try {
      setInstalls(await desktopApi.storeGameInstalls(generation));
    } catch (value) {
      setError(`Portcove couldn't list installed games. ${errorText(value)}`);
    } finally {
      setLoading(false);
    }
  };
  return (
    <section aria-label="Games installed by Steam, GOG or Epic" className="grid gap-2">
      <div className="actions flex flex-wrap gap-2">
        <Button
          data-focusable
          variant="outline"
          disabled={disabled || loading}
          onClick={() => {
            void load();
          }}
        >
          {installs || error ? "Check installed games again" : "Choose a Steam, GOG or Epic game"}
        </Button>
      </div>
      {loading && <p role="status">Looking for games installed by Steam, GOG or Epic…</p>}
      {error && <p role="alert">{error}</p>}
      {installs && (
        <>
          <p className="text-sm leading-relaxed text-pc-muted-foreground">
            {storeInstallsSummary(installs)}
          </p>
          {(installs.limited || installs.skipped_entries > 0) && (
            <p className="text-sm leading-relaxed text-pc-muted-foreground">
              Some installed games may be missing from this list.
            </p>
          )}
          {installs.installs.length > 0 && (
            <ul className="grid max-h-64 gap-1 overflow-y-auto" aria-label="Installed games">
              {installs.installs.map((install) => (
                <li
                  key={install.path}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-pc-border py-2"
                >
                  <div className="min-w-0">
                    <strong>{install.title}</strong> · {storeLabel(install.store)}
                    <code className="block overflow-hidden bg-transparent p-0 [overflow-wrap:anywhere] whitespace-normal text-pc-muted-foreground">
                      {install.path}
                    </code>
                  </div>
                  <Button
                    data-focusable
                    variant="outline"
                    disabled={disabled}
                    aria-label={`Choose the ${install.title} folder (${storeLabel(install.store)})`}
                    onClick={() => onChoose(install.path)}
                  >
                    Choose this folder
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
