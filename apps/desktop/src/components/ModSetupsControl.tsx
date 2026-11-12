import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../api";
import { pickModPackagePath } from "../file-picker";
import type { LiveMods, ModSetupView, ModSetupsView } from "../types";
import { errorText } from "../view-model";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";
import { ActionRow, Notice } from "./ui/patterns";

type Props = {
  portId: string;
  generation: number;
  busy: boolean;
};

/** Thin view of Core-owned mod setups; Core decides support, locks and recovery. */
export function ModSetupsControl(props: Props) {
  return (
    <BoundModSetupsControl key={JSON.stringify([props.portId, props.generation])} {...props} />
  );
}

function nativeListMessage(live: LiveMods | null | undefined): string | undefined {
  const status = live?.native_list;
  switch (status?.state) {
    case "not-written":
      return "Portcove writes this setup's mod order into the game before the next launch.";
    case "reordered":
      return `You reordered mods in the game (${status.native_order.join(", ")}). Portcove keeps that order for this setup.`;
    case "differs":
      return "The game's mod list does not match this setup. Portcove restores this setup's mods and order before the next launch.";
    case "unreadable":
      return "Portcove could not read the game's settings file, so it leaves it unchanged. The game may load mods in its own order.";
    default:
      return undefined;
  }
}

function BoundModSetupsControl({ portId, generation, busy }: Props) {
  const [view, setView] = useState<ModSetupsView>();
  const [error, setError] = useState<string>();
  const [outcome, setOutcome] = useState<string>();
  const [working, setWorking] = useState(false);
  const [request, setRequest] = useState(0);
  // False from a change until the view is read again, so no control acts on a
  // revision the change has replaced.
  const [fresh, setFresh] = useState(true);
  const [copyName, setCopyName] = useState("");
  const copyId = useId();
  const headingId = useId();
  // A picker answer that arrives after this view was replaced is dropped.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (busy) return;
    let current = true;
    void desktopApi.modSetups(portId, generation).then(
      (next) => {
        if (!current) return;
        if (next.port_id !== portId) {
          setError("This game changed. Refresh its details before changing mods.");
          return;
        }
        setView(next);
        setFresh(true);
      },
      (failure: unknown) => {
        if (current) setError(errorText(failure));
      },
    );
    return () => {
      current = false;
    };
  }, [portId, generation, busy, request]);

  const reread = () => {
    setError(undefined);
    setRequest((value) => value + 1);
  };
  // Each change is checked again by Core under its lock; the result is re-read
  // rather than assumed.
  const perform = async (action: () => Promise<unknown>, success: string) => {
    setWorking(true);
    setOutcome(undefined);
    setError(undefined);
    let succeeded = false;
    try {
      await action();
      setOutcome(success);
      succeeded = true;
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setWorking(false);
      setFresh(false);
      setRequest((value) => value + 1);
    }
    return succeeded;
  };

  if (!view && error)
    return (
      <section aria-labelledby={headingId}>
        <h3 id={headingId} className="text-base font-semibold">
          Setups and mods
        </h3>
        <p role="alert">{error}</p>
        <Button variant="outline" onClick={reread}>
          Read setups again
        </Button>
      </section>
    );
  // Games without reviewed mod support show nothing, including while loading.
  if (!view?.supported) return null;
  if (busy) return <p role="status">Finish the current operation before changing mods.</p>;
  const locked = working || !fresh;

  const setups = view.inventory?.profiles ?? [];
  const selectedId = view.live?.profile_id ?? undefined;
  const selected = setups.find((entry) => entry.profile.id === selectedId);
  const nativeMessage = nativeListMessage(view.live);
  const blocked = Boolean(
    view.live && (view.live.unmanaged.length > 0 || view.live.changed_owned.length > 0),
  );

  return (
    <section aria-labelledby={headingId} className="grid gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        Setups and mods
      </h3>
      <p className="text-sm text-pc-muted-foreground">
        A setup is a set of mods with its own saves and settings. Switching setups puts away the
        current setup&rsquo;s saves and settings and brings back the other setup&rsquo;s. Turning a
        mod off removes it from the game&rsquo;s mods folder; its file stays in Portcove so you can
        turn it on again.
      </p>
      {error && <p role="alert">{error}</p>}
      {error && !fresh && !working && (
        <ActionRow>
          <Button variant="outline" onClick={reread}>
            Read setups again
          </Button>
        </ActionRow>
      )}
      {outcome && <p role="status">{outcome}</p>}
      {setups.length === 0 ? (
        <ActionRow>
          <p className="text-sm">
            This game has no setup yet. Your current saves and settings become its first setup.
          </p>
          <Button
            variant="outline"
            disabled={locked}
            onClick={() =>
              void perform(
                () => desktopApi.createDefaultModSetup(portId, generation),
                "Created the first setup from your current saves and settings.",
              )
            }
          >
            Create first setup
          </Button>
        </ActionRow>
      ) : (
        <>
          {blocked && view.live && (
            <Notice intent="warning">
              <div data-slot="notice-body">
                <p>
                  The game&rsquo;s mods folder has files this setup did not add, or files changed
                  outside Portcove. Portcove does not change mods until they are moved or restored,
                  so they are never overwritten.
                </p>
                <ul className="m-0 list-disc ps-5 [overflow-wrap:anywhere]">
                  {[...view.live.unmanaged, ...view.live.changed_owned].map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            </Notice>
          )}
          {nativeMessage && <p className="text-sm">{nativeMessage}</p>}
          <ul aria-label="Setups" className="m-0 grid list-none gap-2 p-0">
            {setups.map((entry) => (
              <SetupRow
                key={entry.profile.id}
                entry={entry}
                inUse={entry.profile.id === selectedId}
                disabled={locked || blocked}
                onUse={() =>
                  void perform(
                    () => desktopApi.useModSetup(portId, entry.profile.id, generation),
                    `Now using ${entry.profile.display_name}.`,
                  )
                }
              />
            ))}
          </ul>
          {selected && (
            <section aria-label={`Mods in ${selected.profile.display_name}`} className="grid gap-2">
              <h4 className="text-sm font-semibold">Mods in {selected.profile.display_name}</h4>
              {(selected.revision.packages ?? []).length === 0 ? (
                <p className="text-sm">No mods. The game plays without changes in this setup.</p>
              ) : (
                <ul className="m-0 grid list-none gap-1 p-0">
                  {inOverrideOrder(selected).map((item) => (
                    <li key={item.native_id}>
                      <label className="flex items-center gap-2 text-sm [overflow-wrap:anywhere]">
                        <Checkbox
                          checked={item.enabled}
                          disabled={locked || blocked}
                          onCheckedChange={(value) =>
                            void perform(
                              () =>
                                desktopApi.setModPackageEnabled(
                                  portId,
                                  selected.profile.id,
                                  item.native_id,
                                  value,
                                  selected.profile.current_revision,
                                  generation,
                                ),
                              value
                                ? `Turned on ${item.native_id}.`
                                : `Turned off ${item.native_id}.`,
                            )
                          }
                        />
                        {item.native_id}
                        {item.provider ? ` (from ${item.provider.provider})` : ""}
                      </label>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-sm text-pc-muted-foreground">
                {view.later_mods_take_priority
                  ? "Later mods in this list take priority when two mods change the same thing."
                  : "The game loads mods in this order."}
              </p>
              <ActionRow>
                <Button
                  variant="outline"
                  disabled={locked || blocked}
                  onClick={() =>
                    void (async () => {
                      const path = await pickModPackagePath(view.package_types);
                      // Closing the picker changes nothing and is not an error, and an
                      // answer for a view that was replaced is dropped.
                      if (typeof path !== "string" || !alive.current) return;
                      await perform(
                        () =>
                          desktopApi.addModPackage(
                            portId,
                            selected.profile.id,
                            path,
                            selected.profile.current_revision,
                            generation,
                          ),
                        `Added a mod to ${selected.profile.display_name}.`,
                      );
                    })()
                  }
                >
                  Add mod file…
                </Button>
              </ActionRow>
              <p className="text-sm text-pc-muted-foreground">
                A copy has the same mods but starts with no saves and the game&rsquo;s default
                settings. Your current setup keeps its own.
              </p>
              <ActionRow>
                <label htmlFor={copyId} className="text-sm">
                  New setup name
                </label>
                <Input
                  id={copyId}
                  className="max-w-64"
                  value={copyName}
                  onValueChange={(value) => setCopyName(value)}
                />
                <Button
                  variant="outline"
                  disabled={locked || copyName.trim() === ""}
                  onClick={() => {
                    const name = copyName.trim();
                    void perform(
                      () => desktopApi.copyModSetup(portId, selected.profile.id, name, generation),
                      `Created ${name} with the same mods, no saves and default settings.`,
                    ).then((created) => {
                      if (created) setCopyName("");
                    });
                  }}
                >
                  Copy this setup
                </Button>
              </ActionRow>
            </section>
          )}
        </>
      )}
    </section>
  );
}

/** Packages in the setup's priority order: the last one wins when two overlap. */
function inOverrideOrder(entry: ModSetupView) {
  const order =
    (entry.revision.orderings ?? []).find((ordering) => ordering.domain === "asset-override")
      ?.native_ids ?? [];
  const rank = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return [...(entry.revision.packages ?? [])].sort(
    (a, b) => rank(a.native_id) - rank(b.native_id) || a.native_id.localeCompare(b.native_id),
  );
}

function SetupRow({
  entry,
  inUse,
  disabled,
  onUse,
}: {
  entry: ModSetupView;
  inUse: boolean;
  disabled: boolean;
  onUse: () => void;
}) {
  const enabled = (entry.revision.packages ?? []).filter((item) => item.enabled).length;
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-pc-md border border-pc-border p-2">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="font-semibold">{entry.profile.display_name}</span>
        <span className="text-sm text-pc-muted-foreground">
          {" "}
          · {enabled === 0 ? "no mods on" : enabled === 1 ? "1 mod on" : `${enabled} mods on`}
        </span>
      </span>
      {inUse ? (
        <span className="text-sm font-semibold">In use</span>
      ) : (
        <Button variant="outline" disabled={disabled} onClick={onUse}>
          Use {entry.profile.display_name}
        </Button>
      )}
    </li>
  );
}
