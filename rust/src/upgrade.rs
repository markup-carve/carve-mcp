//! The 0.1 source upgrader is a CLI-only migration command in Carve 0.2.
use serde_json::{Value, json};
use std::{io::Write, process::{Command, Stdio}, path::PathBuf};

fn run(source: &str, report: bool) -> Result<(i32,String,String),String> {
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../node_modules/@markup-carve/carve/dist/cli.js");
    let mut command = if local.is_file() {
        let mut command = Command::new("node"); command.arg(local); command
    } else { Command::new("carve") };
    command.arg("upgrade"); if report {command.arg("--json");} command.arg("-");
    let mut child = command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .spawn().map_err(|error|format!("Carve upgrade CLI is unavailable: {error}"))?;
    child.stdin.take().ok_or("Upgrade CLI has no standard input")?
        .write_all(source.as_bytes()).map_err(|error|error.to_string())?;
    let output = child.wait_with_output().map_err(|error|error.to_string())?;
    if output.stdout.len() > 8_000_000 || output.stderr.len() > 8_000_000 {
        return Err("Carve upgrade CLI output exceeded the 8000000-byte limit.".into());
    }
    Ok((output.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&output.stdout).into_owned(),
        String::from_utf8_lossy(&output.stderr).into_owned()))
}
pub(crate) fn upgrade(source:&str)->Result<Value,String> {
    let (status,value,stderr)=run(source,false)?;
    let (report_status,report,report_stderr)=run(source,true)?;
    if status==2 || report_status==2 {return Err(format!("carve upgrade failed: {}", if stderr.is_empty(){report_stderr.trim()}else{stderr.trim()}));}
    let parsed:Value=serde_json::from_str(&report).map_err(|_|"carve upgrade returned no JSON report.".to_string())?;
    let file=parsed["files"].as_array().and_then(|files|files.first())
        .ok_or("carve upgrade returned an empty report.")?;
    let check=file["check"].as_str().unwrap_or("unknown");
    Ok(json!({"value":value,"changed":file["changed"]==true,"check":check,
        "writable":check=="pass"||check=="explained",
        "records":file["records"].as_array().cloned().unwrap_or_default(),
        "engine01":parsed["engine01"].as_str().unwrap_or("")}))
}
