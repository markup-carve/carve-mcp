# Carve MCP server

Give MCP-compatible assistants the same Carve parser, linter, formatter, and
renderers used by the JavaScript implementation. Filesystem access is absent by
default and can be enabled for explicitly configured document roots.

## Tools

- `carve_lint` checks a document and returns precise, structured warnings.
- `carve_format` produces canonical Carve and reports rendering losses.
- `carve_render` renders HTML, Markdown, plain text, or ANSI.
- `carve_parse` returns the resolved, position-aware interchange AST.
- `carve_migrate` converts HTML, Markdown, or Djot and reports migration fidelity.

`carve_render` supports `default`, `portable`, and HTML-only `static-html`
presets. The portable preset lowercases heading IDs and transliterates where it
can. Advanced callers can choose heading-ID behavior, loss policy, smart
typography, and the `autolink`, `semantic-spans`, or `wikilinks` extensions.
`carve_migrate` exposes Markdown dialect switches explicitly, so migration does
not invent constructs the source format did not enable.

Raw HTML passthrough is disabled by default because MCP inputs are untrusted.
Callers handling trusted documents can opt in with `allowRawHtml`; dangerous URL
sanitization remains enabled unless explicitly disabled.

All tools accept source text directly. Inputs are limited to 1 MB, and no tool
reads or writes files unless a workspace root is configured at startup.

By default the server has no filesystem access. To opt into workspace reads,
configure one or more roots at startup:

```sh
node dist/index.js --root /absolute/project/path
```

`carve_workspace_info` lists the root indexes used by `carve_read_file` without
exposing host paths. Reads are limited to common text-document extensions and
exclude hidden paths and dependency directories.

Add `--allow-write` to register `carve_write_file`. Writes default to dry runs,
stay inside canonicalized roots, preserve existing file modes, and require the
previously read SHA-256 when overwriting a file. This detects concurrent
changes. MCP's newer protocol no longer asks clients for roots, so startup
configuration keeps the permission boundary explicit across protocol versions.

## Resources

- `carve://guide` is a concise authoring quick start.
- `carve://rules` explains the normative rule categories.
- `carve://rules/{ruleId}` looks up a stable normative `CARVE-*` rule ID, such as
  `carve://rules/CARVE-P0-001`.
- `carve://lint-rules/{ruleName}` explains a stable diagnostic name returned by
  `carve_lint`.

The resources identify the Carve version and link to the complete documentation
when a reader needs normative detail. Lint diagnostic names are a separate
namespace and are returned with their explanations directly by `carve_lint`.

## Run locally

Node.js 20 or newer is required.

```sh
npm install
npm run build
node dist/index.js
```

Configure an MCP client to launch the server over stdio:

```json
{
  "mcpServers": {
    "carve": {
      "command": "node",
      "args": ["/absolute/path/to/carve-mcp/dist/index.js"]
    }
  }
}
```

For normal use, let your MCP client run the published package:

```sh
npx -y @markup-carve/carve-mcp
```

See [Connect Carve to your writing tool](docs/client-setup.md) for copy-ready
setup in Claude, VS Code, Cursor, Zed, and Codex, plus prompts to confirm it
works.

### Native Rust server

The single-binary Rust server is intended for native distribution and
embedding. It uses `carve-lang` directly and exposes the five source-based tool
names over stdio:

```sh
cargo run --manifest-path rust/Cargo.toml
```

Release pages provide Linux x86-64, macOS x86-64 and Apple Silicon, and Windows
x86-64 binaries. Shared tests exercise both servers through MCP and require the
same source-tool results, including safe render options, loss and migration
reports, Markdown dialects, platform linting, and UTF-16 diagnostic offsets.
Choose TypeScript when you need HTTP, resources, or guarded workspace access;
choose Rust for a dependency-free native executable and the source-based tools.

### HTTP deployment

Stdio remains the default. For local HTTP development:

```sh
node dist/index.js --http --port=3000
```

The default bind is `127.0.0.1:3000`; `--host value` and `--port value` forms
are also accepted.

The MCP endpoint is `/mcp` and the health endpoint is `/health`. Non-loopback
binds require a bearer token supplied through the environment, never a command
line argument:

```sh
CARVE_MCP_TOKEN='replace-with-a-long-random-secret' \
CARVE_MCP_ALLOWED_HOSTS='mcp.example.com' \
  node dist/index.js --http --host=0.0.0.0 --port=3000
```

`CARVE_MCP_ALLOWED_HOSTS` is a comma-separated hostname allowlist (without
ports). HTTP mode validates host and origin headers, limits request bodies to 7
MB, allows 60 MCP requests per minute per socket peer, caps concurrent MCP
requests at 32, and applies request, header, and keep-alive timeouts. The health
endpoint is intentionally unauthenticated for deployment probes. Workspace
writes over HTTP require a token even on loopback. Put public deployments
behind TLS; the built-in listener is plain HTTP.
When a reverse proxy terminates TLS, configure equivalent client-aware rate
limits there because the built-in listener sees the proxy as the socket peer.

## Development

```sh
npm run check
npm test
npm run build
```

This project is licensed under the MIT License.
