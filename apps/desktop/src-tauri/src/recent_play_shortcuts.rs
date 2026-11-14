//! Recently played games as operating-system shortcuts (the Windows taskbar
//! jump list).
//!
//! Core owns successful-launch history; this adapter only mirrors a bounded
//! read of it. Each shortcut starts this executable with a fixed
//! `--portcove-play <port-id>` argument. No URL scheme or listener is
//! registered, so web content cannot produce that argument. The request names a
//! port only: the frontend routes it to the ordinary Play action, and Core's
//! launch path still owns readiness, locking and executable trust.

use std::ffi::OsString;
use std::sync::Mutex;

use portcove_core::RecentlyPlayedGame;

use crate::DesktopState;

/// The only accepted startup form is `<program> --portcove-play <port-id>`.
pub(crate) const PLAY_ARGUMENT: &str = "--portcove-play";
const MAX_PORT_ID_LENGTH: usize = 128;
#[cfg_attr(not(all(windows, not(test))), allow(dead_code))]
const JUMP_LIST_ENTRIES: usize = 5;
/// The installed application's identity. The NSIS installer stamps it on its
/// Start menu and desktop shortcuts and its uninstaller deletes the jump list
/// under it. It is the configured bundle identifier (checked in tests).
#[cfg_attr(not(all(windows, not(test))), allow(dead_code))]
const APPLICATION_ID: &str = crate::application_update::APPLICATION_PRODUCT_ID;

/// Whether this process uses [`APPLICATION_ID`]: decided once at startup.
#[cfg(all(windows, not(test)))]
static INSTALLED_IDENTITY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

/// Gives the installed application the identity its installer shortcuts
/// carry, before any window exists, so its windows, pinned button and jump
/// list share one taskbar identity. Development, fixture and portable runs keep
/// the default per-executable identity and therefore never write into the
/// installed application's jump list.
pub(crate) fn adopt_installed_identity() {
    #[cfg(all(windows, not(test)))]
    {
        let installed = crate::application_update_windows::running_registered_installation()
            && jump_list::set_process_identity().is_ok();
        let _ = INSTALLED_IDENTITY.set(installed);
    }
}

/// A one-shot play request from the process arguments. The frontend takes it
/// once; a reload or a later window never repeats it.
#[derive(Default)]
pub(crate) struct StartupPlayRequest(Mutex<Option<String>>);

impl StartupPlayRequest {
    pub(crate) fn from_arguments(arguments: impl IntoIterator<Item = OsString>) -> Self {
        Self(Mutex::new(play_request(arguments)))
    }

    fn take(&self) -> Option<String> {
        self.0.lock().ok().and_then(|mut request| request.take())
    }
}

/// Returns the port named by the startup arguments, if they are exactly the
/// play form with a well-formed identifier. Anything else is ignored.
fn play_request(arguments: impl IntoIterator<Item = OsString>) -> Option<String> {
    let mut arguments = arguments.into_iter().skip(1);
    let (flag, port_id) = (arguments.next()?, arguments.next()?);
    if arguments.next().is_some() || flag != PLAY_ARGUMENT {
        return None;
    }
    let port_id = port_id.into_string().ok()?;
    is_port_id(&port_id).then_some(port_id)
}

fn is_port_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PORT_ID_LENGTH
        && value
            .bytes()
            .next()
            .is_some_and(|first| first.is_ascii_alphanumeric())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// Consumes the startup play request. It carries no authority: the frontend
/// still uses the ordinary launch command for the current library.
#[tauri::command]
pub(crate) fn take_startup_play_request(
    request: tauri::State<'_, StartupPlayRequest>,
) -> Option<String> {
    request.take()
}

/// The shortcut text, matching how the app names a game: the original game
/// title first, then the project and variant when they distinguish it.
#[cfg_attr(not(all(windows, not(test))), allow(dead_code))]
fn entry_label(game: &RecentlyPlayedGame) -> String {
    let title = game
        .original_game_title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty());
    let variant = game
        .variant_label
        .as_deref()
        .map(str::trim)
        .filter(|variant| !variant.is_empty());
    let project = match (title, variant) {
        (None, None) => None,
        (_, Some(variant)) => Some(format!("{} · {variant}", game.name)),
        (Some(_), None) => Some(game.name.clone()),
    };
    let title = title.unwrap_or(&game.name);
    project.map_or_else(
        || title.to_owned(),
        |project| format!("{title} · {project}"),
    )
}

