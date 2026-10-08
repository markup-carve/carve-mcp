# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- `carve_get_block` returns the exact source text of each selected block,
  without an AST. It takes the selector kinds the edit tools already use and a
  `scope`, so changing one paragraph in a large document no longer means sending
  the whole source in and taking a full AST back (#73).
- `carve_replace_source` splices Carve source over exactly the selected byte
  range and keeps every other byte, so CRLF endings and author spacing such as
  `-   item` survive an edit that the re-render-and-diff path would have
  normalized (#74).
- An `id` selector kind on `carve_select_ast_nodes` and `carve_plan_ast_edit`,
  matching any node whose attributes carry that id. An author-written `{#id}`
  on a paragraph, div, admonition, table, list, code block or span is
  addressable directly; `heading-id` reads headings only (#72).

### Fixed

- Every name lookup compares exactly, in both servers, following
  markup-carve/carve#2732. The project review's `broken-local-anchor` check
  compares a fragment against a Carve document's heading ids as written, while
  Markdown and Djot targets keep the case-insensitive comparison their own
  renderers' slug rules imply. `carve_reference_graph` keys footnote and
  link-reference definitions by their written label; every kind except headings
  was lowercased, so `Used[^note]` resolved against `[^Note]:` and that
  definition was not reported as an orphan (#75).

### Known issues

- `sanitizeUrls: false` does nothing in the Rust server: it denies either way,
  where the Node server emits the raw destination the input asks for. Making
  them agree lets the native server emit a `javascript:` href on request, so it
  is a decision rather than a cleanup (#78). The conformance harness pins the
  current difference.

### Changed

- The Rust server blanks a denied URL scheme's destination and reports the
  render loss, matching the Node server and PART 9 §25. It removed the element
  instead and reported nothing, so `carve_check_targets` called a document with
  three `javascript:` destinations `compatible` through the native binary and
  `lossy` through the Node one. An explicitly set `LinkPolicy::default()` was
  the cause: it routes the denial through a branch that drops the element and
  never reaches the loss collector, where the implicit default blanks and
  reports. A loss row also no longer carries `format` or `pos` as null; the
  published render-loss schema types them and forbids `format` on this code, so
  a consumer validating the wire rejected every row (#76).
- `carve_check_targets` assesses table preservation separately. Merged cells,
  captions, header roles, grouping and alignment can mark a target lossy even
  when the engine reports zero render losses, in the Node and the Rust server
  alike. A report states its scope and leaves a final PDF artifact unassessed
  (#71).
- The servers take the JavaScript engine at 0.1.10, from 0.1.9, and the native
  Rust engine at 0.1.8, from 0.1.7. Engine 0.1.10 derives its ordered AST walk
  from the schema rather than holding a `CHILD_FIELDS` literal, so the parity
  test imports that list instead of scraping it out of `dist/ast-sidecars.js`,
  where a scrape that no longer matched would have read as a failure. Its two
  extra slots, `terms` and `definitions`, belong to the engine's internal
  record shape; the wire AST spells a definition list as `items` and
  `children`, which the fixture now reaches into.

## 0.1.6 - 2026-10-01

### Fixed

- `carve_select_ast_nodes`, `carve_plan_ast_edit` and the node previews reach
  content in all twenty fields the AST schema puts nodes in. Seven went
  unvisited, so a figure's target, a block extension's fallback, a citation's
  prefix, locator and suffix, a substitution's two halves, a ruby's base and
  annotation, and a table cell holding blocks each hid everything inside them
  (#61, #62).
- A footnote reference is read from `label`, the field the wire carries since
  the engines moved. The reference graph recorded no footnote reference at all,
  so every definition was reported as an orphan, and `carve_plan_ast_edit` had
  stopped refusing `delete-node` on a footnote that is still referenced (#59).
- `carve_review_workspace` no longer calls a link broken when its destination
  heading exists outside `children`, such as a heading in a list item or under
  a figure caption (#63).
- A Markdown, Djot or BBCode import is no longer certified as `preserved` /
  `exact` when the dialect pass rewrote the source before the importer saw it.
  The fidelity report describes the source the caller sent (#59).
- The Rust server reports an unclosed container once instead of twice (#59).

### Changed

- The servers take the JavaScript engine at 0.1.9, from 0.1.7, and the native
  Rust engine at 0.1.7, from 0.1.6 (#59).

## 0.1.5 - 2026-09-19

### Added

- Opt-in `review`, `convert`, `structure`, and `workspace` tool profiles that
  reduce MCP schema context while keeping `all` as the default.
- A review-first semantic edit planner that can combine up to 100 non-overlapping
  AST edits into one explained, reversible, stale-guarded source patch without
  writing.
- `carve_diagnose_and_fix` previews automatic and writer-review diagnostics,
  applies only explicitly selected safe fixes, and returns guarded forward and
  undo source patches.
- A bounded workspace reference graph for headings, footnotes, abbreviations,
  document links, and images, with broken-edge and orphan reporting.
- A publishing-target compatibility matrix with target-specific lint warnings,
  rendering losses, and fallback guidance.
- `includeRootIndex` on `carve_render` and `carve_parse`, an index into the
  roots the server was started with. Expansion runs under that root through the
  engine's contained filesystem resolver, at its default depth, byte, file-size
  and resolver-call budgets, and both servers return the same root-relative
  `includes` report. Omit it and every directive stays literal; the option is
  offered only when workspace roots exist, so document text can never choose a
  file on the server host.

### Changed

- Migration tools now expose the shared version 2 report contract and support
  BBCode in both TypeScript and Rust. Unverified Markdown, Djot, and BBCode
  imports fail closed as `dropped` / `fallback` instead of claiming clean fidelity.
- Both engines are named by their published version rather than by a commit:
  the JavaScript engine moves from 0.1.5 to 0.1.7 and the native Rust engine
  from 0.1.4 to 0.1.6, each taken from npm and crates.io. The Rust crate can be
  packaged and verified from the registry as a result.
- **Breaking:** A substitution node in the tree carries `old` and `new` as
  arrays of inline nodes, where it carried the strings `oldText` and `newText`.
  A client reading that node walks the halves instead of reading them
  (markup-carve/carve-rs#1756).

## 0.1.4 - 2026-09-09

### Added

- Semantic AST selectors and concise, structured explanations for generated
  patch operations.

### Fixed

- Completed the release that 0.1.3 could not publish: the release smoke-test
  harness now reads the render result from `structuredContent.value`, so the
  release binaries and the npm publish complete.

## 0.1.3 - 2026-09-09

### Added

- Schema-declared structured results alongside concise human-readable tool
  summaries, with direct diagnostic explanation resource URIs.
- Six writer-controlled prompts for review, conversion, GitHub publishing,
  warning explanation, previews, and documentation-folder review.
- Bounded workspace file discovery and project review, including conservative
  checks for missing relative files and heading anchors outside code examples.
- Read-only formatting previews that return hash-guarded proposals before an
  explicitly enabled write.
- Guarded workspace discovery, review, previews, and atomic writes in the
  native Rust server.
- End-to-end writer workflow coverage, stable project diagnostic codes with
  prioritized next actions, and an honest client compatibility checklist.
- Optional project configuration shared by the package and Rust servers.
- Privacy-safe tool event logging and opt-in HTTP aggregate metrics.
- Ordered workspace fix plans that distinguish lossless canonical formatting
  from diagnostics or rendering losses requiring writer judgment.
- Bounded single-file and selective batch previews with unified diffs,
  opt-in batch content, and per-file stale-write hashes in both servers.
- Versioned, fingerprint-guarded UTF-8 source patches on single-file and batch
  previews, shared by the npm and native Rust servers.
- Worker-safe asynchronous client initialization and concrete Content Security
  Policy guidance for browser-hosted editors.
- Position-independent structured AST patches, plus reversible forward/inverse
  patches that preview as stale-guarded UTF-8 source edits in both servers.

## 0.1.2 - 2026-09-06

The npm server is unchanged. No tool, resource, option, or rendered output
differs from 0.1.1.

### Added

- The native `carve-mcp-rs` binary serves the authoring guide, the normative
  rule index and rule lookup, lint-diagnostic explanations, and completions,
  matching the npm server. It previously exposed only the five source-based
  tools, and is no longer a preview: shared conformance tests drive both
  implementations through MCP and compare tool schemas, results, and resources.
- `carve-mcp-rs --help` and `--version`, reporting the resolved engine version.
- Prebuilt binaries for statically linked Linux x86_64 (musl) and Linux arm64.

HTTP transport and guarded workspace access remain npm-only.

## 0.1.1 - 2026-09-06

The server's behavior is unchanged from 0.1.0: no tool, resource, option, or
rendered output differs, and the npm package ships the same compiled server.

### Added

- A container image published for each release, as an alternative to npm and
  the prebuilt binaries.
- A client setup guide and runnable Carve examples in the repository.

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
