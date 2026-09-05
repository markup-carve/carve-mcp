# Carve MCP server

Give MCP-compatible assistants the same Carve parser, linter, formatter, and
renderers used by the JavaScript implementation, without giving the server
filesystem or network access.

## Tools

- `carve_lint` checks a document and returns precise, structured warnings.
- `carve_format` produces canonical Carve and reports rendering losses.
- `carve_render` renders HTML, Markdown, plain text, or ANSI.
- `carve_parse` returns the resolved, position-aware interchange AST.
- `carve_migrate` converts HTML, Markdown, or Djot and reports migration fidelity.

All tools accept source text directly. Inputs are limited to 1 MB, and no tool
reads or writes files.

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
