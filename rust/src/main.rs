use std::process::ExitCode;

use rmcp::ServiceExt;

mod resources;
mod server;

const HELP: &str = "carve-mcp-rs - native MCP server for Carve\n\nUsage: carve-mcp-rs [--help | --version]\n\nWith no arguments, serves MCP over standard input and output.";

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
        [] => match server::CarveServer::new()
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
        },
        arguments => {
            eprintln!(
                "Unknown arguments or combination: {}\n\n{HELP}",
                arguments.join(" ")
            );
            ExitCode::from(2)
        }
    }
}
