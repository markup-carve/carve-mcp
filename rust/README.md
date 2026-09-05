# Carve MCP for Rust

This crate is the native preview of Carve MCP. It consumes `carve-lang` and
serves MCP over stdio as the `carve-mcp-rs` binary.

Implemented tool names:

- `carve_lint`
- `carve_format`
- `carve_render`
- `carve_parse`
- `carve_migrate`

The TypeScript package remains the production implementation. Before this
crate is released, shared fixtures must prove identical input schemas, errors,
result shapes, render options, migration diagnostics, and loss reports. HTTP,
resources, and workspace operations are intentionally not duplicated until
their cross-language contract is fixed.
