# Carve MCP for Rust

This crate is the native Carve MCP server. It consumes `carve-lang` and
serves MCP over stdio as the `carve-mcp-rs` binary.

Implemented tool names:

- `carve_lint`
- `carve_format`
- `carve_render`
- `carve_parse`
- `carve_migrate`

Shared conformance tests drive both implementations through MCP and compare the
source-tool contract. HTTP, resources, and workspace operations remain in the
TypeScript server; the Rust binary focuses on dependency-free source
processing over stdio.
