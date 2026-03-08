# @trq/pi-colgrep

A pi extension package that adds a dedicated `colgrep` tool for semantic/hybrid code search using [ColGrep](https://github.com/lightonai/next-plaid/tree/main/colgrep).

## Features

- Adds a dedicated `colgrep` tool (keeps a clearer mental model than overriding `grep`).
- Prefers `colgrep` by default by removing built-in `grep` from active tools when the extension loads.
- Supports semantic queries plus optional regex pre-filter (`query` + `regex`), with compatibility for legacy `pattern` calls.
- Re-indexes automatically:
  - on session start,
  - after `write` and `edit` tool changes,
  - on filesystem change events (recursive watcher where supported).
- Adds `/colgrep-reindex` command for manual index refresh.
- Ships a `colgrep` usage skill (`skills/colgrep/SKILL.md`) so agents are prompted to prefer colgrep workflows.

## Prerequisites

Install `colgrep` first:

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/lightonai/next-plaid/releases/latest/download/colgrep-installer.sh | sh
```

## Install (pi package)

```bash
pi install npm:@trq/pi-colgrep
```

Or project-local:

```bash
pi install -l npm:@trq/pi-colgrep
```

## Local development

```bash
pi -e ./extensions/colgrep.ts
```

## Third-party content and licensing

This package includes an adapted skill from LightOn's `next-plaid` repository:

- Source: `colgrep/src/install/SKILL.md`
- Upstream license: Apache-2.0
- Included license text: `THIRD_PARTY_LICENSES/next-plaid-LICENSE.Apache-2.0.txt`

## Publish

```bash
npm publish --access public
```
