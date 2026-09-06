# Development and deployment

This page collects the technical setup that most writers do not need. For
normal installation, see [Connect Carve to your writing tool](client-setup.md).

## Run from source

Node.js 20 or newer is required.

```sh
npm install
npm run build
node dist/index.js
```

Configure an MCP client to launch that local build over stdio:

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

## Workspace access

All source tools operate on text supplied by the caller. The server has no
filesystem access by default. To allow reads within particular folders, pass
one or more absolute roots at startup:

```sh
node dist/index.js --root /absolute/project/path
```

`carve_workspace_info` lists root indexes without exposing host paths.
`carve_read_file` accepts common text-document extensions and excludes hidden
paths and dependency directories.

Add `--allow-write` to register `carve_write_file`. Writes default to dry runs,
stay inside canonicalized roots, preserve existing file modes, and require the
SHA-256 returned by the preceding read when overwriting a file. This detects
concurrent changes.

## Render and migration controls

`carve_render` supports `default`, `portable`, and HTML-only `static-html`
presets. The portable preset lowercases heading IDs and transliterates where it
can. Callers can also choose heading-ID behavior, loss policy, smart typography,
and the `autolink`, `semantic-spans`, or `wikilinks` extensions.

`carve_migrate` exposes Markdown dialect switches explicitly, so migration does
not invent constructs the source format did not enable. Raw HTML passthrough is
disabled by default, and dangerous URL sanitization remains enabled unless a
caller explicitly disables it.

Inputs are limited to 1 MB.

## Native Rust server

The native server uses `carve-lang` directly and exposes lint, format, render,
parse, migrate, and the authoring resources over stdio:

```sh
cargo run --manifest-path rust/Cargo.toml
```

GitHub releases provide Linux x86-64 (GNU and static musl), Linux ARM64,
macOS x86-64 and Apple Silicon, and Windows x86-64 binaries. Shared conformance
tests require the Rust and TypeScript servers to return the same tool and
resource contracts.

Choose TypeScript when you need HTTP or guarded workspace access. Choose Rust
for a standalone native executable with source processing and embedded
authoring guidance.

## HTTP deployment

Stdio is the default transport. Start the local HTTP listener with:

```sh
node dist/index.js --http --port=3000
```

The default bind is `127.0.0.1:3000`. The MCP endpoint is `/mcp`; `/health` is
an intentionally unauthenticated deployment probe. Non-loopback binds require
a bearer token supplied through the environment:

```sh
CARVE_MCP_TOKEN='replace-with-a-long-random-secret' \
CARVE_MCP_ALLOWED_HOSTS='mcp.example.com' \
  node dist/index.js --http --host=0.0.0.0 --port=3000
```

`CARVE_MCP_ALLOWED_HOSTS` is a comma-separated hostname allowlist without
ports. HTTP mode validates host and origin headers, limits request bodies to 7
MB, allows 60 MCP requests per minute per socket peer, caps concurrent MCP
requests at 32, and applies request, header, and keep-alive timeouts. Workspace
writes over HTTP require a token even on loopback.

Put public deployments behind TLS. When a reverse proxy terminates TLS, apply
client-aware rate limits there because the built-in listener sees the proxy as
the socket peer.

## Container

The non-root container supports AMD64 and ARM64:

```sh
docker run --rm -p 3000:3000 \
  -e CARVE_MCP_TOKEN='replace-with-a-long-random-secret' \
  ghcr.io/markup-carve/carve-mcp:latest
```

Connect to `http://127.0.0.1:3000/mcp` with an `Authorization: Bearer …`
header. Set `CARVE_MCP_ALLOWED_HOSTS` when the client uses a hostname other than
localhost.

## Verify a change

```sh
npm run check
npm test
npm run build
cargo test --manifest-path rust/Cargo.toml --locked
npm run test:rust-conformance
```

The workflows also build the container, verify downloaded release archives,
and publish checksums.