/// Rebuilds the shortcuts from the current library's history on a worker
/// thread. Failures are logged; they never affect startup, play or a library
/// change. Concurrent refreshes are serialized and each reads current history.
pub(crate) fn refresh(state: DesktopState) {
    #[cfg(all(windows, not(test)))]
    {
        let spawned = std::thread::Builder::new()
            .name("portcove-recent-play".into())
            .spawn(move || {
                static REFRESH: Mutex<()> = Mutex::new(());
                let _serialized = REFRESH.lock().unwrap_or_else(|poison| poison.into_inner());
                // A failed read (for example a library that did not open after a
                // switch) clears the category rather than keep another library's games.
                let entries = match crate::service(&state)
                    .and_then(|service| Ok(service.recently_played(JUMP_LIST_ENTRIES)?))
                {
                    Ok(games) => games
                        .iter()
                        .filter(|game| is_port_id(&game.port_id))
                        .map(|game| (game.port_id.clone(), entry_label(game)))
                        .collect::<Vec<_>>(),
                    Err(_) => {
                        tracing::warn!(
                            component = "recent_play_shortcuts",
                            success = false,
                            message = "recently played games could not be read; clearing them"
                        );
                        Vec::new()
                    }
                };
                let identity = INSTALLED_IDENTITY
                    .get()
                    .copied()
                    .unwrap_or(false)
                    .then_some(APPLICATION_ID);
                if let Err(error) = jump_list::replace(&entries, identity) {
                    tracing::warn!(
                        component = "recent_play_shortcuts",
                        success = false,
                        hresult = error.code().0,
                        message = "taskbar jump list could not be updated"
                    );
                }
            });
        if spawned.is_err() {
            tracing::warn!(
                component = "recent_play_shortcuts",
                success = false,
                message = "taskbar jump list refresh could not start"
            );
        }
    }
    #[cfg(not(all(windows, not(test))))]
    let _ = state;
}

