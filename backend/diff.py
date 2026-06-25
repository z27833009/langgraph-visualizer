"""Recursive state diff. The backend is the single source of truth for deltas.

``diff_state(old, new)`` returns::

    {
        "added":   {dotted.key: new_value, ...},
        "changed": {dotted.key: {"old": ..., "new": ...}, ...},
        "removed": {dotted.key: old_value, ...},
    }

Nested dicts are walked recursively and reported by dotted path
(e.g. ``"user.name"``). Lists and scalars are compared by equality.
"""

from __future__ import annotations

from typing import Any


def _join(prefix: str, key: str) -> str:
    return f"{prefix}.{key}" if prefix else str(key)


def _walk(old: dict, new: dict, prefix: str, out: dict) -> None:
    old_keys = set(old.keys())
    new_keys = set(new.keys())

    for key in new_keys - old_keys:
        out["added"][_join(prefix, key)] = new[key]

    for key in old_keys - new_keys:
        out["removed"][_join(prefix, key)] = old[key]

    for key in old_keys & new_keys:
        o, n = old[key], new[key]
        path = _join(prefix, key)
        if o == n:
            continue
        if isinstance(o, dict) and isinstance(n, dict):
            _walk(o, n, path, out)
        else:
            out["changed"][path] = {"old": o, "new": n}


def diff_state(old: Any, new: Any) -> dict:
    """Diff two state dicts. Non-dict inputs are coerced to ``{}``."""
    out = {"added": {}, "changed": {}, "removed": {}}
    old = old if isinstance(old, dict) else {}
    new = new if isinstance(new, dict) else {}
    _walk(old, new, "", out)
    return out
