use std::env;
use std::fs;
use std::path::PathBuf;

use sha2::{Digest, Sha256};

fn main() {
    write_cli_steam_exec_identity();
    tauri_build::build()
}

fn write_if_changed(path: &PathBuf, contents: &[u8]) {
    if fs::read(path).ok().as_deref() == Some(contents) {
        return;
    }
    fs::write(path, contents).unwrap_or_else(|error| {
        panic!(
            "could not write generated build input {}: {error}",
            path.display()
        )
    });
}

fn write_cli_steam_exec_identity() {
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo must provide OUT_DIR"));
    let generated = output.join("cli-steam-exec-identity.rs");
    let marker = format!(
        "PORTCOVE_CLI_STEAM_EXEC_IDENTITY_V1|product={}|capability=exec",
        env::var("CARGO_PKG_VERSION").expect("Cargo must provide CARGO_PKG_VERSION")
    );
    let digest: [u8; 32] = Sha256::digest(marker.as_bytes()).into();
    let source = format!(
        "pub const LEN: usize = {};\npub const SHA256: [u8; 32] = {:?};\n",
        marker.len(),
        digest
    );
    write_if_changed(&generated, source.as_bytes());
}
