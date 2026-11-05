import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { gameProjectLabel } from "../../port-identity";
import type { Organization } from "../organization/OrganizationControls";
import type { CatalogEntry } from "./catalog-entry";
import { originalGame } from "./original-game";

export function ownsChoiceFocus(trigger: HTMLElement, owner: HTMLElement | null) {
  return Boolean(
    owner?.isConnected &&
    (document.activeElement === trigger ||
      (!trigger.isConnected && document.activeElement === document.body)),
  );
}

/** An acknowledged Core write establishes persistence; the stable parent owns continuation. */
export function ImplementationChoice({
  port,
  organization,
  onSelected,
}: {
  port: CatalogEntry;
  organization: Organization | undefined;
  onSelected: (trigger: HTMLButtonElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  const mounted = useRef(false);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const game = originalGame(port);
  if (!game) return null;
  const selected = organization?.snapshot?.preferred_port_by_game?.[game.id] === port.id;
  return (
    <div className="grid justify-items-start gap-2">
      <Button
        variant={selected ? "selected" : "outline"}
        size="sm"
        data-focusable
        aria-pressed={selected}
        disabled={!organization?.snapshot || organization.busy || failed}
        focusableWhenDisabled={Boolean(organization?.snapshot && organization.busy)}
        aria-busy={organization?.busy}
        onClick={(event) => {
          if (pending.current || organization?.busy) return;
          const trigger = event.currentTarget;
          pending.current = true;
          setFailed(false);
          void (async () => {
            try {
              const accepted = await organization?.commit({
                kind: "set_preferred_implementation",
                game_id: game.id,
                port_id: port.id,
              });
              if (accepted) onSelected(trigger);
              else if (mounted.current) setFailed(true);
            } finally {
              pending.current = false;
            }
          })();
        }}
      >
        {selected ? "Preferred: " : "Choose "}
        {gameProjectLabel(port) || port.name}
      </Button>
      {failed && (
        <p role="alert">
          Portcove couldn’t confirm that your choice was saved. Refresh choices to check.
        </p>
      )}
      {(failed || organization?.failure === "read") && organization && (
        <Button
          variant="ghost"
          size="sm"
          data-focusable
          onClick={() => {
            void organization.refresh().then((refreshed) => {
              if (refreshed && mounted.current) setFailed(false);
            });
          }}
        >
          Refresh choices
        </Button>
      )}
    </div>
  );
}
