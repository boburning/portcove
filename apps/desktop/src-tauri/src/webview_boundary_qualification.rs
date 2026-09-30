//! Qualification-only windows exercise the existing command/origin guards.
//! No additional capability or privileged command is granted to these windows.

pub fn create_windows<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(value) = std::env::var_os("PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL") else {
        return Ok(());
    };
    let url = tauri::Url::parse(&value.to_string_lossy())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Boundary fixture requires an explicit loopback HTTP port".into());
    }
    tauri::WebviewWindowBuilder::new(
        app,
        "boundary-secondary",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Portcove owned secondary boundary fixture")
    .build()?;
    tauri::WebviewWindowBuilder::new(app, "boundary-remote", tauri::WebviewUrl::External(url))
        .title("Portcove owned remote boundary fixture")
        .build()?;
    Ok(())
}
