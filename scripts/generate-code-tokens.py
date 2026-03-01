#!/usr/bin/env python3
"""
generate-code-tokens.py

Reads a figma-varupdater-plugin overrides JSON and generates:
  1. CSS custom properties (tokens.css)
  2. Tailwind CSS config extension (tailwind-tokens.mjs)

Usage:
    python3 generate-code-tokens.py overrides.json [-o output-dir]

Produces:
    output-dir/tokens.css
    output-dir/tailwind-tokens.mjs
"""

import json
import argparse
import os
import re
import sys


def slugify(name):
    """Convert a variable path to a CSS-friendly slug."""
    s = name.lower()
    s = s.replace("/", "-").replace(" ", "-").replace("(", "").replace(")", "")
    s = re.sub(r"[^a-z0-9\-]", "-", s)
    s = re.sub(r"-+", "-", s)
    s = s.strip("-")
    return s


def hex_to_css(val):
    """Ensure a hex value is valid CSS."""
    if isinstance(val, str) and val.startswith("#"):
        return val
    return str(val)


def group_by_collection(overrides):
    """Group overrides by collection name."""
    groups = {}
    for ov in overrides:
        col = ov["collection"]
        if col not in groups:
            groups[col] = []
        groups[col].append(ov)
    return groups


def generate_css(overrides, collections_order=None):
    """Generate CSS custom properties from overrides."""
    lines = []
    lines.append("/* Auto-generated from figma-varupdater-plugin overrides */")
    lines.append("/* Do not edit manually — regenerate with generate-code-tokens.py */")
    lines.append("")

    groups = group_by_collection(overrides)
    if collections_order:
        ordered_keys = [k for k in collections_order if k in groups]
        ordered_keys += [k for k in groups if k not in ordered_keys]
    else:
        ordered_keys = sorted(groups.keys())

    # Split by mode
    for col_name in ordered_keys:
        items = groups[col_name]

        # Group by mode
        by_mode = {}
        for ov in items:
            mode = ov.get("mode", "default")
            if mode not in by_mode:
                by_mode[mode] = []
            by_mode[mode].append(ov)

        for mode, mode_items in by_mode.items():
            if mode == "default":
                lines.append(":root {")
                lines.append(f"  /* {col_name} */")
            elif mode == "Light mode":
                lines.append(":root, [data-theme='light'] {")
                lines.append(f"  /* {col_name} — Light mode */")
            elif mode == "Dark mode":
                lines.append("[data-theme='dark'] {")
                lines.append(f"  /* {col_name} — Dark mode */")
            else:
                lines.append(f"/* {col_name} — {mode} */")
                lines.append(":root {")

            for ov in mode_items:
                slug = slugify(ov["variable"])
                val = ov["value"]

                if isinstance(val, str) and val.startswith("#"):
                    css_val = val
                elif isinstance(val, (int, float)):
                    # Radii and spacing — output as px
                    css_val = f"{val}px"
                else:
                    css_val = f'"{val}"' if isinstance(val, str) else str(val)

                lines.append(f"  --{slug}: {css_val};")

            lines.append("}")
            lines.append("")

    return "\n".join(lines)


