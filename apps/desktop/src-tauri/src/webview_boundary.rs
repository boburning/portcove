//! Host-owned navigation and browser permission boundaries. External links use
//! the separately validated native opener rather than navigating this webview.

use tauri::{Manager, Runtime, Url};

fn application_origin(https_scheme: bool) -> Url {
    let origin = if cfg!(any(windows, target_os = "android")) {
        if https_scheme {
            "https://tauri.localhost"
        } else {
            "http://tauri.localhost"
        }
    } else {
        "tauri://localhost"
    };
    Url::parse(origin).expect("fixed Tauri application origin is valid")
}

fn trusted_navigation(url: &Url, application: &Url, development_origin: Option<&Url>) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    let same_application_origin = url.scheme() == application.scheme()
        && url.host_str() == application.host_str()
        && url.port() == application.port();
    same_application_origin
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
            let https_scheme = webview
                .app_handle()
                .config()
                .app
                .windows
                .iter()
                .find(|window| window.label == "main")
                .is_some_and(|window| window.use_https_scheme);
            let allowed =
                trusted_navigation(url, &application_origin(https_scheme), development_origin);
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
        let application = application_origin(false);
        for path in [
            "/index.html",
            "/index.html?mode=library#port",
            "/assets/index.js",
        ] {
            assert!(trusted_navigation(
                &application.join(path).unwrap(),
                &application,
                None
            ));
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
            assert!(!trusted_navigation(
                &Url::parse(value).unwrap(),
                &application,
                None
            ));
        }
        assert!(trusted_navigation(
            &Url::parse("http://localhost:1420/catalog").unwrap(),
            &application,
            Some(&development),
        ));
        for value in [
            "http://localhost:1421/",
            "https://localhost:1420/",
            "http://127.0.0.1:1420/",
        ] {
            assert!(!trusted_navigation(
                &Url::parse(value).unwrap(),
                &application,
                Some(&development)
            ));
        }
    }

    #[test]
    fn rejects_inactive_transport_aliases() {
        let aliases = [
            "tauri://localhost/",
            "http://tauri.localhost/",
            "https://tauri.localhost/",
        ];
        for active in aliases {
            let application = Url::parse(active).unwrap();
            for candidate in aliases {
                assert_eq!(
                    trusted_navigation(&Url::parse(candidate).unwrap(), &application, None),
                    candidate == active,
                );
            }
        }
        let expected = if cfg!(any(windows, target_os = "android")) {
            "https://tauri.localhost/"
        } else {
            "tauri://localhost/"
        };
        assert_eq!(application_origin(true).as_str(), expected);
    }
}