#[cfg(all(windows, not(test)))]
mod jump_list {
    use windows::Win32::Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_Title};
    use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PropVariantClear};
    use windows::Win32::System::Com::{
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, CoCreateInstance, CoInitializeEx,
        CoUninitialize,
    };
    use windows::Win32::System::Variant::VT_LPWSTR;
    use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
    use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
    use windows::Win32::UI::Shell::{
        DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
        SHStrDupW, SetCurrentProcessExplicitAppUserModelID, ShellLink,
    };
    use windows::core::{HSTRING, Interface, Result};

    use super::{APPLICATION_ID, PLAY_ARGUMENT};

    const CATEGORY: &str = "Recently played";

    /// Sets the installed identity for this process; called before any window.
    pub(super) fn set_process_identity() -> Result<()> {
        // SAFETY: the argument is a valid NUL-terminated string for the call.
        unsafe { SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(APPLICATION_ID)) }
    }

    /// Replaces Portcove's custom category; an empty list removes it. Entries
    /// the player removed from the jump list are not added back. `identity` is
    /// the installed application ID, or `None` for the process's default.
    pub(super) fn replace(entries: &[(String, String)], identity: Option<&str>) -> Result<()> {
        // SAFETY: COM is initialized for this worker thread only and released
        // before it ends; every interface is dropped inside that scope.
        unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
            let result = build(entries, identity);
            CoUninitialize();
            result
        }
    }

    unsafe fn build(entries: &[(String, String)], identity: Option<&str>) -> Result<()> {
        unsafe {
            let list: ICustomDestinationList =
                CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER)?;
            if let Some(identity) = identity {
                list.SetAppID(&HSTRING::from(identity))?;
            }
            let mut slots = 0u32;
            let removed: IObjectArray = list.BeginList(&mut slots)?;
            let result = (|| {
                let removed = removed_arguments(&removed)?;
                let executable = std::env::current_exe().map_err(|_| {
                    windows::core::Error::from_hresult(windows::Win32::Foundation::E_FAIL)
                })?;
                let executable = HSTRING::from(executable.as_os_str());
                let collection: IObjectCollection =
                    CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER)?;
                let mut added = 0usize;
                for (port_id, label) in entries {
                    if added >= slots as usize {
                        break;
                    }
                    let arguments = format!("{PLAY_ARGUMENT} {port_id}");
                    if removed.iter().any(|value| value == &arguments) {
                        continue;
                    }
                    let link: IShellLinkW =
                        CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
                    link.SetPath(&executable)?;
                    link.SetArguments(&HSTRING::from(arguments.as_str()))?;
                    link.SetIconLocation(&executable, 0)?;
                    link.SetDescription(&HSTRING::from(label.as_str()))?;
                    let properties: IPropertyStore = link.cast()?;
                    set_string(&properties, &PKEY_Title, label)?;
                    // A window started from the entry then groups with the
                    // installed shortcuts instead of under a per-executable ID.
                    if let Some(identity) = identity {
                        set_string(&properties, &PKEY_AppUserModel_ID, identity)?;
                    }
                    properties.Commit()?;
                    collection.AddObject(&link)?;
                    added += 1;
                }
                if added > 0 {
                    list.AppendCategory(
                        &HSTRING::from(CATEGORY),
                        &collection.cast::<IObjectArray>()?,
                    )?;
                }
                list.CommitList()
            })();
            if result.is_err() {
                let _ = list.AbortList();
            }
            result
        }
    }

    unsafe fn removed_arguments(removed: &IObjectArray) -> Result<Vec<String>> {
        unsafe {
            let mut arguments = Vec::new();
            for index in 0..removed.GetCount()? {
                let Ok(link) = removed.GetAt::<IShellLinkW>(index) else {
                    continue;
                };
                let mut buffer = [0u16; 1024];
                if link.GetArguments(&mut buffer).is_ok() {
                    let length = buffer
                        .iter()
                        .position(|&unit| unit == 0)
                        .unwrap_or(buffer.len());
                    arguments.push(String::from_utf16_lossy(&buffer[..length]));
                } else {
                    tracing::debug!(
                        component = "recent_play_shortcuts",
                        message = "a removed jump-list entry had unreadable arguments"
                    );
                }
            }
            Ok(arguments)
        }
    }

    unsafe fn set_string(
        properties: &IPropertyStore,
        key: &windows::Win32::Foundation::PROPERTYKEY,
        value: &str,
    ) -> Result<()> {
        unsafe {
            let mut variant = PROPVARIANT::default();
            let inner = &mut variant.Anonymous.Anonymous;
            inner.vt = VT_LPWSTR;
            inner.Anonymous.pwszVal = SHStrDupW(&HSTRING::from(value))?;
            let result = properties.SetValue(key, &variant);
            let _ = PropVariantClear(&mut variant);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arguments(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn only_the_exact_play_form_with_a_well_formed_port_id_is_accepted() {
        assert_eq!(
            play_request(arguments(&[
                "portcove",
                PLAY_ARGUMENT,
                "lighthouse-2.port_x"
            ])),
            Some("lighthouse-2.port_x".into())
        );
        for rejected in [
            &["portcove"][..],
            &["portcove", PLAY_ARGUMENT],
            &["portcove", PLAY_ARGUMENT, ""],
            &["portcove", PLAY_ARGUMENT, "-lighthouse"],
            &["portcove", PLAY_ARGUMENT, "../lighthouse"],
            &["portcove", PLAY_ARGUMENT, "light house"],
            &["portcove", PLAY_ARGUMENT, "portcove://play/lighthouse"],
            &["portcove", PLAY_ARGUMENT, "lighthouse", "extra"],
            &["portcove", "--portcove-play=lighthouse"],
            &["portcove", "--play", "lighthouse"],
            &["portcove", "lighthouse", PLAY_ARGUMENT],
        ] {
            assert_eq!(play_request(arguments(rejected)), None, "{rejected:?}");
        }
        let long = "a".repeat(MAX_PORT_ID_LENGTH + 1);
        assert_eq!(
            play_request(arguments(&["portcove", PLAY_ARGUMENT, &long])),
            None
        );
    }

    #[test]
    fn the_jump_list_identity_is_the_configured_bundle_identifier() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["identifier"], APPLICATION_ID);
    }

    #[test]
    fn the_startup_request_is_taken_once() {
        let request = StartupPlayRequest::from_arguments(arguments(&[
            "portcove",
            PLAY_ARGUMENT,
            "lighthouse",
        ]));
        assert_eq!(request.take(), Some("lighthouse".into()));
        assert_eq!(request.take(), None);
        assert_eq!(StartupPlayRequest::default().take(), None);
    }

    #[test]
    fn entry_labels_follow_the_app_game_identity() {
        let game = |title: Option<&str>, variant: Option<&str>| RecentlyPlayedGame {
            port_id: "port".into(),
            name: "Project".into(),
            original_game_title: title.map(Into::into),
            variant_label: variant.map(Into::into),
            last_launched_at: 1,
        };
        assert_eq!(entry_label(&game(None, None)), "Project");
        assert_eq!(entry_label(&game(Some(" "), None)), "Project");
        assert_eq!(entry_label(&game(Some("Game"), None)), "Game · Project");
        assert_eq!(
            entry_label(&game(Some("Game"), Some("HD"))),
            "Game · Project · HD"
        );
        assert_eq!(
            entry_label(&game(None, Some("HD"))),
            "Project · Project · HD"
        );
    }
}
