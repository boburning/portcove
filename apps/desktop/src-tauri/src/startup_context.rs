//! Shipping context construction, including policy omitted by Tauri's tokens.

#[cfg(windows)]
mod runtime_policy {
    include!(concat!(env!("OUT_DIR"), "/windows-runtime-minimum.rs"));
}

#[cfg(windows)]
pub(super) use runtime_policy::WINDOWS_WEBVIEW2_MINIMUM;

pub(crate) fn new() -> tauri::Context<tauri::Wry> {
    let context = tauri::generate_context!();
    #[cfg(windows)]
    {
        with_windows_minimum(context, WINDOWS_WEBVIEW2_MINIMUM)
    }
    #[cfg(not(windows))]
    context
}

#[cfg(windows)]
pub(super) fn with_windows_minimum(
    mut context: tauri::Context<tauri::Wry>,
    minimum: Option<&str>,
) -> tauri::Context<tauri::Wry> {
    context.config_mut().bundle.windows.minimum_webview2_version = minimum.map(str::to_owned);
    context
}
