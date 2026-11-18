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

pub fn check(windows_minimum: Option<&str>) -> Result<(), String> {
    #[cfg(windows)]
    let floor = windows_minimum
        .filter(|minimum| minimum.split('.').count() == 4 && version_at_least(minimum, minimum))
        .ok_or_else(|| "This Portcove build lacks a valid WebView2 runtime minimum.".to_owned())?;
    #[cfg(target_os = "linux")]
    let floor = {
        let _ = windows_minimum;
        LINUX_ENGINE_FLOOR
    };
    let version = tauri::webview_version().map_err(|error| {
        format!("Portcove could not find its required WebView runtime: {error}. Repair the runtime before starting Portcove.")
    })?;
    if !version_at_least(&version, floor) {
        #[cfg(windows)]
        let remedy = format!(
            "Install or update the WebView2 Evergreen production Runtime to {floor} or later and retain automatic updates."
        );
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
            assert!(version_at_least(version, "2.52.6"));
        }
        for (version, accepted) in [
            ("156.1.2.2", false),
            ("156.1.2.3", true),
            ("156.1.3.0", true),
        ] {
            assert_eq!(version_at_least(version, "156.1.2.3"), accepted);
        }
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
