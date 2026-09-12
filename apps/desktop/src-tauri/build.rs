use std::env;
use std::fs;
use std::path::PathBuf;

const ROOT_FILE_ENV: &str = "PORTCOVE_APPLICATION_UPDATE_BUNDLED_ROOT_FILE";
const METADATA_URL_ENV: &str = "PORTCOVE_APPLICATION_UPDATE_METADATA_URL";
const TARGETS_URL_ENV: &str = "PORTCOVE_APPLICATION_UPDATE_TARGETS_URL";
const MAX_ROOT_BYTES: usize = 256 * 1024;

fn main() {
    for name in [ROOT_FILE_ENV, METADATA_URL_ENV, TARGETS_URL_ENV] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    write_application_update_configuration();
    tauri_build::build()
}

fn write_application_update_configuration() {
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"));
    let generated = output.join("application-update-build.rs");
    let embedded_root = output.join("application-update-root.json");
    let root = env::var_os(ROOT_FILE_ENV);
    let metadata_url = env::var(METADATA_URL_ENV)
        .ok()
        .filter(|value| !value.is_empty());
    let targets_url = env::var(TARGETS_URL_ENV)
        .ok()
        .filter(|value| !value.is_empty());

    let source = match (root, metadata_url, targets_url) {
        (None, None, None) => {
            fs::write(&embedded_root, []).expect("write disabled updater root");
            "pub const ENABLED: bool = false;\n\
             pub const METADATA_BASE_URL: &str = \"\";\n\
             pub const TARGETS_BASE_URL: &str = \"\";\n"
                .to_owned()
        }
        (Some(root), Some(metadata_url), Some(targets_url)) => {
            let root = PathBuf::from(root);
            println!("cargo:rerun-if-changed={}", root.display());
            let bytes = fs::read(&root).unwrap_or_else(|error| {
                panic!("could not read {ROOT_FILE_ENV} {}: {error}", root.display())
            });
            assert!(
                !bytes.is_empty() && bytes.len() <= MAX_ROOT_BYTES,
                "{ROOT_FILE_ENV} must contain 1..={MAX_ROOT_BYTES} bytes"
            );
            fs::write(&embedded_root, bytes).expect("write embedded updater root");
            format!(
                "pub const ENABLED: bool = true;\n\
                 pub const METADATA_BASE_URL: &str = {metadata_url:?};\n\
                 pub const TARGETS_BASE_URL: &str = {targets_url:?};\n"
            )
        }
        _ => panic!(
            "{ROOT_FILE_ENV}, {METADATA_URL_ENV}, and {TARGETS_URL_ENV} must be set together"
        ),
    };
    fs::write(generated, source).expect("write application updater build configuration");
}
