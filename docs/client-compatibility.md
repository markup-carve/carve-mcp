# Client compatibility

Carve MCP follows the standard MCP tool, prompt, and resource contracts. The
published package is the recommended choice for most clients; the Rust binary
offers the same local stdio authoring workflow without Node.js.

## What CI proves

Every change starts both servers as real child processes through the official
MCP client SDK. CI checks initialization, tool schemas and structured results,
prompts, resources, completions, errors, workspace review, preview-first edits,
and guarded writes. Separate HTTP tests use real Streamable HTTP requests.

This catches server and protocol regressions. It does not prove that every host
version presents every MCP capability in its interface.

## Host matrix

| Host | stdio | HTTP | Tools | Prompts and resources | Setup |
| --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Host-dependent | `codex mcp add` |
| Claude Code/Desktop | Yes | Yes | Yes | Host-dependent | CLI or JSON |
| VS Code | Yes | Yes | Yes | Yes | Install button or `mcp.json` |
| Cursor | Yes | Client-dependent | Yes | Version-dependent | Install button or `mcp.json` |
| Zed | Yes | Client-dependent | Yes | Version-dependent | Settings JSON |

“Host-dependent” is deliberate: clients evolve independently and may expose
tools before they expose prompts or resources. The server keeps its core writer
workflow usable through tools alone.

The command syntax and transport options were checked on 2026-09-06 with Codex
CLI 0.153.4, Claude Code 2.1.261, and VS Code 1.134.0. A live Codex session also
connected to the built package and invoked `carve_lint`. VS Code documents support
for [stdio and Streamable HTTP plus tools, prompts, and resources][vscode-mcp].
Claude documents both [local stdio and remote HTTP setup][claude-mcp]. Recheck
these primary references when updating the matrix.

[vscode-mcp]: https://code.visualstudio.com/docs/agent-customization/mcp-servers
[claude-mcp]: https://docs.anthropic.com/en/docs/claude-code/mcp

## Release smoke check

For each release candidate, test at least Codex, Claude, and VS Code using the
copy-ready setup in [Connect Carve to your writing tool](client-setup.md):

1. Ask the host to list Carve's capabilities.
2. Lint `examples/article.carve` and open one diagnostic explanation.
3. Run the review-document prompt when the host exposes prompts.
4. Authorize the `examples` folder read-only and review it.
5. Confirm that an edit is previewed before any write is offered.

Record the host name and version in the release notes. If a host omits prompts
or resources but tools work, document that limitation rather than claiming full
support.
