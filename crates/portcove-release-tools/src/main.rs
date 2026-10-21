use std::path::Path;

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().skip(1).collect();
    if let [command, config] = arguments.as_slice() {
        if command == "create-offline-key" {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = runtime.block_on(
                portcove_release_tools::tuf_repository::offline_key::create_one_key(Path::new(
                    config,
                )),
            )?;
            println!("{}", serde_json::to_string(&report)?);
            return Ok(());
        }
        if matches!(
            command.as_str(),
            "sign-offline-root"
                | "sign-offline-targets"
                | "finalize-offline-root"
                | "prepare-offline-root"
        ) {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()?;
            let report = match command.as_str() {
                "sign-offline-root" => runtime.block_on(
                    portcove_release_tools::tuf_repository::offline::sign_initial_root(Path::new(
                        config,
                    )),
                )?,
                "sign-offline-targets" => runtime.block_on(
                    portcove_release_tools::tuf_repository::offline::sign_initial_targets(
                        Path::new(config),
                    ),
                )?,
                "prepare-offline-root" => {
                    portcove_release_tools::tuf_repository::offline::prepare_initial_root(
                        Path::new(config),
                    )?
                }
                _ => portcove_release_tools::tuf_repository::offline::finalize_initial_root(
                    Path::new(config),
                )?,
            };
            println!("{}", serde_json::to_string(&report)?);
            return Ok(());
        }
    }
    if let [command, config] = arguments.as_slice()
        && command == "inspect-tuf-bootstrap"
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let report = runtime.block_on(
            portcove_release_tools::tuf_repository::isolated::inspect_tuf_bootstrap(Path::new(
                config,
            )),
        )?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    if let [command, config] = arguments.as_slice()
        && command == "prepare-tuf-renewal"
    {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?;
        let report = runtime.block_on(
            portcove_release_tools::tuf_repository::isolated::prepare_tuf_renewal(Path::new(
                config,
            )),
        )?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    if let [command, role, config] = arguments.as_slice()
        && command == "sign-tuf-role"
    {
        let role = portcove_release_tools::tuf_repository::isolated::OnlineRole::parse(role)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let report = runtime.block_on(
            portcove_release_tools::tuf_repository::isolated::sign_tuf_role(
                role,
                Path::new(config),
            ),
        )?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
    if let [command, config] = arguments.as_slice()
        && command == "assemble-tuf"
    {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()?;
        let report = runtime.block_on(
            portcove_release_tools::tuf_repository::isolated::assemble_tuf_repository(Path::new(
                config,
            )),
        )?;
        println!("{}", serde_json::to_string(&report)?);
        return Ok(());
    }
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
            "usage: portcove-release-tools verify ARTIFACT SIGNATURE PUBLIC_KEY SHA256 BYTES\n       portcove-release-tools build-tuf CONFIG\n       portcove-release-tools sign-tuf-role releases|preview|stable|snapshot|timestamp CONFIG\n       portcove-release-tools assemble-tuf CONFIG\n       portcove-release-tools prepare-tuf-renewal CONFIG\n       portcove-release-tools inspect-tuf-bootstrap CONTEXT\n       portcove-release-tools create-offline-key CONFIG\n       portcove-release-tools prepare-offline-root CONFIG\n       portcove-release-tools sign-offline-root CONFIG\n       portcove-release-tools finalize-offline-root CONFIG\n       portcove-release-tools sign-offline-targets CONFIG"
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
