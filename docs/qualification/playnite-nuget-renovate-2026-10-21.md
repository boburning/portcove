# Playnite NuGet automation investigation — 2026-10-21

Owning issue: [#1361](https://github.com/boburning/portcove/issues/1361).
Inspected Portcove source: `529a8416002fa2d47c1bb368f71522672fb37e48`.

## Decision

Retain manual reviewed package maintenance through Visual Studio MSBuild for the
two Playnite projects. Keep the existing project form, runtime, declarations,
locks and Renovate configuration. This uses the issue's explicit unsupported-route
decision: successful XML extraction does not establish a supported hosted lock
update. The stable procedure and resumption conditions are in the
[Playnite maintenance guide](../../integrations/playnite/README.md#build-package-maintenance).

Renovate's [NuGet manager documentation](https://docs.renovatebot.com/modules/manager/nuget/#additional-information),
observed for version 44.175.2, requires SDK-style files for supported .NET Framework
projects. Portcove's projects use `ToolsVersion="15.0"`, the MSBuild 2003 XML
namespace, `TargetFrameworkVersion` `v4.6.2`, `LangVersion` `7.3` and ordinary
`PackageReference` elements. Microsoft documents
[PackageReference support in .NET Framework](https://learn.microsoft.com/en-us/nuget/consume-packages/package-references-in-project-files#project-type-support);
that alone does not establish Renovate artifact compatibility.

## Executed extraction

The official npm package `renovate@44.175.2` ran locally on Linux x64 with Node
24.22.0 and RE2 1.27.0, against disposable byte-identical copies
of these four source files. The final extraction ran at `2026-10-21T14:01:11.199Z`.
The engine's own `matchRegexOrGlob` evaluated its NuGet default file patterns;
its unmodified `extractPackageFile` read each project with `GlobalConfig.localDir`
set to the copied fixture. No registry lookup or package update was needed. The
[issue fixture record](https://github.com/boburning/portcove/issues/1361#issuecomment-6318007232)
retains the exact output, controls, setup warning and configuration result.

| Project                                            | Extracted dependencies (`datasource` and `depType`: `nuget`)                        | Discovered sibling lock                          |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------ |
| `integrations/playnite/Portcove.Playnite.csproj`   | `PlayniteSDK` `6.15.0`; `Microsoft.NETFramework.ReferenceAssemblies.net462` `1.0.3` | `integrations/playnite/packages.lock.json`       |
| `integrations/playnite/tests/ContractTests.csproj` | `PlayniteSDK` `6.15.0`; `Microsoft.NETFramework.ReferenceAssemblies.net462` `1.0.3` | `integrations/playnite/tests/packages.lock.json` |

Both projects matched the default file patterns. For each project, a negative
control temporarily removed only its copied sibling lock: both dependencies
remained detectable and `lockFiles` was absent. Restoring the copied lock
restored the original fixture bytes. Source and final fixture hashes matched.
This establishes extraction and sibling-file detection, including their
boundary; the extractor does not validate a restore or regenerate a lock.

The unchanged repository configuration also passed the official 44.175.2
configuration validator with `--no-global --strict`. Initial installation had disabled package install
scripts, leaving RE2 unavailable; the validator reported a RegExp fallback.
After provisioning only the installed RE2 dependency, extraction and the
validator passed again with RE2 available and no fallback warning. The earlier
warning remains in the investigation evidence.

| Input at the inspected source | SHA-256                                                            |
| ----------------------------- | ------------------------------------------------------------------ |
| Client project                | `e05c3c5cfdc263f14e56725a63ac1d080cdfb6bb3cc670f42e762d87f8a689f8` |
| Client lock                   | `e5db8f8773d024a04e0968cc09539b6d379283cf165e5099541285af1b4c67f7` |
| Contract-test project         | `b42cbe41da23ce5638f7ec0f2f6b05bc32d131a4c9637f9ec5898b5eebc9b452` |
| Contract-test lock            | `e5db8f8773d024a04e0968cc09539b6d379283cf165e5099541285af1b4c67f7` |

The npm tarball integrity was
`sha512-kW4TOrLMHOm2mrt8uTA9h4yGkdmV3cMTsuj3QrtYJFWoRMmm9igXUgW0ZAvWd8VfdujgDqT3WdFgk12eG2PFmw==`.
Its compiled extractor SHA-256 was
`bf0c3b34804265fb2597220db48658bca8b61a5cebf8c7118cab5d7e95c6c879`;
compiled artifact updater SHA-256 was
`91dabeab78e500336fa600a1bcddb12ee198503c8c9c0f1a1285582fce994ae7`.

## Artifact boundary and hosted readback

The exact upstream
[extractor](https://github.com/renovatebot/renovate/blob/44.175.2/lib/modules/manager/nuget/extract.ts)
has Git blob `076c4b593ce8e3378330032326e391e24d05048d`. It recognizes these XML
elements and reports a sibling lock when that path exists. The
[artifact updater](https://github.com/renovatebot/renovate/blob/44.175.2/lib/modules/manager/nuget/artifacts.ts),
blob `a9d37b1b676164eb2c1c62d318f98e2485a9fcb2`, chooses dependent project files
and executes `dotnet restore` with `--force-evaluate` and a generated NuGet
configuration. It does not select Portcove's full Visual Studio MSBuild route.
This source inspection and the documented project-form boundary support the
decision; they are not a recorded runtime failure for every classic project.

The actual [hosted dependency dashboard](https://github.com/boburning/portcove/issues/710),
read on 2026-10-21 with `updated_at` `2026-10-21T13:30:40Z`, listed
PSScriptAnalyzer through `custom.regex` but contained no Playnite project or
ReferenceAssemblies entry. Its body SHA-256 was
`4a46c505a735ffa460a9902596a99b48322b3c53ad50d2357a83818a6edddce3`.
The inspected `renovate.json` excludes the `nuget` manager; the existing custom
NuGet datasource is limited to the PowerShell resource file. The dashboard does
not disclose the hosted engine version. Version 44.175.2 identifies this local
investigation and upstream source, not an inferred hosted deployment.

No hosted Playnite proposal, lock regeneration or Windows MSBuild execution is
claimed. The current Playnite locked build belongs to the qualification-only CI
job; a documentation-only ordinary baseline cannot establish that result. No
runtime package, publication authority or automatic-merge behavior changes.

## Revisit condition

Resume when there is supported classic-project artifact handling to test, or a
separately authorized and justified project migration. A future adoption must
show the actual narrow hosted proposal, both regenerated locks and the existing
locked MSBuild checks. Existing dependency review protections remain applicable.
The investigation does not require a project migration or create another package
pin inventory.
