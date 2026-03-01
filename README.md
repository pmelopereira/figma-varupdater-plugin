# figma-varupdater-plugin

A Figma plugin that batch-updates Local Variables from a JSON file, plus a companion Python script to generate that JSON from a Tokens Studio export.

## Workflow

```
Tokens Studio export (.json)
        │
        ▼
scripts/figma-vars-to-overrides.py   ← converts to overrides format
        │
        ▼
   overrides.json                    ← portable, editable
        │
        ▼
  Figma Plugin (UI)                  ← drop file, preview, apply
        │
        ▼
  Local Variables updated ✓
```

## Figma Plugin

### Installation

1. In Figma, go to **Plugins → Development → Import plugin from manifest…**
2. Select `manifest.json` from this folder
3. The plugin appears under **Plugins → Development → figma-varupdater-plugin**

### Usage

1. Open any Figma file with Local Variables
2. Run the plugin from **Plugins → Development**
3. Drop (or browse) a JSON overrides file into the UI
4. Preview the changes in the table — color swatches are shown for hex values
5. Optionally check **Dry run** to validate without writing
6. Click **Apply Overrides**
7. Watch the live log for results

### Features

- **Drag-and-drop UI** with file validation and preview table
- **Dry-run mode** — validate variable/collection names without writing changes
- **Auto font loading** — font variables (e.g. `font-family-display = "Sora"`) automatically trigger `figma.loadFontAsync` before applying
- **Substring collection matching** — `"Primitives"` matches `"_Primitives"`, `"Color modes"` matches `"1. Color modes"`, etc.
- **Multi-mode support** — target a specific mode (`"Light mode"`, `"Dark mode"`) or omit to use the collection's default
- **Live log** with color-coded output (green = OK, red = error, yellow = summary)
- **Schema reference** — click the Schema button in the UI for format docs

## JSON Overrides Format

The overrides file is a JSON array of objects:

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
| `variable`   | Yes      | Full variable path using `/` separators (e.g. `Colors/Gray (light mode)/500`) |
| `mode`       | No       | Mode name (e.g. `Light mode`, `Dark mode`). Defaults to the first mode.     |
| `value`      | Yes      | The value to set — see types below                                          |

### Value types

| Type   | Example                  | Notes                                    |
|--------|--------------------------|------------------------------------------|
| Color  | `"#6938ef"`, `"#09090b1a"` | 6-digit or 8-digit hex (with alpha)      |
| Number | `12`, `16.5`             | Used for radii, spacing, widths          |
| String | `"Sora"`                 | Used for font families and other strings |

## Companion Script

### `scripts/figma-vars-to-overrides.py`

Converts a Tokens Studio / Figma Variables JSON export (DTCG format with `$value` / `$type`) into the overrides JSON array consumed by the plugin.

### Requirements

Python 3.6+ (no external dependencies).

### Usage

```bash
# Dump all variables (including alias references)
python3 scripts/figma-vars-to-overrides.py export.json -o all-overrides.json

# Skip aliases — only direct/resolved values (recommended for retheming)
python3 scripts/figma-vars-to-overrides.py export.json --skip-aliases -o overrides.json

# Filter to a specific collection
python3 scripts/figma-vars-to-overrides.py export.json --collection Primitives -o primitives.json
```

### Options

| Flag              | Description                                                        |
|-------------------|--------------------------------------------------------------------|
| `input`           | Path to the Figma Variables JSON export                            |
| `-o`, `--output`  | Output file path (defaults to stdout)                              |
| `--skip-aliases`  | Omit variables whose value is an alias (e.g. `{Colors.Brand.500}`) |
| `--collection`    | Only include variables from collections matching this substring    |

### Why `--skip-aliases`?

Tokens Studio exports include both **primitive** variables (direct hex/number values) and **semantic** variables (alias references like `{Colors.Brand.500}`). When retheming, you typically only need to override the primitives — semantic tokens referencing them will cascade automatically. Using `--skip-aliases` reduces a ~1090-variable export down to ~516 actionable overrides.

## Files

```
├── manifest.json                       # Figma plugin manifest
├── code.js                             # Plugin backend (runs in Figma sandbox)
├── ui.html                             # Plugin UI (drop zone, preview, log)
├── scripts/
│   └── figma-vars-to-overrides.py      # Export → overrides converter
└── README.md
```