def generate_tailwind(overrides):
    """Generate a Tailwind config extension module from overrides."""
    lines = []
    lines.append("// Auto-generated from figma-varupdater-plugin overrides")
    lines.append("// Do not edit manually — regenerate with generate-code-tokens.py")
    lines.append("")
    lines.append("const tokens = {};")
    lines.append("")

    # Extract by category
    colors = {}  # nested: { groupName: { shade: hex } }
    radii = {}
    fonts = {}

    for ov in overrides:
        var_path = ov["variable"]
        val = ov["value"]
        col = ov["collection"]

        # Colors: Colors/Brand/500 → brand: { 500: '#hex' }
        if isinstance(val, str) and val.startswith("#") and col in ("Primitives",):
            parts = var_path.split("/")
            if len(parts) >= 2 and parts[0] == "Colors":
                group = slugify(parts[1])
                shade = parts[-1] if len(parts) > 2 else "DEFAULT"
                if group not in colors:
                    colors[group] = {}
                colors[group][shade] = val

        # Radius
        if col in ("Radius",) and isinstance(val, (int, float)):
            name = slugify(var_path)
            radii[name] = val

        # Fonts
        if col in ("Typography",) and isinstance(val, str) and not val.startswith("#"):
            name = slugify(var_path)
            fonts[name] = val

    # --- Colors ---
    lines.append("tokens.colors = {")
    for group in sorted(colors.keys()):
        shades = colors[group]
        lines.append(f"  '{group}': {{")
        for shade in sorted(shades.keys(), key=lambda s: int(s) if s.isdigit() else 0):
            lines.append(f"    '{shade}': '{shades[shade]}',")
        lines.append("  },")
    lines.append("};")
    lines.append("")

    # --- Border Radius ---
    if radii:
        lines.append("tokens.borderRadius = {")
        for name in sorted(radii.keys()):
            val = radii[name]
            lines.append(f"  '{name}': '{val}px',")
        lines.append("};")
        lines.append("")

    # --- Font Family ---
    if fonts:
        lines.append("tokens.fontFamily = {")
        for name in sorted(fonts.keys()):
            val = fonts[name]
            lines.append(f"  '{name}': ['{val}', 'sans-serif'],")
        lines.append("};")
        lines.append("")

    # --- Shadow colors (from Color modes with mode) ---
    lm_shadows = {}
    dm_shadows = {}
    for ov in overrides:
        if ov["collection"] not in ("Color modes",):
            continue
        if "shadow" not in ov["variable"].lower():
            continue
        val = ov["value"]
        if not isinstance(val, str) or not val.startswith("#"):
            continue
        name = slugify(ov["variable"])
        if ov.get("mode") == "Light mode":
            lm_shadows[name] = val
        elif ov.get("mode") == "Dark mode":
            dm_shadows[name] = val

    if lm_shadows or dm_shadows:
        lines.append("tokens.shadowColors = {")
        lines.append("  light: {")
        for name in sorted(lm_shadows.keys()):
            lines.append(f"    '{name}': '{lm_shadows[name]}',")
        lines.append("  },")
        lines.append("  dark: {")
        for name in sorted(dm_shadows.keys()):
            lines.append(f"    '{name}': '{dm_shadows[name]}',")
        lines.append("  },")
        lines.append("};")
        lines.append("")

    lines.append("export default tokens;")
    lines.append("")

    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(
        description="Generate CSS custom properties and Tailwind config from overrides JSON"
    )
    parser.add_argument("input", help="Path to the overrides JSON file")
    parser.add_argument(
        "-o", "--output-dir",
        help="Output directory (default: current directory)",
        default=".",
    )
    args = parser.parse_args()

    with open(args.input, "r") as f:
        overrides = json.load(f)

    if not isinstance(overrides, list):
        print("Error: input must be a JSON array of override objects", file=sys.stderr)
        sys.exit(1)

    os.makedirs(args.output_dir, exist_ok=True)

    # Generate CSS
    css_content = generate_css(overrides, ["Primitives", "Radius", "Typography", "Color modes"])
    css_path = os.path.join(args.output_dir, "tokens.css")
    with open(css_path, "w") as f:
        f.write(css_content)
    print(f"Wrote {css_path}", file=sys.stderr)

    # Generate Tailwind
    tw_content = generate_tailwind(overrides)
    tw_path = os.path.join(args.output_dir, "tailwind-tokens.mjs")
    with open(tw_path, "w") as f:
        f.write(tw_content)
    print(f"Wrote {tw_path}", file=sys.stderr)

    print(f"\nDone — {len(overrides)} overrides → CSS + Tailwind", file=sys.stderr)


if __name__ == "__main__":
    main()
