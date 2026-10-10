// Compile the same host-owned data declarations without linking the native host.
#[path = "../../../apps/desktop/src-tauri/src/desktop_contract.rs"]
pub mod desktop_contract;

fn main() {
    println!("{}", desktop_contract::export_transport_schemas());
}
