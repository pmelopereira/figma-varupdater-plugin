#!/usr/bin/env python3
"""
generate-audit-config.py

Generates a Design System Auditor config JSON by diffing two
overrides files (before/after), or from a single overrides file.

Usage:
    # Full diff mode (recommended):
    python3 generate-audit-config.py \\
        --before old-overrides.json \\
        --after  new-overrides.json \\
        --fonts  Sora,Inter \\
        --name   "My Migration" \\
        -o       my-audit.json

    # Single-file mode (generates fix mappings only, detect left empty):
    python3 generate-audit-config.py \\
        --after new-overrides.json \\
        --fonts Sora,Inter \\
        -o      my-audit.json

The overrides files use the same format as figma-updatevars-plugin:
    [
      { "collection": "...", "variable": "...", "mode": "...", "value": "..." },
      ...
    ]

Workflow:
    1. Export Figma Variables BEFORE migration (Tokens Studio → figma-vars-to-overrides.py)
    2. Apply overrides with figma-updatevars-plugin
    3. Export AFTER (same flow)
    4. Run this script with --before and --after
    5. Drop the generated JSON into the Design System Auditor plugin
"""

import json
import sys
import argparse
import os

# Shadow-related variable name patterns (substring match)
SHADOW_PATTERNS = ["shadow", "effect"]


def load_overrides(path):
    """Load overrides JSON array."""
    with open(path, "r") as f:
        data = json.load(f)
    if not isinstance(data, list):
        print(f"Error: {path} must be a JSON array of overrides", file=sys.stderr)
        sys.exit(1)
    return data


def make_key(entry):
    """Create a unique key for a variable entry."""
    col = entry.get("collection", "")
    var = entry.get("variable", "")
    mode = entry.get("mode", "")
    return f"{col}|{var}|{mode}"


def is_color(val):
    """Check if a value looks like a hex color."""
    return isinstance(val, str) and val.startswith("#") and len(val) in (4, 7, 9)


def normalise_hex(val):
    """Normalise hex to lowercase 7-char (#rrggbb)."""
    if not isinstance(val, str) or not val.startswith("#"):
        return val
    h = val.lower()
    if len(h) == 4:
        h = "#" + h[1]*2 + h[2]*2 + h[3]*2
    return h[:7]  # strip alpha for detection


def is_shadow_variable(entry):
    """Check if a variable is shadow-related (by name or collection)."""
    name = (entry.get("variable", "") + " " + entry.get("collection", "")).lower()
    return any(p in name for p in SHADOW_PATTERNS)


def var_path(entry):
    """Build the Figma variable path: Collection/Variable."""
    col = entry.get("collection", "")
    var = entry.get("variable", "")
    return f"{col}/{var}" if col else var


def generate_config(before_path, after_path, fonts, name, shadow_bases_extra=None):
    """Generate audit config from before/after overrides."""

    after = load_overrides(after_path)
    after_map = {make_key(e): e for e in after}

    detect_colors = {}
    detect_shadow_bases = {}
    fix_color_to_variable = {}
    fix_color_replace = {}

    if before_path:
        before = load_overrides(before_path)
        before_map = {make_key(e): e for e in before}

        # Find all variables that changed
        for key, old_entry in before_map.items():
            new_entry = after_map.get(key)
            if not new_entry:
                continue

            old_val = old_entry.get("value", "")
            new_val = new_entry.get("value", "")

            if not is_color(old_val) or not is_color(new_val):
                continue

            old_hex = normalise_hex(old_val)
            new_hex = normalise_hex(new_val)

            if old_hex == new_hex:
                continue

            # Build label from variable name
            var_name = old_entry.get("variable", "unknown")
            label = var_name.replace("/", "-").lower()

            # Add to detect
            if is_shadow_variable(old_entry):
                detect_shadow_bases[old_hex] = label
                fix_color_replace[old_hex] = new_hex
            else:
                detect_colors[old_hex] = label

            # Map old hex → new variable path
            vpath = var_path(new_entry)
            fix_color_to_variable[old_hex] = vpath

            # Also add colorReplace as fallback (for effect styles etc)
            if old_hex not in fix_color_replace:
                fix_color_replace[old_hex] = new_hex

    else:
        # Single-file mode: can only generate fix mappings
        # User will need to fill detect section manually
        for entry in after:
            val = entry.get("value", "")
            if is_color(val):
                vpath = var_path(entry)
                hex_val = normalise_hex(val)
                # We know the new value and variable path, but not the old value
                # Can't populate detect.colors without knowing old values

    # Build config
    config = {"name": name or "Audit config"}

    config["detect"] = {}
    if detect_colors:
        config["detect"]["colors"] = dict(sorted(detect_colors.items()))
    if fonts:
        config["detect"]["fonts"] = fonts
    if detect_shadow_bases:
        config["detect"]["shadowBases"] = dict(sorted(detect_shadow_bases.items()))

    config["fix"] = {}
    if fix_color_to_variable:
        config["fix"]["colorToVariable"] = dict(sorted(fix_color_to_variable.items()))
    if fix_color_replace:
        config["fix"]["colorReplace"] = dict(sorted(fix_color_replace.items()))
    if fonts:
        # Default: replace any non-allowed font with the first allowed font
        config["fix"]["fontReplace"] = {"*": fonts[0]}

    return config


def main():
    parser = argparse.ArgumentParser(
        description="Generate Design System Auditor config from overrides diff"
    )
    parser.add_argument(
        "--before", "-b",
        help="Overrides JSON of OLD theme values (before migration)"
    )
    parser.add_argument(
        "--after", "-a", required=True,
        help="Overrides JSON of NEW theme values (after migration)"
    )
    parser.add_argument(
        "--fonts", "-f",
        help="Comma-separated list of allowed font families (e.g. 'Sora,Inter')"
    )
    parser.add_argument(
        "--name", "-n",
        help="Config name / label"
    )
    parser.add_argument(
        "--output", "-o",
        help="Output file path (default: stdout)"
    )

    args = parser.parse_args()

    fonts = [f.strip() for f in args.fonts.split(",")] if args.fonts else []

    if not args.before:
        print("Warning: no --before file provided. Only fix mappings will be "
              "generated (detect section will be empty).", file=sys.stderr)
        print("For full config, provide both --before and --after.", file=sys.stderr)

    config = generate_config(args.before, args.after, fonts, args.name)

    output_json = json.dumps(config, indent=2, ensure_ascii=False)

    if args.output:
        os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
        with open(args.output, "w") as f:
            f.write(output_json + "\n")
        # Stats
        dc = len(config.get("detect", {}).get("colors", {}))
        ds = len(config.get("detect", {}).get("shadowBases", {}))
        df = len(config.get("detect", {}).get("fonts", []))
        fc = len(config.get("fix", {}).get("colorToVariable", {}))
        fr = len(config.get("fix", {}).get("colorReplace", {}))
        ff = len(config.get("fix", {}).get("fontReplace", {}))
        print(f"Wrote {args.output}")
        print(f"  Detect: {dc} colors, {ds} shadow bases, {df} fonts")
        print(f"  Fix:    {fc} color→variable, {fr} color→hex, {ff} font→font")
    else:
        print(output_json)


if __name__ == "__main__":
    main()
