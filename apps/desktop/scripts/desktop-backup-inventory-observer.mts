const backupSectionSelector = '[aria-labelledby="detail-saves-and-storage"]';
export const degradedInventorySelector = `${backupSectionSelector} .backup-history[data-backup-read-state="current"] .backup-inventory-notice.degraded`;

export interface BackupInventoryObserver<Notice> {
  readNotices(): Promise<Notice[]>;
  readProblems(notice: Notice): Promise<unknown[]>;
  wait(
    probe: () => Promise<Notice | false>,
    timeout: number,
    message: string,
  ): Promise<Notice | false>;
}
export function waitForDegradedInventory<Notice>(
  observer: BackupInventoryObserver<Notice>,
  problemCount: number,
) {
  return observer.wait(
    async () => {
      const notices = await observer.readNotices();
      const notice = notices[0];
      if (notices.length !== 1 || notice === undefined) return false;
      const actions = await observer.readProblems(notice);
      return actions.length === problemCount ? notice : false;
    },
    15_000,
    "Fresh degraded backup inventory must finish loading",
  );
}

// Selenium serializes this function, so every input must be passed explicitly.
export function currentDegradedBackupActions(
  noticeSelector: string,
  problemCount: number,
  id: string,
  sha256: string,
) {
  const notices = document.querySelectorAll(noticeSelector);
  const notice = notices[0];
  if (notices.length !== 1 || notice?.querySelectorAll("ul li").length !== problemCount)
    return false;
  const matches = [
    ...(notice.parentElement?.querySelectorAll<HTMLElement>("[data-backup-id]") ?? []),
  ].filter((row) => row.dataset.backupId === id);
  const row = matches[0];
  if (matches.length !== 1 || row?.dataset.backupSha256 !== sha256) return false;
  return ["restore", "delete"].every((action) => {
    const buttons = row.querySelectorAll('button[data-backup-action="' + action + '"]');
    return buttons.length === 1 && buttons[0]?.matches(":enabled");
  });
}
