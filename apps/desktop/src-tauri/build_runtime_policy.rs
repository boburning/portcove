use std::path::Path;

pub fn windows_minimum_source(path: &Path) -> Result<String, tauri_codegen::CodegenConfigError> {
    let (config, _) = tauri_codegen::get_config(path)?;
    Ok(format!(
        "pub const WINDOWS_WEBVIEW2_MINIMUM: Option<&str> = {:?};\n",
        config.bundle.windows.minimum_webview2_version.as_deref()
    ))
}
