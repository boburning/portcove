(() => {
  let preference = "system";
  try {
    preference = globalThis.localStorage.getItem("portcove.appearance.theme") || "system";
  } catch {
    /* Storage may be unavailable. */
  }
  const theme =
    preference === "dark" || preference === "light"
      ? preference
      : globalThis.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark";
  globalThis.document.documentElement.dataset.theme = theme;
  globalThis.document.documentElement.style.colorScheme = theme;
})();
