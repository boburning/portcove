use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::{AdapterKind, Platform, PortDefinition, PortcoveError, ReleaseSource, Result};

const MAX_TERMS: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ReviewedLaunchContractV1 {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub asset_rules: BTreeMap<Platform, AssetRules>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub package_format: BTreeMap<Platform, PackageFormat>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub launch: BTreeMap<Platform, LaunchValues>,
    /// Optional restatement of the environment name prefix derived from the
    /// port ID: its ASCII letters and digits, uppercased, followed by `_`. A
    /// stem over 32 characters keeps its first 24 characters followed by the
    /// first 8 uppercase hexadecimal digits of the SHA-256 of the port ID. Any
    /// other value is refused.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub environment_prefix: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AssetRules {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub include: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub exclude: Vec<String>,
    /// An exact tag or a literal tag prefix ending in a single asterisk.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tag_pattern: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prerelease: Option<PrereleaseRule>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum PrereleaseRule {
    Flag,
    Markers,
    Never,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub enum PackageFormat {
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "tar.gz")]
    TarGzip,
    #[serde(rename = "tar.xz")]
    TarXz,
    #[serde(rename = "7z")]
    SevenZip,
}

impl PackageFormat {
    pub(crate) fn matches(self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        match self {
            Self::Zip => name.ends_with(".zip"),
            Self::TarGzip => name.ends_with(".tar.gz") || name.ends_with(".tgz"),
            Self::TarXz => name.ends_with(".tar.xz"),
            Self::SevenZip => name.ends_with(".7z"),
        }
    }

