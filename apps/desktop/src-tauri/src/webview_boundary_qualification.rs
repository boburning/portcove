//! Qualification-only windows exercise the existing command/origin guards.
//! No additional capability or privileged command is granted to these windows.

fn fixture_url() -> Result<Option<tauri::Url>, String> {
    let Some(value) = std::env::var_os("PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL") else {
        return Ok(None);
    };
    let url = tauri::Url::parse(&value.to_string_lossy()).map_err(|error| error.to_string())?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Boundary fixture requires an explicit loopback HTTP port".into());
    }
    Ok(Some(url))
}

pub fn validate_fixture() -> Result<(), String> {
    fixture_url().map(|_| ())
}

#[tauri::command]
pub async fn create_boundary_windows<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    let url = fixture_url()?.ok_or("boundary fixture is inactive")?;
    create_owner(&app).map_err(|error| error.to_string())?;
    tauri::WebviewWindowBuilder::new(&app, "boundary-remote", tauri::WebviewUrl::External(url))
        .title("Portcove owned remote boundary fixture")
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn create_owner<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    tauri::WebviewWindowBuilder::new(
        app,
        "boundary-secondary",
        tauri::WebviewUrl::App("index.html".into()),
    )
    .use_https_scheme(
        app.config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .is_some_and(|window| window.use_https_scheme),
    )
    .title("Portcove owned secondary boundary fixture")
    .build()?;
    Ok(())
}

// Only the guarded main window can request these synthetic fixture operations.
// No core operation, filesystem payload, or production command is exposed.
#[tauri::command]
pub fn queue_boundary_reply<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    callback: tauri::ipc::JavaScriptChannelId,
) -> Result<(), String> {
    use tauri::Manager;
    let owner = app
        .get_webview_window("boundary-secondary")
        .ok_or("owned boundary fixture is absent")?;
    callback
        .channel_on::<_, String>(owner.as_ref().clone())
        .send(format!("PORTCOVE_SYNTHETIC_QUEUE:{}", "Q".repeat(65536)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn recreate_boundary_owner<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    use tauri::Manager;
    if app.get_webview_window("boundary-secondary").is_some() {
        return Err("close the existing owned fixture first".into());
    }
    create_owner(&app).map_err(|error| error.to_string())
}

pub fn handles(command: &str) -> bool {
    matches!(
        command,
        "create_boundary_windows" | "queue_boundary_reply" | "recreate_boundary_owner"
    )
}

pub fn dispatch<R: tauri::Runtime>(invoke: tauri::ipc::Invoke<R>) -> bool {
    if std::env::var_os("PORTCOVE_WEBVIEW_BOUNDARY_FIXTURE_URL").is_none() {
        invoke.resolver.reject("boundary fixture is inactive");
        return true;
    }
    let handler: fn(tauri::ipc::Invoke<R>) -> bool = tauri::generate_handler![
        create_boundary_windows,
        queue_boundary_reply,
        recreate_boundary_owner
    ];
    handler(invoke)
}
