#!/usr/bin/env python3
"""Merge or remove the workstation's keys in Herdr's keys.json.

    merge-keys.py add    <ours.json> <platform> <keys.json>
    merge-keys.py remove <ours.json> <platform> <keys.json>

add: binds each of our keys only when that key is free and our action has no key yet;
never replaces a key the person already uses (it reports those instead).
remove: unbinds only keys that still hold exactly our action.
"""
import json
import os
import sys
import tempfile


def load(path, default):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save(path, doc):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".keys.", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
        f.write("\n")
    os.replace(tmp, path)


def main():
    mode, ours_path, platform, keys_path = sys.argv[1:5]
    ours = load(ours_path, {}).get(platform, {})
    doc = load(keys_path, {})
    changed = False
    for section, bindings in ours.items():
        current = doc.setdefault(section, {})
        for key, action in bindings.items():
            if mode == "add":
                if key in current:
                    if current[key] != action:
                        print(f"  key {key} is already yours ({current[key]!r}); not bound. Bind {action!r} yourself.")
                    continue
                if action in current.values():
                    continue
                current[key] = action
                changed = True
                print(f"  bound {key}")
            elif mode == "remove" and current.get(key) == action:
                del current[key]
                changed = True
                print(f"  unbound {key}")
        if not current:
            doc.pop(section, None)
    if changed:
        save(keys_path, doc)


if __name__ == "__main__":
    main()
