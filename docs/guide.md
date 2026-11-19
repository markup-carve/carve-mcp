# carve-mcp guide

## Background

Give MCP-compatible assistants the same Carve parser, linter, formatter, and
renderers used by the JavaScript implementation. Filesystem access is absent by
default and can be enabled for explicitly configured document roots.

The `next2` branch runs the Carve 0.2 engine (`@markup-carve/carve` from carve-js
`next2`). Run `carve_upgrade` on Carve 0.1 source before editing it as 0.2.

## Tools

- `carve_lint` checks a document and returns precise, structured warnings.
- `carve_diagnose_and_fix` previews safe fixes, applies selected fix IDs, and returns an undo patch; ambiguous repairs remain writer-review items.
- `carve_format` produces canonical Carve and reports rendering losses. Pass `alignTables: true` to pad table cells so each column lines up. A GFM separator row is an ordinary row in 0.2; `carve_upgrade` turns it into `|=` header cells.
- `carve_render` renders HTML, and Markdown, plain text and ANSI through the
  engine's exports (`@markup-carve/carve/export`). Extensions: `tabs`,
  `semantic-spans` (`samp`, `var`, `cite` and `dfn` spans) and `wikilinks`
  (the 0.2 spelling is `:wiki[Page]`) work; `autolink` is refused until 0.2
  has a definition for it. `smartTypography` is a boolean in 0.2.
- `carve_check_targets` compares publishing compatibility across HTML, Markdown, plain text, ANSI, GitHub, WordPress, and PDF-stage profiles. A target whose writer the engine does not register reports `unavailable`.
- `carve_parse` returns the resolved, position-aware 2.0 tree; `positions: false` leaves out source positions. Positions count UTF-8 bytes.
- `carve_create_ast_patch` compares two interchange ASTs and returns a
  position-independent patch.
- `carve_apply_ast_patch` validates and previews a patch as both an AST and
  canonical Carve source without changing files.
- `carve_select_ast_nodes` finds any block or inline node by its `{#id}`,
  headings, footnotes, node types, or a current AST path without making an
  ambiguous selection for the caller.
- `carve_get_block` returns the exact source text of the nodes a selector
  matches, or a heading's whole section, with UTF-8 byte offsets and the
  source sha256. It reads a workspace file by path when a root is configured.
- `carve_replace_source` splices new Carve text over the exact bytes of one
  selected node or heading section and leaves every other byte alone. It
  refuses edits that change the node's kind, change how the rest of the
  document parses, or add lint findings, returns forward and undo patches, and
  can write the result through the hash-guarded workspace write.
- `carve_reviewed_edit` adds a workspace check to that edit. It previews the
  exact patch and undo patch, then checks local links and includes in the
  proposed document. A write needs `expectedSha256` and is refused when the
  scan is truncated, a file is unreadable, include warnings are suppressed, or
  the edit introduces a project error. Existing unresolved includes appear in
  the receipt so they can be repaired separately.
- `carve_undo_reviewed_edit` accepts the signed `undoReceipt` returned by a
  successful `carve_reviewed_edit` write. It restores the original bytes only
  while the edited file still has the resulting hash. Undo accepts unrelated
  existing project findings but refuses new ones. Receipts are valid for the
  lifetime of the server process.
- `carve_plan_ast_edit` turns one or more exact semantic matches and small edit
  intents into one explained, reversible source patch for approval.
- `carve_create_reversible_ast_patch` adds inverse operations and semantic
  stale-edit fingerprints.
- `carve_apply_reversible_ast_patch` safely previews forward or undo operations
  as a guarded UTF-8 source edit. The patched AST is returned only with
  `includeAst: true`.
- `carve_migrate` imports HTML, Markdown, GFM, Djot, or BBCode as Carve 0.2 and returns a version 3 report with the import diagnostics. The Markdown dialect flags of 0.1 (`highlight`, `superscript`, `math`) are gone.
- `carve_upgrade` rewrites Carve 0.1 source as 0.2 with the engine's upgrade tool. It returns the new source, the upgrade records (each names its `U-nnn` entry), and `writable`, which is false when a record needs a person.
- `carve_reference_graph` indexes cross-document headings, footnotes, abbreviations, links, and images, including broken edges and orphaned definitions (when workspace access is enabled).

`carve_review_workspace` accepts `strict: true` to check include targets and
line ranges. Its receipt lists files read and include dependencies. For CI,
use `carve-mcp-review --root docs --strict` as described in
[development and deployment](development.md).

Tools return concise text for readers alongside schema-validated structured
results for clients. Six optional prompts guide common review, conversion, and
publishing workflows without replacing the writer's judgment.

Use `--tool-profile review`, `convert`, `structure`, or `workspace` to expose
only the tools needed for that job and reduce model context. The default `all`
profile preserves the complete tool surface.

Raw HTML passthrough is disabled by default because MCP inputs are untrusted.
The server has no filesystem access unless you explicitly give it a workspace
root. That also governs `{{ path }}` includes, which stay literal until a call
names a configured root. See [Include expansion](development.md#include-expansion).

### Compatibility assessment scope

`carve_check_targets` reports render losses and table-preservation
diagnostics separately. A target is `lossy` if either assessment finds a change.
Merged cells and caption associations can therefore require review even when
the pinned engine returns zero render losses. Table diagnostics name the AST
node path and affected field.

The response is a version 2 receipt. `source.sha256` identifies the UTF-8
Carve input, and `versions` names the installed engine and MCP packages. Each
target retains its status, render losses, preservation findings, and assessment
scope. Keep this receipt with the converted output when reviewing a decision.

Each result includes `assessmentScope` and a `preservation` report with
`complete: false`, checked fields, and unchecked boundaries. A `compatible`
result means the declared checks found no issue. It does not certify every
semantic property, host behavior, or source spelling. The PDF profile assesses
the HTML stage only; it does not check the final PDF.

The server bundles the `table-structure-v1` assessment so these checks work
with its published, pinned engine. Keep its contract aligned with the
JavaScript engine's preservation API when extending the checked fields.

## Resources

- `carve://guide` is a concise authoring quick start.
- `carve://rules` lists the Carve 0.2 clause documents.
- `carve://rules/{ruleId}` looks up one normative 0.2 clause by its `C2-*` ID,
  such as `carve://rules/C2-T-005`. The 0.1 `CARVE-*` IDs are gone.
- `carve://spec` and `carve://spec/{name}` serve the vendored 0.2
  specification documents, such as `carve://spec/UPGRADING`.
- `carve://upgrade-map` and `carve://upgrade-map/{entry}` explain each source
  and tree change between 0.1 and 0.2, such as `carve://upgrade-map/U-001`.
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

See [Connect Carve to your writing tool](client-setup.md) for copy-ready
setup in Claude, VS Code, Cursor, Zed, and Codex, plus prompts to confirm it
works.
The [compatibility page](client-compatibility.md) explains what CI verifies
and provides the short host smoke test used for releases.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Carve-007ACC?logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522carve%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522%2540markup-carve%252Fcarve-mcp%2522%255D%257D)
[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_Carve-111111)](https://cursor.com/install-mcp?name=carve&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBtYXJrdXAtY2FydmUvY2FydmUtbWNwIl19)

The [writer workflows](../examples/README.md) show practical review, conversion,
preview, GitHub publishing, and documentation-folder tasks.

For local builds, workspace access, native binaries, HTTP and container
deployment, and contributor checks, see [Development and deployment](development.md).

This project is licensed under the MIT License.

Table alignment checks treat an unset alignment as left alignment. Host CSS and default header styling are outside the assessment.
