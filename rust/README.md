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

It also serves the authoring guide, normative rule index and rule lookup, and
lint-diagnostic explanations available from the package-based server.

Run `carve-mcp-rs --help` or `carve-mcp-rs --version` for command information.

Shared conformance tests drive both implementations through MCP and compare
tool schemas, success and error results, resource discovery, templates, and
resource contents. HTTP and workspace operations remain in the TypeScript
server; the Rust binary focuses on dependency-free authoring and source
processing over stdio.
