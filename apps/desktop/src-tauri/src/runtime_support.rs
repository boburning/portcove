//! The selected desktop engine floor, separate from compiler transform targets.

#[cfg(target_os = "linux")]
const LINUX_ENGINE_FLOOR: &str = "2.52.6";

fn version_at_least(actual: &str, floor: &str) -> bool {
    let parse = |version: &str| {
        version
            .split('.')
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()
    };
    matches!(
        (parse(actual), parse(floor)),
        (Ok(actual), Ok(floor)) if actual.len() == floor.len() && actual >= floor
    )
}

#[cfg(any(windows, test))]
fn windows_floor(windows_minimum: Option<&str>) -> Result<&str, String> {
    windows_minimum
        .filter(|minimum| minimum.split('.').count() == 4 && version_at_least(minimum, minimum))
        .ok_or_else(|| "This Portcove build lacks a valid WebView2 runtime minimum.".to_owned())
}

#[cfg(any(windows, test))]
fn check_windows_version(version: &str, floor: &str) -> Result<(), String> {
    if version_at_least(version, floor) {
        return Ok(());
    }
    Err(format!(
        "Portcove cannot start with WebView runtime {version}. Install or update the WebView2 Evergreen production Runtime to {floor} or later and retain automatic updates."
    ))
}

pub fn check(windows_minimum: Option<&str>) -> Result<(), String> {
    #[cfg(windows)]
    let floor = windows_floor(windows_minimum)?;
    #[cfg(target_os = "linux")]
    let _ = windows_minimum;
    let version = tauri::webview_version().map_err(|error| {
        format!("Portcove could not find its required WebView runtime: {error}. Repair the runtime before starting Portcove.")
    })?;
    #[cfg(windows)]
    check_windows_version(&version, floor)?;
    #[cfg(target_os = "linux")]
    if !version_at_least(&version, LINUX_ENGINE_FLOOR) {
        return Err(format!(
            "Portcove cannot start with WebView runtime {version}. Use updated Ubuntu 24.04 LTS with WebKitGTK 2.52.6 or later, or a current qualified Portcove AppImage."
        ));
    }
    eprintln!("Portcove WebView runtime version: {version}");
    Ok(())
}

pub fn report_failure(message: &str) {
    eprintln!("{message}");
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK, MessageBoxW};
        let message = message.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let title = "Portcove runtime required"
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>();
        // Both UTF-16 strings are terminated and remain alive for this synchronous call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            )
        };
    }
}

#[cfg(test)]
mod tests {
    use super::{check_windows_version, version_at_least, windows_floor};

    #[cfg(windows)]
    #[test]
    fn shipping_context_preserves_the_configured_runtime_floor() {
        let context = crate::startup_context::new();
        assert_eq!(
            context
                .config()
                .bundle
                .windows
                .minimum_webview2_version
                .as_deref(),
            crate::startup_context::WINDOWS_WEBVIEW2_MINIMUM
        );
        let minimum = windows_floor(
            context
                .config()
                .bundle
                .windows
                .minimum_webview2_version
                .as_deref(),
        )
        .expect("shipping startup must retain the effective configured minimum");
        assert!(check_windows_version(minimum, minimum).is_ok());
        assert!(check_windows_version("0.0.0.0", minimum).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn changed_minimum_reaches_the_decision_through_the_generated_context() {
        let config: tauri::utils::config::Config = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/changed-webview2-tauri.conf.json"
        ))
        .unwrap();
        let context = crate::startup_context::with_windows_minimum(
            tauri::generate_context!(),
            config.bundle.windows.minimum_webview2_version.as_deref(),
        );
        let minimum = windows_floor(
            context
                .config()
                .bundle
                .windows
                .minimum_webview2_version
                .as_deref(),
        )
        .unwrap();
        assert!(check_windows_version("156.2.3.3", minimum).is_err());
        assert!(check_windows_version("156.2.3.4", minimum).is_ok());
        assert!(check_windows_version("156.2.3.5", minimum).is_ok());
        let missing = crate::startup_context::with_windows_minimum(context, None);
        assert!(
            windows_floor(
                missing
                    .config()
                    .bundle
                    .windows
                    .minimum_webview2_version
                    .as_deref()
            )
            .is_err()
        );
    }

    #[test]
    fn missing_or_malformed_minimum_remains_a_refusal() {
        for minimum in [
            None,
            Some(""),
            Some("not-a-version"),
            Some("155.0.1"),
            Some("4294967296.0.0.0"),
        ] {
            assert!(windows_floor(minimum).is_err());
        }
    }

    #[test]
    fn engine_floor_accepts_exact_and_newer_serviced_versions() {
        for version in ["2.52.6", "2.52.7", "2.54.0", "3.0.0"] {
            assert!(version_at_least(version, "2.52.6"));
        }
    }

    #[test]
    fn changed_bundle_floor_drives_windows_startup() {
        let config: tauri::utils::config::Config = serde_json::from_str(include_str!(
            "../../../../scripts/fixtures/changed-webview2-tauri.conf.json"
        ))
        .unwrap();
        let floor =
            windows_floor(config.bundle.windows.minimum_webview2_version.as_deref()).unwrap();
        let guidance = check_windows_version("156.2.3.3", floor).unwrap_err();
        assert!(guidance.contains("156.2.3.3"));
        assert!(guidance.contains(&format!("to {floor} or later")));
        assert!(check_windows_version(floor, floor).is_ok());
        assert!(check_windows_version("156.2.3.5", floor).is_ok());
    }

    #[test]
    fn insufficient_unknown_and_preview_engine_identities_are_refused() {
        for version in [
            "",
            "2.50.4",
            "2.52.5",
            "2.52",
            "2.52.6.1",
            "2.52.6-beta",
            "999999999999.0.0",
        ] {
            assert!(!version_at_least(version, "2.52.6"));
        }
        for version in ["0.0.0.0", "155.0.4283", "155.0.4283.62 dev"] {
            assert!(!version_at_least(version, "156.1.2.3"));
        }
    }
}
