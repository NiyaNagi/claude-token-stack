"""Headroom compression helper for tokenstack PostToolUse hook.
stdin: {"texts": [str, ...], "tool": str}  stdout: {"texts": [str|null, ...]}  (null = keep original)
Originals land in ~/.headroom/ccr_store.db so the headroom MCP `headroom_retrieve` tool can restore them.
"""
import json, os, sys

os.environ.setdefault("HEADROOM_BEACON", "off")


def main():
    req = json.load(sys.stdin)
    from headroom import compress
    out = []
    for text in req.get("texts", []):
        try:
            msgs = [
                {"role": "user", "content": "run"},
                {"role": "assistant", "content": [{"type": "tool_use", "id": "t1", "name": req.get("tool", "Bash"), "input": {}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": text}]},
            ]
            r = compress(msgs, model="claude-sonnet-4-5-20250929")
            c = r.messages[-1]["content"][0]["content"]
            if not isinstance(c, str):
                c = "\n".join(b.get("text", "") for b in c if isinstance(b, dict))
            out.append(c if c and len(c) < len(text) * 0.75 else None)
        except Exception:
            out.append(None)
    json.dump({"texts": out}, sys.stdout)


if __name__ == "__main__":
    main()
