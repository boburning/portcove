use std::path::Path;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if let [command, config] = arguments.as_slice()
        && command == "build-tuf"
    {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let result = runtime.block_on(
            portcove_release_tools::tuf_repository::build_tuf_repository(Path::new(config)),
        )?;
        println!("{}", serde_json::to_string(&result)?);
        return Ok(());
    }
    let [command, artifact, signature, public_key, sha256, bytes] = arguments.as_slice() else {
        return Err(
            "usage: portcove-release-tools verify ARTIFACT SIGNATURE PUBLIC_KEY SHA256 BYTES\n       portcove-release-tools build-tuf CONFIG"
                .into(),
        );
    };
    if command != "verify" {
        return Err("unknown release-tool command".into());
    }
    let result = portcove_release_tools::verify_artifact(
        Path::new(artifact),
        Path::new(signature),
        Path::new(public_key),
        sha256,
        bytes.parse()?,
    )?;
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
