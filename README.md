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

Tools return concise text for readers alongside schema-validated structured
results for clients. Six optional prompts guide common review, conversion, and
publishing workflows without replacing the writer's judgment.

Raw HTML passthrough is disabled by default because MCP inputs are untrusted.
The server has no filesystem access unless you explicitly give it a workspace
root.

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

## Get started

Node.js 20 or newer is required.

```sh
npx -y @markup-carve/carve-mcp
```

See [Connect Carve to your writing tool](docs/client-setup.md) for copy-ready
setup in Claude, VS Code, Cursor, Zed, and Codex, plus prompts to confirm it
works.
The [compatibility page](docs/client-compatibility.md) explains what CI verifies
and provides the short host smoke test used for releases.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Carve-007ACC?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522carve%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540markup-carve%252Fcarve-mcp%2522%255D%257D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_Carve-111111)](https://cursor.com/install-mcp?name=carve&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtYXJrdXAtY2FydmUvY2FydmUtbWNwIl19)

The [writer workflows](examples/README.md) show practical review, conversion,
preview, GitHub publishing, and documentation-folder tasks.

For local builds, workspace access, native binaries, HTTP and container
deployment, and contributor checks, see [Development and deployment](docs/development.md).

This project is licensed under the MIT License.
