# Carve MCP for Rust

This package is the native Carve MCP server. It consumes `carve-lang` and
serves MCP over stdio as the `carve-mcp-rs` binary. CI verifies the package
archive can be built independently before it is submitted to crates.io.

Implemented tool names:

- `carve_lint`
- `carve_format`
- `carve_render`
- `carve_parse`
- `carve_migrate`

With one or more `--root` arguments it also provides guarded file discovery,
workspace review, reads, single-file and batch edit previews, and unified
diffs. `--allow-write` enables atomic,
hash-guarded writes; writes remain dry runs unless the caller opts in on the
individual call.

It also serves the writer prompts, authoring guide, normative rule index and
rule lookup, and lint-diagnostic explanations available from the package-based
server. Tools return human-readable summaries and schema-declared structured
results.

Run `carve-mcp-rs --help` or `carve-mcp-rs --version` for command information.
Use `--config carve-mcp.json` for the same relative roots, exclusions, review
limits, platform defaults, and link-check switches supported by the npm server.
The configuration cannot enable writes.

Shared conformance tests drive both implementations through MCP and compare
tool schemas, success and error results, prompts, resource discovery, templates,
and resource contents. HTTP remains TypeScript-only; the Rust binary provides
the same local authoring and guarded project workflow over stdio.
