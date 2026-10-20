export const INTERFACE_SIZES = [100, 125, 150, 175, 200, 250, 300, 400] as const;
export type InterfaceSize = (typeof INTERFACE_SIZES)[number];
export const INTERFACE_SIZE_KEY = "portcove.appearance.interface-size";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export type InterfaceSizeSnapshot = {
  applied: InterfaceSize;
  requested: InterfaceSize;
  pending: boolean;
  error: string | undefined;
  sessionOnly: boolean;
};

export function isInterfaceSize(value: number): value is InterfaceSize {
  return INTERFACE_SIZES.some((size) => size === value);
}

export function readInterfaceSize(storage: () => PreferenceStorage): InterfaceSize {
  try {
    const value = Number(storage().getItem(INTERFACE_SIZE_KEY));
    return isInterfaceSize(value) ? value : 100;
  } catch {
    return 100;
  }
}

// One WebView owner serializes native calls. Pending intent is ephemeral; only
// a successful native application may become the profile preference.
export class InterfaceSizeController {
  private snapshot: InterfaceSizeSnapshot = {
    applied: 100,
    requested: 100,
    pending: false,
    error: undefined,
    sessionOnly: false,
  };
  private listeners = new Set<() => void>();
  private next: InterfaceSize | undefined;
  private running = false;
  private started = false;
  private applyZoom: (factor: number) => Promise<void>;
  private storage: () => PreferenceStorage;

  constructor(applyZoom: (factor: number) => Promise<void>, storage: () => PreferenceStorage) {
    this.applyZoom = applyZoom;
    this.storage = storage;
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private publish(change: Partial<InterfaceSizeSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.request(readInterfaceSize(this.storage));
  }

  request(value: number) {
    if (!isInterfaceSize(value)) return;
    this.next = value;
    this.publish({ requested: value, pending: true, error: undefined });
    if (!this.running) void this.drain();
  }

  step(direction: -1 | 1) {
    const index = INTERFACE_SIZES.indexOf(this.snapshot.requested);
    this.request(
      INTERFACE_SIZES[Math.max(0, Math.min(INTERFACE_SIZES.length - 1, index + direction))]!,
    );
  }

  dismissError = () => this.publish({ error: undefined });

  private async drain() {
    this.running = true;
    while (this.next !== undefined) {
      const value = this.next;
      this.next = undefined;
      try {
        await this.applyZoom(value / 100);
        let sessionOnly = false;
        try {
          this.storage().setItem(INTERFACE_SIZE_KEY, String(value));
        } catch {
          sessionOnly = true;
        }
        this.publish({ applied: value, sessionOnly, error: undefined });
      } catch {
        this.publish({
          error: "Interface size could not be confirmed. Try again or reset to 100%.",
        });
      }
      this.publish({
        requested: this.next ?? this.snapshot.applied,
        pending: this.next !== undefined,
      });
    }
    this.running = false;
  }
}
