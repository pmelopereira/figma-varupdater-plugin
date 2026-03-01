# figma-updatevars-plugin

A Figma plugin toolkit for design system retheming: batch-update Local Variables, audit for old-theme remnants, auto-fix issues, and generate code tokens — all config-driven, no hardcoded values.

## Toolkit overview

| Tool | What it does |
|------|-------------|
| **Variable Updater** (plugin) | Drop a JSON file → batch-update Figma Local Variables |
| **Design System Auditor** (plugin) | Drop a config → scan all nodes for old colors, wrong fonts, unbound variables → Fix All |
| **figma-vars-to-overrides.py** | Convert Tokens Studio export (DTCG) → overrides JSON |
| **generate-audit-config.py** | Diff before/after overrides → audit config JSON |
| **generate-code-tokens.py** | Overrides → CSS custom properties + Tailwind config |

## End-to-end workflow

```
                         ┌──────────────────────────────────┐
                         │   Figma Design System File       │
                         │   (Variables, Styles, Components)│
                         └───────────┬──────────────────────┘
                                     │
    ┌────────────────────────────────┐│┌─────────────────────────────────┐
    │ STEP 1: Snapshot "before"      │││ STEP 2: Apply variable changes  │
    │                                │││                                 │
    │ Tokens Studio → Export JSON    │││ overrides.json                  │
    │         │                      │││        │                        │
    │         ▼                      │││        ▼                        │
    │ figma-vars-to-overrides.py     │││  Variable Updater Plugin       │
    │         │                      │││  (drop file → preview → apply) │
    │         ▼                      │││        │                        │
    │  before-overrides.json         │││  Variables updated ✓            │
    └────────────────────────────────┘│└─────────────────────────────────┘
                                     │
    ┌────────────────────────────────┐│┌─────────────────────────────────┐
    │ STEP 3: Snapshot "after"       │││ STEP 4: Generate audit config   │
    │                                │││                                 │
    │ Tokens Studio → Export JSON    │││ generate-audit-config.py        │
    │ (re-export — reads new values) │││   --before before-overrides.json│
    │         │                      │││   --after  after-overrides.json │
    │         ▼                      │││   --fonts  Sora,Inter           │
    │ figma-vars-to-overrides.py     │││         │                       │
    │         │                      │││         ▼                       │
    │         ▼                      │││  my-audit.json                  │
    │  after-overrides.json          │││                                 │
    └────────────────────────────────┘│└─────────────────────────────────┘
                                     │
    ┌────────────────────────────────┐│┌─────────────────────────────────┐
    │ STEP 5: Audit & fix            │││ STEP 6: Code tokens (optional)  │
    │                                │││                                 │
    │ Design System Auditor Plugin   │││ generate-code-tokens.py         │
    │   drop my-audit.json           │││   after-overrides.json          │
    │   Run Audit → see issues       │││         │                       │
    │   Fix All (dry run first)      │││    ┌────┴────┐                  │
    │   Re-audit → confirm clean     │││    ▼         ▼                  │
    │   Publish library ✓            │││ tokens.css  tailwind-tokens.mjs │
    └────────────────────────────────┘│└─────────────────────────────────┘
```

### Step-by-step

**Step 1 — Snapshot "before"** (only needed for audit config generation)

Open the Figma file → Tokens Studio plugin → Export Variables as JSON. Then convert:

```bash
python3 scripts/figma-vars-to-overrides.py tokens-before.json --skip-aliases -o before.json
```

**Step 2 — Apply variable changes**

Create or obtain an overrides JSON (manually, or from a brand token generator), then:

1. Figma → Plugins → Development → **figma-updatevars-plugin**
2. Drop `overrides.json` → preview → Apply

**Step 3 — Snapshot "after"**

Go back to Figma → open Tokens Studio plugin again. It reads the current (now updated) variable values. Export as JSON, then convert:

```bash
python3 scripts/figma-vars-to-overrides.py tokens-after.json --skip-aliases -o after.json
```

> **Why re-export?** Tokens Studio reads whatever values the variables currently hold. After the varupdater plugin changed them in Step 2, the export reflects the new values.

