#!/usr/bin/env python3
"""
figma-vars-to-overrides.py

Reads a Figma Variables JSON export (DTCG format) and outputs
an overrides JSON array compatible with the figma-updatevars-plugin.

Usage:
    python3 figma-vars-to-overrides.py <input.json> [-o output.json]

The input file is the JSON exported from Figma Variables
(e.g. via Tokens Studio or the Variables REST API / Plugin API).

Structure expected:
    {
      "<set-number>": {
        " <Collection>/<Mode>": {
          "<Group>": {
            "<VarName>": { "$value": "...", "$type": "..." },
            ...
          }
        }
      },
      "_<Collection>/<Mode>": { ... },
      "$themes": [...],
      "$metadata": { ... }
    }

Output: an array of override objects:
    [
      { "collection": "...", "variable": "...", "mode": "...", "value": ... },
      ...
    ]
"""

import json
import sys
import argparse
import re


def is_alias(val):
    """Check if a value is a Figma alias reference like {Colors.Brand.500}"""
    return isinstance(val, str) and val.startswith("{") and val.endswith("}")


def parse_hex_color(val):
    """Normalise a hex color string."""
    if isinstance(val, str) and val.startswith("#"):
        return val.lower()
    return None


def extract_leaf_vars(obj, path_parts=None):
    """
    Recursively walk a nested dict and yield (path, value, type) tuples
    for every leaf variable (dict with $value).
    """
    if path_parts is None:
        path_parts = []

    if not isinstance(obj, dict):
        return

    # Leaf: has $value
    if "$value" in obj:
        yield ("/".join(path_parts), obj["$value"], obj.get("$type", ""))
        return

    for key, child in obj.items():
        # Skip metadata keys
        if key.startswith("$"):
            continue
        yield from extract_leaf_vars(child, path_parts + [key])


def parse_collection_mode(set_key):
    """
    Parse a set key like " Color modes/Light mode" or "_Primitives/Style"
    into (collection_name, mode_name).
    """
    key = set_key.strip()
    # Remove leading underscore for hidden collections
    if key.startswith("_"):
        key = key[1:]
    parts = key.split("/", 1)
    if len(parts) == 2:
        return parts[0].strip(), parts[1].strip()
    return parts[0].strip(), None


def coerce_value(raw_value, var_type):
    """
    Convert the raw $value to the appropriate type for the override.
    - Aliases are kept as-is (string with {})
    - Colors stay as hex strings
    - Numbers become float/int
    - Everything else stays as string
    """
    if is_alias(raw_value):
        return raw_value

    if isinstance(raw_value, (int, float)):
        # Keep numbers as numbers
        if isinstance(raw_value, float) and raw_value == int(raw_value):
            return int(raw_value)
        return raw_value

    if isinstance(raw_value, str):
        hex_val = parse_hex_color(raw_value)
        if hex_val:
            return hex_val

        # Try numeric
        try:
            f = float(raw_value)
            return int(f) if f == int(f) else f
        except (ValueError, TypeError):
            pass

        return raw_value

    # Composite values (e.g. objects) — serialise as-is
    return raw_value


def main():
    parser = argparse.ArgumentParser(
        description="Convert a Figma Variables JSON export to plugin-compatible overrides"
    )
    parser.add_argument("input", help="Path to the Figma Variables JSON export")
    parser.add_argument(
        "-o", "--output",
        help="Output file path (default: stdout)",
        default=None,
    )
    parser.add_argument(
        "--skip-aliases",
        action="store_true",
        help="Skip variables whose value is an alias reference (e.g. {Colors.Brand.500})",
    )
    parser.add_argument(
        "--collection",
        help="Only include variables from collections matching this substring",
        default=None,
    )
    args = parser.parse_args()

    with open(args.input, "r") as f:
        data = json.load(f)

    overrides = []
    skipped_aliases = 0
    skipped_meta = 0

    # Collection mapping: figure out which numeric keys map to which collections
    # Also handle direct _Collection/Mode keys
    collection_modes = {}  # set_key -> (collection, mode)
    multi_mode_collections = {}  # collection -> set of modes

    for set_key in data:
        if set_key in ("$themes", "$metadata"):
            continue
        if not isinstance(data[set_key], dict):
            continue

        sub_keys = list(data[set_key].keys())

        # Check if sub-keys are " Collection/Mode" patterns
        has_mode_keys = any(
            "/" in sk and not sk.startswith("$") for sk in sub_keys
        )

        if has_mode_keys:
            for mode_key in sub_keys:
                if mode_key.startswith("$"):
                    continue
                col, mode = parse_collection_mode(mode_key)
                full_key = (set_key, mode_key)
                collection_modes[full_key] = (col, mode)
                if col not in multi_mode_collections:
                    multi_mode_collections[col] = set()
                if mode:
                    multi_mode_collections[col].add(mode)
        else:
            # Single-mode set like _Primitives/Style — the set_key itself is the collection
            col, mode = parse_collection_mode(set_key)
            collection_modes[(set_key, None)] = (col, mode)
            if col not in multi_mode_collections:
                multi_mode_collections[col] = set()
            if mode:
                multi_mode_collections[col].add(mode)

    # Now extract variables
    for (set_key, mode_key), (collection, mode) in sorted(
        collection_modes.items(), key=lambda x: x[1][0]
    ):
        if args.collection and args.collection not in collection:
            continue

        # Get the variable tree
        if mode_key is not None:
            var_tree = data[set_key][mode_key]
        else:
            var_tree = data[set_key]

        # Determine if we need to include mode in the output
        has_multiple_modes = len(multi_mode_collections.get(collection, set())) > 1

        for var_path, raw_value, var_type in extract_leaf_vars(var_tree):
            if args.skip_aliases and is_alias(raw_value):
                skipped_aliases += 1
                continue

            value = coerce_value(raw_value, var_type)

            entry = {
                "collection": collection,
                "variable": var_path,
            }

            # Only include mode if the collection has multiple modes
            if has_multiple_modes and mode:
                entry["mode"] = mode

            entry["value"] = value

            overrides.append(entry)

    # Output
    result = json.dumps(overrides, indent=2, ensure_ascii=False)

    if args.output:
        with open(args.output, "w") as f:
            f.write(result + "\n")
        print(
            f"Wrote {len(overrides)} overrides to {args.output}",
            file=sys.stderr,
        )
    else:
        print(result)

    # Summary to stderr
    print(f"Total variables: {len(overrides)}", file=sys.stderr)
    if skipped_aliases:
        print(f"Skipped aliases: {skipped_aliases}", file=sys.stderr)


if __name__ == "__main__":
    main()
