use std::{
    env, fs,
    path::Path,
    process, thread,
    time::{Duration, Instant},
};
fn main() {
    let arguments = env::args().skip(1).collect::<Vec<_>>();
    let markers = Path::new(&arguments[1]);
    if arguments[0] == "original" {
        process::Command::new(env::current_exe().unwrap())
            .args(["successor", arguments[1].as_str()])
            .spawn()
            .unwrap();
        process::exit(0);
    }
    fs::write(markers.join("successor-started"), b"started").unwrap();
    let deadline = Instant::now() + Duration::from_secs(60);
    while !markers.join("release").exists() {
        if Instant::now() >= deadline {
            process::exit(9);
        }
        thread::sleep(Duration::from_millis(10));
    }
    fs::write("general.json", b"successor-data").unwrap();
}