**Step 4 — Generate audit config**

```bash
python3 scripts/generate-audit-config.py \
    --before before.json \
    --after  after.json \
    --fonts  Sora,Inter \
    --name   "My Rebrand" \
    -o       my-audit.json
```

This diffs every variable, detects which changed, and builds:
- `detect.colors` — old hex values to flag on nodes
- `detect.shadowBases` — old shadow base colors
- `detect.fonts` — allowed font families
- `fix.colorToVariable` — old hex → Figma variable path (for binding)
- `fix.colorReplace` — old hex → new hex (fallback for effect styles)
- `fix.fontReplace` — font catch-all

**Step 5 — Audit and fix**

1. Figma → Plugins → Development → **Design System Auditor**
2. Drop `my-audit.json`
3. **Run Audit** — scans all nodes, styles, effects
4. **Fix All** (dry run checked) — preview what would change
5. **Fix All** (dry run unchecked) — apply: binds variables, replaces colors, fixes fonts
6. **Run Audit** again — confirm zero issues
7. **Publish** the library

**Step 6 — Code tokens** (optional)

```bash
python3 scripts/generate-code-tokens.py after.json -o ./code-tokens
# Produces: tokens.css + tailwind-tokens.mjs
```

---

## Variable Updater Plugin

### Installation

1. In Figma → **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` from the repo root
3. Appears under **Plugins → Development → figma-updatevars-plugin**

### Features

- **Drag-and-drop UI** with file validation and preview table
- **Dry-run mode** — validate variable/collection names without writing
- **Auto font loading** — font variables trigger `figma.loadFontAsync` automatically
- **Substring collection matching** — `"Primitives"` matches `"_Primitives"`, etc.
- **Multi-mode support** — target `"Light mode"`, `"Dark mode"`, or omit for default
- **Live log** with color-coded output
- **Schema reference** — click Schema button for format docs

### Overrides JSON format

```json
[
  {
    "collection": "Primitives",
    "variable": "Colors/Brand/500",
    "value": "#7a5af8"
  },
  {
    "collection": "Color modes",
    "variable": "Colors/Effects/Shadows/shadow-xs",
    "mode": "Light mode",
    "value": "#09090b0d"
  },
  {
    "collection": "Radius",
    "variable": "radius-xl",
    "value": 16
  },
  {
    "collection": "Typography",
    "variable": "Font family/font-family-display",
    "value": "Sora"
  }
]
```

| Field        | Required | Description                                                                 |
|--------------|----------|-----------------------------------------------------------------------------|
| `collection` | Yes      | Collection name (substring match against Figma collection names)            |
| `variable`   | Yes      | Full variable path using `/` separators                                     |
| `mode`       | No       | Mode name (e.g. `Light mode`). Defaults to first mode.                      |
| `value`      | Yes      | Hex color (`"#6938ef"`), number (`16`), or string (`"Sora"`)               |

---

## Design System Auditor Plugin

### Installation

1. In Figma → **Plugins → Development → Import plugin from manifest…**
2. Select `audit/manifest.json`
3. Appears under **Plugins → Development → Design System Auditor**

### Features

- **Config-driven** — no hardcoded colors or fonts; everything comes from the JSON config
- **Detect**: hardcoded old colors on fills/strokes, wrong fonts, unbound variables, old shadow bases in effect styles, flagged paint/text/effect local styles
- **Fix All**: binds variables via `setBoundVariableForPaint`, replaces hex colors directly (for effects), replaces fonts via `loadFontAsync`
- **Dry-run mode** — preview all changes before applying
- **Summary cards** — nodes scanned, flagged colors, font issues, style issues
- **Publish badge** — green "PUBLISH READY" or red with issue count
- **Export JSON** — save full audit report

### Audit config format

```json
{
  "name": "My Theme Audit",
  "detect": {
    "colors": {
      "#old_hex": "label for reporting"
    },
    "fonts": ["AllowedFont1", "AllowedFont2"],
    "shadowBases": {
      "#old_shadow_hex": "label"
    }
  },
  "fix": {
    "colorToVariable": {
      "#old_hex": "Variable/Path/In/Figma"
    },
    "colorReplace": {
      "#old_hex": "#new_hex"
    },
    "fontReplace": {
      "OldFont": "NewFont",
      "*": "FallbackFont"
    }
  }
}
```

| Section | Field | Description |
|---------|-------|-------------|
| `detect.colors` | `hex → label` | Old-theme colors to flag on node fills/strokes and paint styles |
| `detect.fonts` | `string[]` | Allowed font families — any other font is flagged |
| `detect.shadowBases` | `hex → label` | Old shadow base hex values to flag in effect styles |
| `fix.colorToVariable` | `hex → variable path` | Old hex → Figma variable name (exact or substring match) for binding |
| `fix.colorReplace` | `hex → hex` | Direct hex swap — used for effect styles and as fallback |
| `fix.fontReplace` | `font → font` | Font replacement map; `"*"` is a catch-all |

---

## Scripts

### `scripts/figma-vars-to-overrides.py`

Converts Tokens Studio / Figma Variables JSON export (DTCG format) → overrides JSON.

```bash
python3 scripts/figma-vars-to-overrides.py export.json --skip-aliases -o overrides.json
python3 scripts/figma-vars-to-overrides.py export.json --collection Primitives -o primitives.json
```

| Flag | Description |
|------|-------------|
| `input` | Tokens Studio export JSON |
| `-o` | Output file (default: stdout) |
| `--skip-aliases` | Omit alias values like `{Colors.Brand.500}` (recommended) |
| `--collection` | Filter to collections matching this substring |

### `scripts/generate-audit-config.py`

Diffs before/after overrides → audit config JSON.

```bash
python3 scripts/generate-audit-config.py \
    --before before.json \
    --after  after.json \
    --fonts  Sora,Inter \
    --name   "My Rebrand" \
    -o       my-audit.json
