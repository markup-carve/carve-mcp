# Connect Carve to your writing tool

Carve MCP lets an AI assistant check, format, preview, and convert documents.
The assistant can also look up Carve's authoring guidance and rules.

The recommended setup runs the published package locally with `npx`. It needs
Node.js 20 or newer, but does not need a checkout of this repository.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Carve-007ACC?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522carve%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540markup-carve%252Fcarve-mcp%2522%255D%257D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_Carve-111111)](https://cursor.com/install-mcp?name=carve&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtYXJrdXAtY2FydmUvY2FydmUtbWNwIl19)

Both buttons open the client and show the configuration for approval. The
manual alternatives below work when a browser does not allow application
links.

## Claude

For Claude Code, run:

```sh
claude mcp add --scope user carve -- npx -y @markup-carve/carve-mcp
```

For Claude Desktop, open **Settings → Developer → Edit Config**, then add this
server to the configuration:

```json
{
  "mcpServers": {
    "carve": {
      "command": "npx",
      "args": ["-y", "@markup-carve/carve-mcp"]
    }
  }
}
```

Restart Claude Desktop after saving the configuration.

## VS Code

Run **MCP: Open User Configuration** from the Command Palette and add:

```json
{
  "servers": {
    "carve": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@markup-carve/carve-mcp"]
    }
  }
}
```

To share the server with everyone working on one project, create
`.vscode/mcp.json` in that project with the same content.

## Cursor

Open **Cursor Settings → Tools & MCP → New MCP Server**, then add this to
`.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for every project:

```json
{
  "mcpServers": {
    "carve": {
      "command": "npx",
      "args": ["-y", "@markup-carve/carve-mcp"]
    }
  }
}
```

## Zed

Open **Settings → AI → MCP Servers → Add Server → Add Local Server** and use:

```json
{
  "context_servers": {
    "carve": {
      "command": "npx",
      "args": ["-y", "@markup-carve/carve-mcp"],
      "env": {}
    }
  }
}
```

The status indicator beside Carve turns green when the server is ready.

## Codex

Run:

```sh
codex mcp add carve -- npx -y @markup-carve/carve-mcp
```

The command saves the server in Codex's user configuration, so it is available
in later sessions.

## Try it

Open a document or paste a short sample, then ask:

- “Use Carve to check this document and explain the warnings plainly.”
- “Convert this Markdown to Carve and tell me about any fidelity loss.”
- “Render this Carve as HTML so I can preview it.”
- “Look up the Carve rule behind this diagnostic.”

If the assistant does not select Carve automatically, say “Use the Carve MCP
tools” in the request.

## Native binary

The release also provides a `carve-mcp-rs` executable for Linux x86-64 (GNU or
static musl), Linux ARM64, Intel or Apple Silicon macOS, and Windows x86-64.
Replace `npx` and its arguments above with the absolute path to that binary
when you want lint, format, render, parse, and migrate without Node.js.
The native binary includes the same authoring and rule resources. Use the
package-based server when you need HTTP transport or guarded workspace access.

On Windows, if a client reports that it cannot find `npx`, set the command to
`npx.cmd`. The native Windows binary avoids this shell-specific difference.
