"""Cleaning and splitting raw .txt content into upload-sized parts (see docs/data_model.md's txt_parts)."""

import re

from .constants import PART_TARGET

# Control chars, the U+FFFD decode-error marker, BOM, and invisible
# zero-width / bidi-formatting chars that are not human-readable text.
_INVALID_CHARS_RE = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f"
    "\ufffd\ufeff\u200b-\u200f\u202a-\u202e\u2060-\u206f]"
)
# Tabs, NBSP, and other Unicode space variants; collapsed to one space.
_SPACE_RUN_RE = re.compile(
    "[ \t\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000]+"
)


def _clean_line(line: str) -> str:
    line = _INVALID_CHARS_RE.sub("", line)
    line = _SPACE_RUN_RE.sub(" ", line)
    return line.strip()


def preprocess_text(content: bytes) -> bytes:
    lines = content.decode("utf-8", errors="replace").splitlines()
    out: list[str] = []
    for line in lines:
        line = _clean_line(line)
        if line:
            if out and out[-1] != "":
                out.append("")
            out.append(line)
        else:
            if out and out[-1] != "":
                out.append("")
    return "\n".join(out).encode("utf-8")


def split_parts(content: bytes, target: int = PART_TARGET) -> list[bytes]:
    paras = re.split(rb"\r?\n\r?\n", content)
    parts, cur = [], b""
    for p in paras:
        chunk = p + b"\n\n"
        if cur and len(cur) + len(chunk) > target:
            parts.append(cur)
            cur = chunk
        else:
            cur += chunk
    if cur:
        parts.append(cur)
    return parts
