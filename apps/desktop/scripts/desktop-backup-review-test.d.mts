export const degradedInventorySelector: string;

export function waitForDegradedInventory<T>(
  observer: {
    readNotices: () => Promise<T[]>;
    readProblems: (notice: T) => Promise<unknown[]>;
    wait: (probe: () => Promise<T | false>, timeout: number, message: string) => Promise<T | false>;
  },
  problemCount: number,
): Promise<T | false>;
