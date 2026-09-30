//! Host-owned navigation and browser permission boundaries. External links use
//! the separately validated native opener rather than navigating this webview.

use tauri::{Manager, Runtime, Url};

fn trusted_navigation(url: &Url, development_origin: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let application_origin = url.port().is_none()
        && ((url.scheme() == "tauri" && url.host_str() == Some("localhost"))
            || (matches!(url.scheme(), "http" | "https")
                && url.host_str() == Some("tauri.localhost")));
    application_origin
        || development_origin.is_some_and(|development| url.origin() == development.origin())
}

pub fn init<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-boundary")
        .on_navigation(|webview, url| {
            #[cfg(feature = "native-compatibility-qualification")]
            if webview.label() == "boundary-remote" {
                // This unprivileged test window deliberately exercises remote ACL.
                // It never has a main-window capability or command grant.
                return true;
            }
            let development_origin = tauri::is_dev()
                .then(|| webview.app_handle().config().build.dev_url.as_ref())
                .flatten();
            let allowed = trusted_navigation(url, development_origin);
            if !allowed {
                tracing::warn!(
                    operation_id = "webview-navigation",
                    webview_label = webview.label(),
                    scheme = url.scheme(),
                    "blocked navigation outside trusted application origin"
                );
            }
            allowed
        })
        .on_webview_ready(|webview| {
            #[cfg(windows)]
            deny_browser_permissions(webview);
            #[cfg(not(windows))]
            let _ = webview;
        })
        .build()
}

#[cfg(windows)]
fn deny_browser_permissions<R: Runtime>(webview: tauri::Webview<R>) {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_PERMISSION_STATE_DENY,
        PermissionRequestedEventHandler,
    };
    let app = webview.app_handle().clone();
    let callback_app = app.clone();
    let result = webview.with_webview(move |platform| {
        // The handler is retained by the WebView2 instance until its destruction.
        // Portcove does not use browser camera, microphone, geolocation or other
        // permission-gated device APIs. Native dialogs are a separate authority.
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|browser| {
                let mut token = 0;
                browser.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(|_, arguments| {
                        if let Some(arguments) = arguments {
                            arguments.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                            tracing::info!(
                                operation_id = "webview-permission",
                                "denied browser permission request"
                            );
                        }
                        Ok(())
                    })),
                    &mut token,
                )
            })
        };
        if let Err(error) = result {
            tracing::error!(error = %error, "could not install browser permission boundary");
            callback_app.exit(1);
        }
    });
    if let Err(error) = result {
        tracing::error!(error = %error, "could not schedule browser permission boundary");
        app.exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permits_only_application_origins_and_the_exact_development_origin() {
        let development = Url::parse("http://localhost:1420").unwrap();
        for value in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/index.html?mode=library#port",
            "https://tauri.localhost/assets/index.js",
        ] {
            assert!(trusted_navigation(&Url::parse(value).unwrap(), None));
        }
        for value in [
            "https://example.com/",
            "https://tauri.localhost.example.com/",
            "http://tauri.localhost:1420/",
            "http://user@tauri.localhost/",
            "file:///C:/untrusted.html",
            "data:text/html,untrusted",
            "about:blank",
            "http://localhost:1420/",
        ] {
            assert!(!trusted_navigation(&Url::parse(value).unwrap(), None));
        }
        assert!(trusted_navigation(
            &Url::parse("http://localhost:1420/catalog").unwrap(),
            Some(&development),
        ));
        for value in [
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
        ] {
            assert!(!trusted_navigation(
                &Url::parse(value).unwrap(),
                Some(&development)
            ));
        }
    }
}
