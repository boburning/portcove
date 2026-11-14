import { useState } from "react";
import { desktopApi } from "../api";
import type { StoreGameInstalls } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";

const storeLabels: Record<string, string> = { steam: "Steam", gog: "GOG", epic: "Epic" };

export function storeLabel(store: string) {
  return Object.hasOwn(storeLabels, store) ? storeLabels[store] : "Another store";
}

// Games Steam, GOG and Epic installed on this computer, offered as search
// folders. Core finds them; choosing one only fills the search folder.
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
      {!installs && (
        <div className="actions flex flex-wrap gap-2">
          <Button
            data-focusable
            variant="outline"
            disabled={disabled || loading}
            onClick={() => {
              void load();
            }}
          >
            Choose a Steam, GOG or Epic game
          </Button>
        </div>
      )}
      {loading && <p role="status">Looking for games installed by Steam, GOG or Epic…</p>}
      {error && <p role="alert">{error}</p>}
      {installs && (
        <>
          <p className="text-sm leading-relaxed text-pc-muted-foreground">
            {installs.installs.length === 0
              ? "No games installed by Steam, GOG or Epic were found on this computer."
              : "Choose the game the required files come from. Portcove only reads its folder: you can copy matching files or use them where they are, but not move them out of the game."}
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
