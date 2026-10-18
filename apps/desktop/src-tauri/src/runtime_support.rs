//! The selected desktop engine floor, separate from compiler transform targets.

#[cfg(windows)]
const ENGINE_FLOOR: &[u32] = &[155, 0, 4283, 62];
#[cfg(target_os = "linux")]
const ENGINE_FLOOR: &[u32] = &[2, 52, 6];

fn version_at_least(actual: &str, floor: &[u32]) -> bool {
    let parts = actual
        .split('.')
        .map(str::parse::<u32>)
        .collect::<Result<Vec<_>, _>>();
    matches!(parts, Ok(parts) if parts.len() == floor.len() && parts.as_slice() >= floor)
}

pub fn check() -> Result<(), String> {
    #[cfg(windows)]
    {
        let os = windows_version::OsVersion::current();
        if (os.major, os.minor, os.build) < (10, 0, 26200) {
            return Err(
                "Portcove requires Windows 11 25H2 or later with normal security updates.".into(),
            );
        }
    }
    let version = tauri::webview_version().map_err(|error| {
        format!("Portcove could not find its required WebView runtime: {error}. Repair the runtime before starting Portcove.")
    })?;
    if !version_at_least(&version, ENGINE_FLOOR) {
        #[cfg(windows)]
        let remedy = "Install or update the WebView2 Evergreen production Runtime to 155.0.4283.62 or later; retain automatic updates.";
        #[cfg(target_os = "linux")]
        let remedy = "Use updated Ubuntu 24.04 LTS with WebKitGTK 2.52.6 or later, or a current qualified Portcove AppImage.";
        return Err(format!(
            "Portcove cannot start with WebView runtime {version}. {remedy}"
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
    use super::version_at_least;

    #[test]
    fn engine_floor_accepts_exact_and_newer_serviced_versions() {
        for version in ["2.52.6", "2.52.7", "2.54.0", "3.0.0"] {
            assert!(version_at_least(version, &[2, 52, 6]));
        }
        assert!(version_at_least("155.0.4283.62", &[155, 0, 4283, 62]));
        assert!(version_at_least("155.0.4283.63", &[155, 0, 4283, 62]));
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
            assert!(!version_at_least(version, &[2, 52, 6]));
        }
        for version in ["154.0.9999.99", "155.0.4283.60", "155.0.4283.62 dev"] {
            assert!(!version_at_least(version, &[155, 0, 4283, 62]));
        }
    }
}
