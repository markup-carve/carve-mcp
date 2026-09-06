use std::path::PathBuf;
use std::process::ExitCode;

use rmcp::ServiceExt;

mod config;
mod resources;
mod server;
mod workspace;

const HELP: &str = "carve-mcp-rs - native MCP server for Carve\n\nUsage: carve-mcp-rs [--config FILE] [--root PATH ...] [--allow-write]\n       carve-mcp-rs [--help | --version]\n\nWith or without workspace roots, serves MCP over standard input and output. Workspace access is disabled unless a root is supplied or configured.";

#[tokio::main]
async fn main() -> ExitCode {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    match arguments.as_slice() {
        [argument] if matches!(argument.as_str(), "-h" | "--help") => {
            println!("{HELP}");
            ExitCode::SUCCESS
        }
        [argument] if matches!(argument.as_str(), "-V" | "--version") => {
            println!("carve-mcp-rs {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        _ => {
            let mut roots = Vec::new();
            let mut allow_write = false;
            let mut config_path = None;
            let mut index = 0;
            while index < arguments.len() {
                match arguments[index].as_str() {
                    "--allow-write" => allow_write = true,
                    "--config" => {
                        index += 1;
                        let Some(value) = arguments.get(index) else {
                            eprintln!("--config requires a JSON file path.\n\n{HELP}");
                            return ExitCode::from(2);
                        };
                        config_path = Some(PathBuf::from(value));
                    }
                    value if value.starts_with("--config=") => {
                        if value.len() == 9 {
                            eprintln!("--config requires a JSON file path.\n\n{HELP}");
                            return ExitCode::from(2);
                        }
                        config_path = Some(PathBuf::from(&value[9..]))
                    }
                    "--root" => {
                        index += 1;
                        let Some(value) = arguments.get(index) else {
                            eprintln!("--root requires an absolute path.\n\n{HELP}");
                            return ExitCode::from(2);
                        };
                        roots.push(PathBuf::from(value));
                    }
                    value if value.starts_with("--root=") => roots.push(PathBuf::from(&value[7..])),
                    _ => {
                        eprintln!(
                            "Unknown arguments or combination: {}\n\n{HELP}",
                            arguments.join(" ")
                        );
                        return ExitCode::from(2);
                    }
                }
                index += 1;
            }
            if roots.iter().any(|root| !root.is_absolute()) {
                eprintln!("Workspace roots must be absolute paths.");
                return ExitCode::from(2);
            }
            let mut review = workspace::ReviewConfiguration::default();
            if let Some(path) = config_path {
                match config::load(&path) {
                    Ok((configured_roots, configured_review)) => {
                        roots.splice(0..0, configured_roots);
                        review = configured_review;
                    }
                    Err(error) => {
                        eprintln!("{error}");
                        return ExitCode::from(2);
                    }
                }
            }
            if allow_write && roots.is_empty() {
                eprintln!("--allow-write requires at least one --root.");
                return ExitCode::from(2);
            }
            let workspace = if roots.is_empty() {
                None
            } else {
                match workspace::Workspace::new(&roots, allow_write, review) {
                    Ok(value) => Some(value),
                    Err(error) => {
                        eprintln!("{error}");
                        return ExitCode::from(2);
                    }
                }
            };
            match server::CarveServer::with_workspace(workspace)
                .serve(rmcp::transport::stdio())
                .await
            {
                Ok(service) => match service.waiting().await {
                    Ok(_) => ExitCode::SUCCESS,
                    Err(error) => {
                        eprintln!("carve-mcp-rs failed: {error}");
                        ExitCode::FAILURE
                    }
                },
                Err(error) => {
                    eprintln!("carve-mcp-rs failed: {error}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}
