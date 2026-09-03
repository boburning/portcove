fn main() {
    if let Some(exit_code) = portcove_desktop::run_hidden_helper() {
        std::process::exit(exit_code);
    }
    portcove_desktop::run();
}
