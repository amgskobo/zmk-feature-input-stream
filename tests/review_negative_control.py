"""Restore one defect in an isolated container source copy for owner assertions."""

import argparse
from pathlib import Path
import re


FAULTS = {
    "lease-expiry": (
        "src/studio/input_stream_handler.c",
        "if (streaming_enabled && stream_lease_deadline <= k_uptime_get()) {",
        "if (false && streaming_enabled && stream_lease_deadline <= k_uptime_get()) {",
    ),
    "late-renewal": (
        "src/studio/input_stream_handler.c",
        "? renew_stream(req.request_type.enable_stream.stream_epoch)",
        "? set_stream_enabled(true)",
    ),
    "default-filter": (
        "src/studio/input_stream_handler.c",
        "for (uint32_t index = default_index; index < ARRAY_SIZE(ids); index++) {",
        "for (uint32_t index = 0; index < ARRAY_SIZE(ids); index++) {",
    ),
    "layer-id-mask": (
        "src/studio/input_stream_handler.c",
        "out->active_layer_mask |= BIT(index);",
        "out->active_layer_mask |= BIT(ids[index]);",
    ),
    "provisional-mark": (
        "web/src/App.tsx",
        "setEverPressedKeys(pending.before.everPressedKeys);",
        "/* Negative control retains a provisional mark. */",
    ),
    "inactive-fallback": (
        "web/src/bindings.ts",
        "if (activeLayerMask !== null && (i >= 32 || ((activeLayerMask >>> i) & 1) === 0)) continue;",
        "/* Negative control includes inactive layers. */",
    ),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fault", choices=FAULTS)
    parser.add_argument("isolated_owner", type=Path)
    args = parser.parse_args()
    owner = Path(__file__).resolve().parents[1]
    isolated = args.isolated_owner.resolve()
    if isolated == owner or isolated.is_relative_to(owner):
        parser.error("Use an isolated container source copy")
    relative, old, new = FAULTS[args.fault]
    path = isolated / relative
    content = path.read_text()
    tokens = re.findall(
        r"[A-Za-z_]\w*|\d+|===|!==|==|!=|<=|>=|>>>|>>|<<|\|\||&&|->|\S", old
    )
    pattern = r"\s*".join(re.escape(token) for token in tokens)
    # Only the timer callback is changed, preserving explicit-enable handling.
    if args.fault == "lease-expiry":
        begin = content.index("static void stream_lease_expired(")
        end = content.index("static K_TIMER_DEFINE", begin)
        prefix, body, suffix = content[:begin], content[begin:end], content[end:]
    else:
        prefix, body, suffix = "", content, ""
    if len(list(re.finditer(pattern, body))) != 1:
        parser.error("Expected exactly one control site in the selected source")
    path.write_text(prefix + re.sub(pattern, lambda _: new, body, count=1) + suffix)
    print("Applied isolated negative control: " + args.fault)


if __name__ == "__main__":
    main()
