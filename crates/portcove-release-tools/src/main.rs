use std::path::Path;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    let [command, artifact, signature, public_key, sha256, bytes] = arguments.as_slice() else {
        return Err(
            "usage: portcove-release-tools verify ARTIFACT SIGNATURE PUBLIC_KEY SHA256 BYTES"
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
