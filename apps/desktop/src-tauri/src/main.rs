fn main() -> std::process::ExitCode {
    portcove_diagnostics::install_panic_hook();
    if let Some(exit_code) = portcove_desktop::run_hidden_helper() {
        std::process::exit(exit_code);
    }
    portcove_desktop::run()
}
