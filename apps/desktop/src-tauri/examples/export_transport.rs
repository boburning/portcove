// Export through the actual native production module, including its type reexports.
fn main() {
    println!(
        "{}",
        portcove_desktop::desktop_contract::export_transport_schemas()
    );
}
