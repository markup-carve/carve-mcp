use std::process::Command;

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_carve-mcp-rs"))
}

#[test]
fn reports_help_and_version() {
    for argument in ["--help", "-h"] {
        let help = binary().arg(argument).output().expect("run help");
        assert!(help.status.success());
        assert!(String::from_utf8_lossy(&help.stdout).contains("serves MCP"));
    }

    for argument in ["--version", "-V"] {
        let version = binary().arg(argument).output().expect("run version");
        assert!(version.status.success());
        assert_eq!(
            String::from_utf8_lossy(&version.stdout).trim(),
            format!("carve-mcp-rs {}", env!("CARGO_PKG_VERSION"))
        );
    }
}

#[test]
fn rejects_unknown_or_extra_arguments() {
    for arguments in [
        ["--unknown"].as_slice(),
        ["--version", "--unknown"].as_slice(),
    ] {
        let output = binary().args(arguments).output().expect("run invalid args");
        assert_eq!(output.status.code(), Some(2));
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(stderr.contains("Unknown arguments"));
        assert!(arguments.iter().all(|argument| stderr.contains(argument)));
    }
}