    pub(crate) fn matches_magic(self, magic: &[u8]) -> bool {
        match self {
            Self::Zip => magic.starts_with(b"PK\x03\x04") || magic.starts_with(b"PK\x05\x06"),
            Self::TarGzip => magic.starts_with(b"\x1f\x8b\x08"),
            Self::TarXz => magic.starts_with(b"\xfd7zXZ\0"),
            Self::SevenZip => magic.starts_with(b"7z\xbc\xaf\x27\x1c"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LaunchValues {
    /// Replaces the declaration's static argument list before adapter arguments.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Vec<LaunchValue>>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, LaunchValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum LaunchValue {
    Text(String),
    Path(LaunchPathValue),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct LaunchPathValue {
    pub path: crate::launch_paths::LaunchPath,
}

impl AssetRules {
    pub(crate) fn tag_matches(&self, tag: &str) -> bool {
        self.tag_pattern.as_deref().is_none_or(|pattern| {
            pattern
                .strip_suffix('*')
                .map_or(tag == pattern, |prefix| tag.starts_with(prefix))
        })
    }
}

impl LaunchValue {
    pub(crate) fn resolve(&self, paths: &crate::launch_paths::LaunchPaths<'_>) -> Result<String> {
        match self {
            Self::Text(text) => Ok(text.clone()),
            Self::Path(value) => paths.expand(value.path),
        }
    }
}

pub(crate) fn validate(port: &PortDefinition) -> Result<()> {
    let Some(contract) = &port.reviewed_launch_contract_v1 else {
        return Ok(());
    };
    if port.adapter != AdapterKind::NativePortable
        || port.release.provider != ReleaseSource::Github
        || !port.bundled_runtime.is_empty()
        || !port.release.managed_build.is_empty()
    {
        return Err(invalid(
            "named package and launch declarations require a native GitHub runtime",
        ));
    }
    for (&platform, rules) in &contract.asset_rules {
        if !port.platforms.contains(&platform)
            || port.release.curated.contains_key(&platform)
            || port.release.reviewed_package_choices_v2.is_some()
            || port.release.direct.contains_key(&platform)
            || (rules.include.is_empty()
                && rules.exclude.is_empty()
                && rules.tag_pattern.is_none()
                && rules.prerelease.is_none())
            || rules.include.len() > MAX_TERMS
            || rules.exclude.len() > MAX_TERMS
            || rules
                .include
                .iter()
                .chain(&rules.exclude)
                .any(|term| !valid_term(term))
            || rules
                .tag_pattern
                .as_ref()
                .is_some_and(|tag| !valid_term(tag.strip_suffix('*').unwrap_or(tag)))
        {
            return Err(invalid("invalid or conflicting reviewed asset rule"));
        }
    }
    for &platform in contract.package_format.keys() {
        if !port.platforms.contains(&platform)
            || port.release.requires_tar_xz(platform)
            || port.release.curated.contains_key(&platform)
            || port.release.reviewed_package_choices_v2.is_some()
            || port.external_profile_policy.is_some()
        {
            return Err(invalid("invalid or conflicting reviewed package format"));
        }
    }
    let derived_prefix = derived_environment_prefix(&port.id);
    if let Some(stated) = &contract.environment_prefix
        && Some(stated) != derived_prefix.as_ref()
    {
        return Err(invalid(
            "the reviewed environment prefix differs from the one derived from the port ID",
        ));
    }
    for (&platform, launch) in &contract.launch {
        let value_safe = |value: &LaunchValue| match value {
            LaunchValue::Text(text) => crate::launch_paths::is_contract_launch_text(text),
            LaunchValue::Path(path) => {
                path.path != crate::launch_paths::LaunchPath::Source
                    || port.source_profile.is_some()
            }
        };
        if !port.platforms.contains(&platform)
            || (launch.arguments.is_none() && launch.environment.is_empty())
            || port.managed_initialization.is_some()
            || launch.arguments.as_ref().is_some_and(|args| {
                args.len() > 64
                    || args.iter().any(|arg| !value_safe(arg))
                    || !port.launch_arguments.is_empty()
            })
            || launch.environment.len() > 32
            || launch.environment.iter().any(|(name, value)| {
                !contract_environment_name_allowed(name, derived_prefix.as_deref())
                    || port.launch_environment.contains_key(name)
                    || port.source_environment.as_ref() == Some(name)
                    || port.user_data_environment.as_ref() == Some(name)
                    || !value_safe(value)
            })
        {
            return Err(invalid("invalid or conflicting typed launch value"));
        }
    }
    if let Some(prefix) = &contract.environment_prefix
        && (!valid_environment_prefix(prefix)
            || !contract.launch.values().any(|launch| {
                launch
                    .environment
                    .keys()
                    .any(|name| name.starts_with(prefix.as_str()))
            }))
    {
        return Err(invalid("invalid or unused reviewed environment prefix"));
    }
    if contract.asset_rules.is_empty()
        && contract.package_format.is_empty()
        && contract.launch.is_empty()
    {
        return Err(invalid("empty named package and launch declaration"));
    }
    Ok(())
}

/// Reviewed harmless names a contract may set without its declared prefix.
/// Each is used by existing catalog data and only switches a behavior off.
const HARMLESS_ENVIRONMENT_NAMES: &[&str] = &[crate::process::PYTHON_NO_BYTECODE];

/// Title-family prefixes of runtimes, graphics drivers, platforms, toolkits and
/// tools that are not loader prefixes themselves but are not title-specific
/// either, so a contract cannot declare them (or a prefix overlapping them).
const NON_TITLE_PREFIXES: &[&str] = &[
    "PORTCOVE_",
    "SDL",
    "MESA_",
    "GALLIUM_",
    "RADV_",
    "AMD_",
    "NVIDIA_",
    "__NV_",
    "INTEL_",
    "DXVK_",
    "VKD3D_",
    "D3D",
    "DXGI_",
    "WGL_",
    "GLX_",
    "ANGLE_",
    "ZINK_",
    "PROTON_",
    "STEAM",
    "XDG_",
    "DBUS_",
    "PULSE_",
    "PIPEWIRE_",
    "ALSA_",
    "ALSOFT_",
    "OPENAL",
    "FONTCONFIG_",
    "FREETYPE_",
    "XCURSOR_",
    "XKB_",
    "WAYLAND_",
    "DISPLAY",
    "GLIB_",
    "GNOME_",
    "KDE_",
    "RUST_",
    "CARGO_",
    "GIT_",
    "MSYS",
    "CYGWIN",
    "SYSTEMD_",
    "CHROME_",
    "CEF_",
    "GODOT_",
    "UNITY_",
    "LOVE_",
    "AWS_",
    "AZURE_",
    "GOOGLE_",
    "SSH_",
    "GPG_",
    "GNUPG",
    "KRB5",
    "TEMP",
    "TMP",
    "HOME",
    "USER",
    "WINDIR",
    "SYSTEM",
    "PROGRAM",
    "APPDATA",
    "LOCALAPPDATA",
    "COMMON",
];

/// The bound on the stem of a derived environment prefix.
pub(crate) const MAX_PREFIX_STEM: usize = 32;
/// The characters a shortened stem keeps before its digest suffix.
const SHORTENED_STEM_KEEP: usize = 24;

/// The environment name prefix derived from a port ID. The stem is the ID's
/// ASCII letters and digits, uppercased, in order (`blacklabelhq-medievilrecomp`
/// becomes `BLACKLABELHQMEDIEVILRECOMP_`). A stem longer than
/// [`MAX_PREFIX_STEM`] keeps its first 24 characters followed by the first 8
/// uppercase hexadecimal digits of the SHA-256 of the port ID, so long IDs
/// sharing a start stay distinct. One `_` follows. It is `None`, and the
/// contract may declare no environment entry except a harmless name, when the
/// derivation is not a [`valid_environment_prefix`]: a stem shorter than three
/// characters, a stem starting with a digit, or one that overlaps a reserved
/// runtime, loader or non-title prefix.
pub(crate) fn derived_environment_prefix(port_id: &str) -> Option<String> {
    use sha2::Digest;
    let mut stem = port_id
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|character| character.to_ascii_uppercase())
        .collect::<String>();
    if stem.len() > MAX_PREFIX_STEM {
        stem.truncate(SHORTENED_STEM_KEEP);
        stem.push_str(
            &hex::encode_upper(sha2::Sha256::digest(port_id.as_bytes()))
                [..MAX_PREFIX_STEM - SHORTENED_STEM_KEEP],
        );
    }
    let prefix = format!("{stem}_");
    valid_environment_prefix(&prefix).then_some(prefix)
}

/// A contract environment name is accepted only when it is title-specific by
/// construction: it is one of [`HARMLESS_ENVIRONMENT_NAMES`], or it starts
/// with the prefix derived from the port ID and continues after it. Every
/// accepted name also passes the shared catalog name check (uppercase syntax,
/// no `PORTCOVE_`, credential, session or loader-injection name).
fn contract_environment_name_allowed(name: &str, prefix: Option<&str>) -> bool {
    crate::catalog::is_safe_environment_name(name)
        && (HARMLESS_ENVIRONMENT_NAMES.contains(&name)
            || prefix.is_some_and(|prefix| {
                valid_environment_prefix(prefix)
                    && name.len() > prefix.len()
                    && name.starts_with(prefix)
            }))
}

/// A prefix is an uppercase stem of 3 to [`MAX_PREFIX_STEM`] ASCII letters and
/// digits, starting with a letter and ending in one `_`, that neither starts
/// with nor is the start of a loader-injection prefix or a non-title prefix.
fn valid_environment_prefix(prefix: &str) -> bool {
    let Some(stem) = prefix.strip_suffix('_') else {
        return false;
    };
    (3..=MAX_PREFIX_STEM).contains(&stem.len())
        && stem.starts_with(|character: char| character.is_ascii_uppercase())
        && stem
            .chars()
            .all(|character| character.is_ascii_uppercase() || character.is_ascii_digit())
        && !crate::process::LOADER_INJECTION_PREFIXES
            .iter()
            .chain(NON_TITLE_PREFIXES)
            .any(|reserved| prefix.starts_with(reserved) || reserved.starts_with(prefix))
}

fn valid_term(term: &str) -> bool {
    !matches!(term, "" | "." | "..")
        && term.len() <= 128
        && term
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

fn invalid(message: &str) -> PortcoveError {
    PortcoveError::verification(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract_port(prefix: Option<&str>, launch: LaunchValues) -> PortDefinition {
        let platform = Platform::WindowsX86_64;
        let mut port = crate::Catalog::embedded()
            .unwrap()
            .ports()
            .iter()
            .find(|port| port.release.provider == ReleaseSource::Github)
            .unwrap()
            .clone();
        port.id = "fixture-title".into();
        port.adapter = AdapterKind::NativePortable;
        port.platforms = vec![platform];
        port.bundled_runtime.clear();
        port.release.managed_build.clear();
        port.release.curated.clear();
        port.release.direct.clear();
        port.managed_initialization = None;
        port.launch_arguments.clear();
        port.launch_environment.clear();
        port.source_environment = None;
        port.user_data_environment = None;
        port.reviewed_launch_contract_v1 = Some(ReviewedLaunchContractV1 {
            asset_rules: BTreeMap::new(),
            package_format: BTreeMap::new(),
            launch: [(platform, launch)].into(),
            environment_prefix: prefix.map(str::to_owned),
        });
        port
    }

    fn environment(prefix: Option<&str>, name: &str, value: LaunchValue) -> PortDefinition {
        contract_port(
            prefix,
            LaunchValues {
                arguments: None,
                environment: [(name.to_owned(), value)].into(),
            },
        )
    }

    fn argument(value: &str) -> PortDefinition {
        contract_port(
            None,
            LaunchValues {
                arguments: Some(vec![text(value)]),
                environment: BTreeMap::new(),
            },
        )
    }

    fn text(value: &str) -> LaunchValue {
        LaunchValue::Text(value.into())
    }

    /// The prefix derived from the fixture port ID `fixture-title`.
    const PREFIX: Option<&str> = Some("FIXTURETITLE_");
    const NAME: &str = "FIXTURETITLE_SETTING";

    #[test]
    fn derived_title_prefix_and_harmless_names_are_the_only_accepted_names() {
        for value in [
            text("1"),
            text("data"),
            text("profile:fast"),
            LaunchValue::Path(LaunchPathValue {
                path: crate::launch_paths::LaunchPath::InstallRoot,
            }),
        ] {
            // The derived prefix applies whether the contract restates it or not.
            for prefix in [None, PREFIX] {
                validate(&environment(prefix, NAME, value.clone()))
                    .unwrap_or_else(|error| panic!("{value:?}: {error:?}"));
            }
        }
        validate(&environment(None, "PYTHONDONTWRITEBYTECODE", text("1"))).unwrap();
        // A restated prefix must be used by a name.
        validate(&environment(PREFIX, "PYTHONDONTWRITEBYTECODE", text("1"))).unwrap_err();
        // Any stated prefix other than the derivation is refused, even when
        // the names would otherwise be well formed under it.
        for stated in ["FIXTURE_", "FIXTURETITLE2_", "OTHER_", "fixturetitle_", ""] {
            validate(&environment(
                Some(stated),
                &format!("{stated}SETTING"),
                text("1"),
            ))
            .unwrap_err();
            validate(&environment(Some(stated), NAME, text("1"))).unwrap_err();
        }
        // A title-looking name outside the derived prefix is refused.
        for name in ["FIXTURE_SETTING", "FIXTURETITLESETTING", "TITLE_SETTING"] {
            validate(&environment(None, name, text("1"))).unwrap_err();
        }
        // The prefix alone is not a name.
        validate(&environment(None, "FIXTURETITLE_", text("1"))).unwrap_err();
        validate(&argument("--fixture")).unwrap();
        let mut unused = argument("--fixture");
        unused
            .reviewed_launch_contract_v1
            .as_mut()
            .unwrap()
            .environment_prefix = PREFIX.map(str::to_owned);
        validate(&unused).unwrap_err();
    }

    #[test]
    fn the_prefix_is_derived_deterministically_from_the_port_id() {
        for (id, expected) in [
            (
                "blacklabelhq-medievilrecomp",
                Some("BLACKLABELHQMEDIEVILRECOMP_"),
            ),
            ("fixture-title", Some("FIXTURETITLE_")),
            ("dkc2-recomp", Some("DKC2RECOMP_")),
            (
                "touhou-4-lotus-land-story-portable64",
                Some("TOUHOU4LOTUSLANDSTORYPORTABLE64_"),
            ),
            // Exactly 32 characters stay whole.
            (
                "abcdefghij-abcdefghij-abcdefghij-ab",
                Some("ABCDEFGHIJABCDEFGHIJABCDEFGHIJAB_"),
            ),
            // Longer stems keep 24 characters and 8 digest digits of the ID.
            (
                "abcdefghij-abcdefghij-abcdefghij-abcdefghij",
                Some("ABCDEFGHIJABCDEFGHIJABCDCEBB1028_"),
            ),
            (
                "vyruz-destruction-of-the-untel-empire-openvyruz",
                Some("VYRUZDESTRUCTIONOFTHEUNTC70BED05_"),
            ),
            (
                "vyruz-destruction-of-the-untel-empire-vurus",
                Some("VYRUZDESTRUCTIONOFTHEUNT61E69DB3_"),
            ),
            // Too short, digit-first or colliding with a reserved runtime,
            // loader or non-title prefix: no environment entries.
            ("ab", None),
            ("a-b", None),
            ("2ship2harkinian", None),
            ("lua-game", None),
            ("webview2-host", None),
            ("tcl-game", None),
            ("sdl-port", None),
            ("python-game", None),
            ("mesa-demo", Some("MESADEMO_")),
            ("steam-title", None),
            ("dotnet-game", Some("DOTNETGAME_")),
            ("temple-run", None),
            ("homebrew-game", None),
            ("luarocks-fixture", None),
            // A reserved prefix ending in `_` covers only names with that
            // separator, so a longer derived stem stays distinct from it.
            ("obs-plugin", Some("OBSPLUGIN_")),
            ("portcove-fixture", Some("PORTCOVEFIXTURE_")),
        ] {
            assert_eq!(derived_environment_prefix(id).as_deref(), expected, "{id}");
        }
        // A port whose derivation is reserved gets no environment entries,
        // whether or not the contract states the colliding prefix.
        for (id, stated) in [("lua-game", "LUAGAME_"), ("sdl-port", "SDLPORT_")] {
            let mut port = environment(None, &format!("{stated}SETTING"), text("1"));
            port.id = id.into();
            validate(&port).unwrap_err();
            port.reviewed_launch_contract_v1
                .as_mut()
                .unwrap()
                .environment_prefix = Some(stated.into());
            validate(&port).unwrap_err();
            let mut harmless = environment(None, "PYTHONDONTWRITEBYTECODE", text("1"));
            harmless.id = id.into();
            validate(&harmless).unwrap();
        }
    }

    #[test]
    fn embedded_port_ids_derive_distinct_prefixes() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut seen = BTreeMap::new();
        let mut collisions = Vec::new();
        for port in catalog.ports() {
            if let Some(prefix) = derived_environment_prefix(&port.id)
                && let Some(other) = seen.insert(prefix.clone(), port.id.clone())
            {
                collisions.push(format!("{other} and {}: {prefix}", port.id));
            }
        }
        assert_eq!(collisions, Vec::<String>::new());
    }

    /// The previous review's accepted names are all refused now: none starts
    /// with the prefix derived from the port ID.
    #[test]
    fn review_examples_outside_the_derived_prefix_are_refused() {
        for name in [
            "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
            "WEBVIEW2_BROWSER_EXECUTABLE_FOLDER",
            "LUA_INIT",
            "LUA_CPATH",
            "LUA_PATH",
            "TCL_LIBRARY",
            "TK_LIBRARY",
            "BASH_ENV",
            "GEM_PATH",
            "GEM_HOME",
            "OPENCL_VENDOR_PATH",
            "LIBDECOR_PLUGIN_DIR",
            "IBM_JAVA_OPTIONS",
            "OPENJ9_JAVA_OPTIONS",
            "ASAN_OPTIONS",
            "PIP_INDEX_URL",
            "NPM_CONFIG_REGISTRY",
            "OBS_VKCAPTURE",
            "PROCESSOR_ARCHITECTURE",
        ] {
            validate(&environment(None, name, text("1"))).unwrap_err();
            // Restating the name's own family as the prefix is refused too.
            let family = format!("{}_", name.split('_').next().unwrap());
            validate(&environment(Some(&family), name, text("1"))).unwrap_err();
            // The shared legacy deny-list refuses them as well.
            assert!(crate::process::is_loader_injection_variable(name), "{name}");
            assert!(!crate::catalog::is_safe_environment_name(name), "{name}");
        }
    }

    #[test]
    fn declared_prefixes_must_be_title_specific() {
        for prefix in ["DKC2_", "SNESRECOMP_", "PSX_", "FIXTURE_"] {
            assert!(valid_environment_prefix(prefix), "{prefix}");
        }
        for prefix in [
            "",
            "_",
            "AB_",
            "FIXTURE",
            "FIXTURE__",
            "FIX_TURE_",
            "fixture_",
            "2FIX_",
            "THIS_IS_FAR_TOO_LONG_TO_BE_A_TITLE_",
            // Loader-injection and non-title prefixes, and prefixes overlapping them.
            "DOTNET_",
            "COMPLUS_",
            "CORECLR_",
            "MONO_",
            "DOORSTOP_",
            "PYTHONX_",
            "WINEX_",
            "QTX_",
            "QMLX_",
            "GTK_",
            "GDK_",
            "GST_",
            "GIO_",
            "OCL_",
            "LIBVA_",
            "VDPAU_",
            "GBM_",
            "EGL_",
            "ELECTRON_",
            "NODE_",
            "SSL_",
            "OPENSSL_",
            "MALLOC_",
            "JAVA_",
            "PERLX_",
            "RUBYX_",
            "ENABLE_",
            "DISABLE_",
            "LIBGL_",
            "SDL_",
            "SDL2_",
            "MESA_",
            "DXVK_",
            "VKD3D_",
            "STEAMX_",
            "XDG_",
            "PORTCOVE_",
        ] {
            assert!(!valid_environment_prefix(prefix), "{prefix}");
            validate(&environment(
                Some(prefix),
                &format!("{prefix}SETTING"),
                text("1"),
            ))
            .unwrap_err();
        }
    }

    #[test]
    fn loader_runtime_and_toolkit_names_are_refused_everywhere() {
        let refused = [
            // Exact names.
            "PATH",
            "SDL_DYNAMIC_API",
            "__COMPAT_LAYER",
            "CORE_LIBRARIES",
            "GCONV_PATH",
            "LOCPATH",
            "NLSPATH",
            "TERMINFO",
            "TERMINFO_DIRS",
            "GLIBC_TUNABLES",
            "HOSTALIASES",
            "RES_OPTIONS",
            "TZDIR",
            "CLASSPATH",
            "CURL_CA_BUNDLE",
            "REQUESTS_CA_BUNDLE",
            "_NT_SYMBOL_PATH",
            "PSMODULEPATH",
            "GSETTINGS_BACKEND",
            "SSLKEYLOGFILE",
            "SYSTEMROOT",
            "WINDIR",
            "COMSPEC",
            "TEMP",
            "TMP",
            "APPDATA",
            "LOCALAPPDATA",
            "USERPROFILE",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "HOMEDRIVE",
            "HOMEPATH",
            "PUBLIC",
            "ALLUSERSPROFILE",
            // Proxy variables in any case.
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "FTP_PROXY",
            "NO_PROXY",
            "SOCKS_PROXY",
            // One name under each prefix.
            "DOTNET_STARTUP_HOOKS",
            "DOTNET_CLI_TELEMETRY_OPTOUT",
            "COMPLUS_ENABLEPROFILING",
            "COR_PROFILER_PATH_64",
            "CORECLR_PROFILER_PATH_32",
            "MONO_PATH",
            "DOORSTOP_ENABLED",
            "PYTHONPATH",
            "PYTHONHOME",
            "PYTHONSTARTUP",
            "WINEDLLOVERRIDES",
            "WINEPREFIX",
            "QT_PLUGIN_PATH",
            "QT_QPA_PLATFORM_PLUGIN_PATH",
            "QTWEBENGINE_CHROMIUM_FLAGS",
            "QML2_IMPORT_PATH",
            "GTK_MODULES",
            "GTK_THEME",
            "GTK3_MODULES",
            "GDK_BACKEND",
            "GST_PLUGIN_PATH_1_0",
            "GIO_EXTRA_MODULES",
            "OCL_ICD_VENDORS",
            "LIBVA_DRIVERS_PATH",
            "VDPAU_DRIVER_PATH",
            "GBM_BACKENDS_PATH",
            "EGL_PLATFORM",
            "__GLX_VENDOR_LIBRARY_NAME",
            "__EGL_VENDOR_LIBRARY_DIRS",
            "ELECTRON_RUN_AS_NODE",
            "NODE_OPTIONS",
            "SSL_CERT_FILE",
            "OPENSSL_CONF",
            "MALLOC_CONF",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
            "JAVA_TOOL_OPTIONS",
            "_JAVA_OPTIONS",
            "JDK_JAVA_OPTIONS",
            "PERL5LIB",
            "RUBYOPT",
            "ENABLE_VKBASALT",
            "DISABLE_MANGOHUD",
            "VK_LAYER_PATH",
            "VK_ICD_FILENAMES",
            "LIBGL_DRIVERS_PATH",
            "MESA_LOADER_DRIVER_OVERRIDE",
            "LUA_INIT_5_4",
            "WEBVIEW2_USER_DATA_FOLDER",
            "TCLLIBPATH",
            "TK_LIBRARY",
            "BASH_ENV",
            "GEM_HOME",
            "BUNDLE_GEMFILE",
            "PIP_CONFIG_FILE",
            "NPM_CONFIG_PREFIX",
            "OPENCL_LAYERS",
            "LIBDECOR_PLUGIN_DIR",
            "IBM_JAVA_OPTIONS",
            "OPENJ9_JAVA_OPTIONS",
            "ASAN_OPTIONS",
            "UBSAN_OPTIONS",
            "LSAN_OPTIONS",
            "TSAN_OPTIONS",
            "MSAN_OPTIONS",
            "PROCESSOR_ARCHITECTURE",
            "OBS_VKCAPTURE",
            "MANGOHUD_CONFIGFILE",
            "XR_RUNTIME_JSON",
            "VR_OVERRIDE",
            "CURL_HOME",
            "LADSPA_PATH",
            "LV2_PATH",
        ];
        for name in refused {
            assert!(
                crate::process::is_loader_injection_variable(name)
                    && crate::process::is_loader_injection_variable(&name.to_ascii_lowercase()),
                "{name}"
            );
            assert!(!crate::catalog::is_safe_environment_name(name), "{name}");
            validate(&environment(None, name, text("1"))).unwrap_err();
        }
        // Existing catalog names stay valid for the legacy fields.
        for name in [
            "PYTHONDONTWRITEBYTECODE",
            "DOOMWADDIR",
            "SNESRECOMP_NO_LAUNCHER",
            "REX_GAME_DATA_ROOT",
            "ALEPHONE_DATA",
        ] {
            assert!(
                !crate::process::is_loader_injection_variable(name),
                "{name}"
            );
            assert!(crate::catalog::is_safe_environment_name(name), "{name}");
        }
        assert!(!crate::process::is_loader_injection_variable(
            "pythondontwritebytecode"
        ));
    }

    /// Values both rules refuse: locations, expansion, control characters and
    /// device names.
    const REFUSED_BY_BOTH: &[&str] = &[
        // Absolute and root-relative.
        "/usr/lib/fixture.so",
        "/",
        "\\Windows\\fixture.dll",
        // UNC and extended.
        "\\\\server\\share\\fixture.dll",
        "//server/share/fixture.dll",
        "\\\\?\\C:\\fixture.dll",
        "\\\\.\\pipe\\fixture",
        // Drive-absolute and drive-relative.
        "C:\\fixture\\plugin.dll",
        "c:/fixture/plugin.dll",
        "C:fixture.dll",
        // Location URL schemes.
        "file:///C:/fixture.dll",
        "FILE://server/share/fixture.dll",
        "file:fixture.dll",
        "https://example.invalid/fixture",
        // Home.
        "~",
        "~/fixture",
        "~user/fixture",
        // Parent references in either separator style.
        "..",
        "../fixture",
        "..\\fixture",
        "data/../../fixture",
        "data\\..\\..\\fixture",
        "... ",
        ".. ",
        // Path-list, key and option forms.
        "data;C:\\fixture",
        "data;\\\\server\\share",
        "data:/usr/lib",
        "data:\\fixture",
        "data:~/fixture",
        "data:..",
        "--data-dir=/etc",
        "--data-dir=..",
        "--dirs=data,../fixture",
        "-dir /etc",
        // Expansion syntax.
        "%APPDATA%",
        "%~dp0",
        "$HOME",
        "${HOME}",
        "$(id)",
        "`id`",
        // Control characters.
        "a\0b",
        "a\nb",
        "a\tb",
        "a\u{1b}b",
        "a\u{85}b",
        // Reserved device names.
        "CON",
        "nul.txt",
        "data/COM1",
        "LPT9",
        "COM0",
        "lpt0.txt",
        // A drive attached after a doubled sigil, and an alternate data stream.
        "--dC:x",
        "a.txt:evil",
        // The previous review's table.
        "-d\\\\host\\share\\x.dll",
        "-d/Windows/x.dll",
        "-I/etc",
        "-dC:x",
        "@\\\\host\\share\\args",
        "@/etc/args",
        "@args.txt",
        "\"C:\\x\"",
        "'/etc/x'",
        "\"data\"",
        "-I..",
        "-game..",
        "data/x..",
        "COM\u{b9}",
        "lpt\u{b2}.txt",
        "\u{ff0e}\u{ff0e}",
        "data\u{ff0f}x",
        "data\u{2215}x",
        "data\u{ff3c}x",
        "\u{ff02}x\u{ff02}",
        "%2e%2e",
        "smb://x",
        "http://x",
        "data//x",
    ];

    #[test]
    fn legacy_launch_text_cannot_reach_outside_the_installation() {
        for value in REFUSED_BY_BOTH {
            assert!(
                !crate::launch_paths::is_contained_launch_text(value),
                "{value:?}"
            );
        }
        // Legacy fields keep relative paths and list forms that existing data uses.
        for value in [
            "data",
            "./data",
            ".",
            ".;assets",
            ";",
            "profile:fast",
            "data:other",
            "1",
            "a;b",
            "files:x",
            "--game=red",
            "--game-dir=game-data",
            "+set",
            "bios/openbios.bin",
            "build-portcove/overlay-captures/overlay_captures.json",
            "import/disc.cue",
            "save..file",
            "console",
            "data/-x",
        ] {
            assert!(
                crate::launch_paths::is_contained_launch_text(value),
                "{value:?}"
            );
        }
        // An option attached to a path, and a drive after an option sigil.
        for value in [
            "-Idata/x",
            "+exec/x.cfg",
            "data/-x/y",
            "-C:x",
            "--C:x",
            "+dC:x",
        ] {
            assert!(
                !crate::launch_paths::is_contained_launch_text(value),
                "{value:?}"
            );
        }
    }

    #[test]
    fn contract_text_has_no_path_character_by_construction() {
        let contract_refused = [
            // Relative paths and list forms are legacy-only.
            "data/x",
            "./data",
            ".;assets",
            "a;b",
            "data\\x",
            "bios/openbios.bin",
            // Characters outside the class.
            "a b",
            "a@b",
            "a~b",
            "a\"b",
            "a'b",
            "a!b",
            "a#b",
            "a*b",
            "a?b",
            "a|b",
            "a<b",
            "a>b",
            "a&b",
            "a(b)",
            "a[b]",
            "a{b}",
            "caf\u{e9}",
            "",
            // Parent references anywhere.
            "save..file",
            "a..",
            "..a",
            "--x=..",
            // Drive and stream forms.
            "C:",
            "C:x",
            "c:x",
            "--dir=C:x",
            "-C:x",
            "--C:x",
            "-dC:x",
            "+dC:x",
            "a,C:x",
            "profile:C:x",
            "a.txt:evil",
            "save.dat:stream:$DATA",
            ":x",
            "a::b",
            // Device names, with or without an extension, also attached.
            "NUL",
            "nul.txt",
            "Com1",
            "lpt9.log",
            "aux",
            "prn.x",
            "--out=NUL",
            "-oNUL",
            "-ocon.txt",
            "profile:CON",
            // Doubled or mixed sigils.
            "---x",
            "+-x",
            "-+x",
            "++x",
        ];
        for value in REFUSED_BY_BOTH.iter().chain(&contract_refused) {
            assert!(
                !crate::launch_paths::is_contract_launch_text(value),
                "{value:?}"
            );
            validate(&environment(None, NAME, text(value))).unwrap_err();
            validate(&argument(value)).unwrap_err();
        }
        let long = "a".repeat(crate::launch_paths::MAX_CONTRACT_TEXT_LEN + 1);
        assert!(!crate::launch_paths::is_contract_launch_text(&long));
        assert!(crate::launch_paths::is_contract_launch_text(&long[1..]));
        for value in [
            "profile:fast",
            "--width=1280",
            "-windowed",
            "+set",
            "r_mode=4",
            "1",
            "false",
            "data",
            "assets",
            "gold",
            ".",
            "console",
            "nullable",
            "--disable-updated",
            "-data",
            "-tft",
            "--data-dir",
            "th04.hdi",
            "FREECG98.BMP",
            "ym2608_adpcm_rom.bin",
            "a,b",
            "-",
            "--",
            "-1",
            "key:value:more",
            "fs_game",
        ] {
            assert!(
                crate::launch_paths::is_contract_launch_text(value),
                "{value:?}"
            );
            validate(&environment(None, NAME, text(value)))
                .unwrap_or_else(|error| panic!("{value}: {error:?}"));
            validate(&argument(value)).unwrap_or_else(|error| panic!("{value}: {error:?}"));
        }
    }

    /// Semantic flags that load code, open a debugger or delegate process
    /// creation for a specific runtime. The strict class refuses the
    /// single-sigil and `:` forms; the explicit option list refuses the rest.
    #[test]
    fn semantic_runtime_flags_are_refused() {
        let by_class = [
            "-agentlib:jdwp=transport=dt_socket,server=y,address=8000",
            "-agentpath:/x/agent.so",
            "-javaagent:agent.jar",
            "-Xrunjdwp:transport=dt_socket",
            "-XX:OnError=cmd",
            "-XX:OnOutOfMemoryError=cmd",
            "-Xbootclasspath/a:x.jar",
            "-Xmx:1",
            "--load-extension=C:\\x",
            "--renderer-cmd-prefix=gdb --args",
            "--inspect=0.0.0.0:9229",
            "--remote-debugging-port=9222 --x",
        ];
        let by_option = [
            "--remote-debugging-port=9222",
            "-remote-debugging-port=9222",
            "--remote-debugging-pipe",
            "--remote-debugging-address=0.0.0.0",
            "--remote-allow-origins=x",
            "--inspect",
            "--inspect=9229",
            "--inspect-brk=9229",
            "--inspect-port=9229",
            "--INSPECT",
            "--debug-port=5858",
            "--load-extension=ext",
            "--disable-extensions-except=ext",
            "--browser-subprocess-path=x.exe",
            "--js-flags=--allow-natives-syntax",
            "--require=x",
            "--import=x",
            "--loader=x",
            "--experimental-loader=x",
            "--no-sandbox",
            "--disable-web-security",
            "--register-pepper-plugins=x.dll",
            "--renderer-cmd-prefix=x",
            "--utility-cmd-prefix=x",
            "--gpu-launcher=x",
            "--plugin-launcher=x",
            "--ppapi-plugin-launcher=x",
            "x=--inspect",
            "-r",
            "-R",
            "--env-file=x",
            "--inspect-brk-node",
            "--openssl-config=x",
            "--disable-gpu-sandbox",
            "--no-zygote",
            "--single-process",
            "-m",
            "-Dcom.sun.management.jmxremote",
            "-Dcom.sun.management.jmxremote.port=9010",
            "-DCOM.SUN.MANAGEMENT.jmxremote",
            "-Djava.library.path=lib",
            "-DJAVA.LIBRARY.PATH=lib",
        ];
        for value in by_class.iter().chain(&by_option) {
            assert!(
                !crate::launch_paths::is_contract_launch_text(value),
                "{value:?}"
            );
            validate(&argument(value)).unwrap_err();
        }
        for value in &by_option[..] {
            assert!(
                value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._=,+-:".contains(&byte)),
                "{value:?} must be refused by the option list, not the class"
            );
        }
    }

    /// The documented residual: these stay expressible on purpose, so a change
    /// that refuses them is a deliberate contract change, not a side effect.
    #[test]
    fn documented_residual_values_stay_accepted() {
        for value in [
            "-",
            "--",
            "=",
            "-Dfoo=bar",
            "-Dsun.java2d.d3d=false",
            "-mute",
            "-rate=2",
        ] {
            assert!(
                crate::launch_paths::is_contract_launch_text(value),
                "{value:?}"
            );
            validate(&environment(None, NAME, text(value)))
                .unwrap_or_else(|error| panic!("{value}: {error:?}"));
            validate(&argument(value)).unwrap_or_else(|error| panic!("{value}: {error:?}"));
        }
    }

    #[test]
    fn every_embedded_catalog_launch_value_and_name_passes_the_shared_rules() {
        let catalog = crate::Catalog::embedded().unwrap();
        let mut failures = Vec::new();
        for port in catalog.ports() {
            for value in port
                .launch_arguments
                .iter()
                .chain(&port.setup_arguments)
                .chain(port.launch_environment.values())
            {
                if !crate::launch_paths::is_contained_launch_text(value) {
                    failures.push(format!("{}: {value:?}", port.id));
                }
            }
            for name in port
                .launch_environment
                .keys()
                .chain(&port.source_environment)
                .chain(&port.user_data_environment)
            {
                if crate::process::is_loader_injection_variable(name) {
                    failures.push(format!("{}: {name}", port.id));
                }
            }
        }
        assert_eq!(failures, Vec::<String>::new());
    }

    proptest::proptest! {
        /// No accepted legacy text, when each of its elements and segments is
        /// joined to the working directory by a naive consumer, leaves it.
        #[test]
        fn accepted_text_never_resolves_outside_the_working_directory(
            text in "[a.:;,=/\\\\~C %$` -]{0,12}"
        ) {
            if crate::launch_paths::is_contained_launch_text(&text) {
                for element in text.split([';', ',', '=', ' ']) {
                    for candidate in std::iter::once(element).chain(element.split(':')) {
                        proptest::prop_assert!(naive_join_stays_inside(candidate), "{text:?}");
                    }
                }
            }
        }

        /// No accepted contract text, over arbitrary Unicode, has a character
        /// outside the strict class, a `..`, or a drive form.
        #[test]
        fn accepted_contract_text_stays_in_the_class(text in "\\PC{0,24}|[a-zC:.,=+_ -]{0,16}") {
            if crate::launch_paths::is_contract_launch_text(&text) {
                proptest::prop_assert!(
                    text.bytes().all(|byte| byte.is_ascii_alphanumeric()
                        || b"._=,+-:".contains(&byte)),
                    "{text:?}"
                );
                proptest::prop_assert!(!text.contains(".."), "{text:?}");
                for token in text.split(['=', ',']) {
                    let body = token.trim_start_matches(['-', '+']);
                    let bytes = body.as_bytes();
                    proptest::prop_assert!(
                        !(bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'),
                        "{text:?}"
                    );
                    proptest::prop_assert!(naive_join_stays_inside(token), "{text:?}");
                }
            }
        }
    }

    /// Lexically joins `relative` below a working directory as a Windows or
    /// POSIX consumer would and reports whether the result stays below it.
    fn naive_join_stays_inside(relative: &str) -> bool {
        let trimmed = relative.trim();
        if trimmed.starts_with(['/', '\\', '~'])
            || (trimmed.len() >= 2
                && trimmed.as_bytes()[0].is_ascii_alphabetic()
                && trimmed.as_bytes()[1] == b':')
        {
            return false;
        }
        let mut depth = 0_i32;
        for component in trimmed.split(['/', '\\']) {
            match component.trim_end_matches(['.', ' ']) {
                "" if component.matches('.').count() >= 2 => depth -= 1,
                _ if component.is_empty() || component == "." => {}
                _ => depth += 1,
            }
            if depth < 0 {
                return false;
            }
        }
        true
    }
}
