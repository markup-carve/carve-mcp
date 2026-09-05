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

The intended published command is `npx -y @markup-carve/carve-mcp`; use the
local command until the package has been released.

## Development

```sh
npm run check
npm test
npm run build
```

This project is licensed under the MIT License.