```

| Flag | Description |
|------|-------------|
| `--before`, `-b` | Overrides JSON of old theme (before migration) |
| `--after`, `-a` | Overrides JSON of new theme (after migration) — **required** |
| `--fonts`, `-f` | Comma-separated allowed font families |
| `--name`, `-n` | Config label |
| `-o` | Output file (default: stdout) |

### `scripts/generate-code-tokens.py`

Overrides → CSS custom properties + Tailwind config module.

```bash
python3 scripts/generate-code-tokens.py overrides.json -o ./code-tokens
# Outputs: tokens.css + tailwind-tokens.mjs
```

| Flag | Description |
|------|-------------|
| `input` | Overrides JSON |
| `-o` | Output directory (default: current dir) |

**tokens.css** — CSS custom properties grouped by collection/mode:
```css
:root {
  --colors-brand-500: #7a5af8;
  --colors-gray-light-mode-500: #71717a;
}
[data-theme='dark'] {
  --colors-gray-dark-mode-500: #a0a0ab;
}
```

**tailwind-tokens.mjs** — ES module with nested objects:
```js
import tokens from './tailwind-tokens.mjs';
// tokens.colors, tokens.borderRadius, tokens.fontFamily, tokens.shadowColors
```

---

## Requirements

- **Figma** — any plan (plugins use the Plugin API, not the REST API)
- **Python 3.6+** — for scripts (no external dependencies)
- **Tokens Studio** (free tier) — for exporting Figma Variables as JSON

## Files

```
├── manifest.json                          # Variable Updater plugin manifest
├── code.js                                # Variable Updater backend
├── ui.html                                # Variable Updater UI
├── audit/
│   ├── manifest.json                      # Auditor plugin manifest
│   ├── code.js                            # Auditor backend (audit + fix engine)
│   ├── ui.html                            # Auditor UI (config drop, cards, log)
│   └── configs/
│       └── kryzai-audit.json              # Example: KryzAI rebranding config
├── scripts/
│   ├── figma-vars-to-overrides.py         # Tokens Studio export → overrides
│   ├── generate-audit-config.py           # Before/after diff → audit config
│   └── generate-code-tokens.py            # Overrides → CSS + Tailwind
└── README.md
```
