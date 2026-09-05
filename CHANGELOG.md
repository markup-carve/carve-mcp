# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 - 2026-09-05

First release of the Carve MCP server: it gives MCP-compatible assistants the
same parser, linter, formatter, and renderers as the JavaScript implementation.

### Tools

- `carve_lint` returns structured, position-aware diagnostics with explanations.
- `carve_format` produces canonical Carve and reports rendering losses.
- `carve_render` renders HTML, Markdown, plain text, or ANSI.
- `carve_parse` returns the resolved, position-aware interchange AST.
- `carve_migrate` converts HTML, Markdown, or Djot with fidelity diagnostics and
  explicit Markdown dialect flags, so migration does not invent constructs the
  source format did not enable.

`carve_render` ships `default`, `portable`, and HTML-only `static-html` presets,
plus heading-ID behavior, loss policy, smart typography, and the `autolink`,
`semantic-spans`, and `wikilinks` extensions. Target-specific options are
rejected rather than silently ignored.

### Resources

- `carve://guide` - authoring quick start.
- `carve://rules` and `carve://rules/{ruleId}` - versioned normative rule lookup
  with completion, byte-faithful to the recorded `markup-carve/carve` commit.
- `carve://lint-rules/{ruleName}` - explanation for every diagnostic `carve_lint`
  emits, including platform-specific checks.

Resources are static and read-only, and identify the language spec version,
JavaScript engine version, and pinned snapshot separately.

### Workspace access (opt-in)

No filesystem tools exist by default. Operators configure absolute roots at
startup (`--root /absolute/path`) to register `carve_read_file` and
`carve_workspace_info`; `carve_write_file` needs an additional `--allow-write`.

Operations are confined to canonicalized roots and reject traversal, symlink
escapes, hidden paths, dependency directories, binary files, unsupported
extensions, and oversized content. Writes are dry runs by default, require the
previously read SHA-256 to overwrite, preserve file modes, and replace files
atomically. Host paths never appear in MCP results.

### HTTP transport (opt-in)

Stdio remains the default. `--http` adds a stateless Streamable HTTP endpoint at
`/mcp` with an unauthenticated `/health` probe. Non-loopback binds and HTTP
workspace writes require a bearer token supplied through the environment, never
a command-line argument. Host and origin headers are validated, and request
size, concurrency, and rate state are bounded.

### Security defaults

- Raw HTML passthrough is off, because MCP input is untrusted. Callers handling
  trusted documents opt in with `allowRawHtml`.
- Dangerous URL sanitization stays on unless explicitly disabled.
- Source input is capped at 1 MB.
- Tool failures are returned with the MCP `isError` flag.

### Native Rust preview

A Rust stdio server built on the official Rust MCP SDK and `carve-lang` exposes
preview versions of the five source-based tools. It is a preview until shared
cross-language fixtures pin every input and result shape: advanced render
settings, loss reports, migration reports, platform-specific linting, and
diagnostic offset normalization are not yet at parity, and HTTP, resources, and
workspace operations remain TypeScript-only. Choose the TypeScript server for
the complete contract.

Requires Node.js 20 or newer.
