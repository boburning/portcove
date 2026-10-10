# Dated delivery research

Retained September 8 evidence; consult only when investigating those sources.
Current release contracts are in [DELIVERY](../DELIVERY.md).

## Reference verification — 2026-09-08

The repository pins Tauri CLI 2.11.4 and framework 2.11.5 in Cargo.lock.
No updater plugin is installed and createUpdaterArtifacts remains false. The
current Tauri 2 documentation is design guidance; implementation must pin the
maintained plugin and verify its precise native behavior. Apply-on-exit and
free-baseline Gatekeeper/Deck behavior remain qualification questions.

- [SemVer 2.0](https://semver.org/) defines precedence and initial development.
- [Tauri updater](https://v2.tauri.app/plugin/updater/) documents required signatures,
  static feed shape and Windows install modes; [NSIS](https://v2.tauri.app/distribute/windows-installer/),
  [AppImage](https://v2.tauri.app/distribute/appimage/), [Linux signing](https://v2.tauri.app/distribute/sign/linux/),
  [Windows signing](https://v2.tauri.app/distribute/sign/windows/) and
  [macOS ad-hoc signing](https://v2.tauri.app/distribute/sign/macos/) distinguish native paths.
- [Microsoft SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
  and [Apple Gatekeeper](https://support.apple.com/en-us/102445) describe OS enforcement;
  updater authenticity cannot promise to bypass it.
- [Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions),
  [Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits),
  [release limits](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases),
  [immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
  and [release management](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
  support bounded free infrastructure, with availability/usage rechecked at provisioning.
- [Valve Desktop FAQ](https://help.steampowered.com/en/faqs/view/671A-4453-E8D2-323C)
  did not return substantive text to this research client; existing #290 evidence
  is retained and real Gaming Mode proof is still required. [Flatpak permissions](https://docs.flatpak.org/en/latest/sandbox-permissions.html)
  reinforce its separate optional ownership/sandbox qualification.
- [Artifact Signing SKU](https://learn.microsoft.com/en-us/azure/artifact-signing/how-to-change-sku)
  and Microsoft's SmartScreen page list Basic at $9.99/month;
  [Apple membership](https://developer.apple.com/programs/enroll/) lists $99/year
  (about $218.88/year combined before taxes/overages). Reverify eligibility/pricing
  before any future optional purchase. [SignPath Foundation terms](https://signpath.org/terms)
  require manual approval for every release, so it is not the default autonomous path.
