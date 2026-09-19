import { listen } from "@tauri-apps/api/event";
import type { DesktopEventPayloads } from "./types";

export function listenDesktopEvent<Name extends keyof DesktopEventPayloads>(
  name: Name,
  accept: (payload: DesktopEventPayloads[Name]) => void,
) {
  return listen<DesktopEventPayloads[Name]>(name, (event) => accept(event.payload));
}
