"""Replace EPUB images and constrain their XHTML display size.

The input EPUB is never modified. The output EPUB preserves ZIP member metadata
and keeps the required ``mimetype`` member first and uncompressed.

Copied from ../replace_epub_images.py (a standalone script maintained outside
this repo) rather than reimplemented, plus replace_images_dir() to drive it
over a whole directory for --replace-images.
"""

from __future__ import annotations

import base64
import html
import posixpath
import re
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit
from xml.etree import ElementTree

from .logger import Logger

PLACEHOLDER_WIDTH = 24
PLACEHOLDER_HEIGHT = 12
XHTML_EXTENSIONS = {".xhtml", ".html", ".htm"}
FORCED_STYLE = (
    b"width:24px !important; height:12px !important; "
    b"min-width:24px !important; min-height:12px !important; "
    b"max-width:24px !important; max-height:12px !important; "
    b"font-size:0 !important; line-height:0 !important; "
    b"color:transparent !important; overflow:hidden !important"
)

# Valid 24x12 empty-frame images with a subtle gray border. JPEG and BMP use a
# white interior because those formats do not reliably support transparency.
PLACEHOLDERS = {
    ".png": base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAABgAAAAMCAYAAAB4MH11AAAANUlEQVR4nGPsmjjzPwMNAQsD"
        "AwNDaV4aIy0M75406z8TLQxGBqMWjFowagE0J3dPmkWz4gIAHG0JhQ5O7BwAAAAASUVORK5C"
        "YII="
    ),
    ".jpg": base64.b64decode(
        "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
        "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwh"
        "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAAR"
        "CAAMABgDASIAAhEBAxEB/8QAGAAAAgMAAAAAAAAAAAAAAAAAAAYDBAf/xAAlEAACAgICAQIH"
        "AAAAAAAAAAABAgMEAAURIQYVIhZUVZKT0dL/xAAVAQEBAAAAAAAAAAAAAAAAAAABAv/EABYR"
        "AQEBAAAAAAAAAAAAAAAAAAABEf/aAAwDAQACEQMRAD8A2XU6nWyaajJJr6ju1eMszQqSSVHZ"
        "PGXPRdV9Mp/gX9YhVfNtlUqQ1o4KhSJFjUsjckAcd+7Jvj7a/L0/sb+scoNe21Otj016SPX1"
        "Eda8hVlhUEEKeweMMTrXm2yt1Jq0kFQJKjRsVRuQCOOvdhlQV//Z"
    ),
    ".gif": base64.b64decode(
        "R0lGODlhGAAMAIEAAP///4qRmQAAAAAAACH5BAEAAAAALAAAAAAYAAwAAAg0AAMIHEiwoEGC"
        "ABIqXMiwIQCBDiM6hCixYkKKFiVizDgxAEeNHj92FDmSJMONJh8eXMkyIAA7"
    ),
    ".bmp": base64.b64decode(
        "Qk1uAAAAAAAAAD4AAAAoAAAAGAAAAAwAAAABAAEAAAAAADAAAADEDgAAxA4AAAIAAAACAAAA"
        "AAAAAP///wAAAAAAf//+AH///gB///4Af//+AH///gB///4Af//+AH///gB///4Af//+AAAA"
        "AAA="
    ),
    ".svg": (
        b'<?xml version="1.0" encoding="UTF-8"?>\n'
        b'<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12" '
        b'viewBox="0 0 24 12"><rect x="0.5" y="0.5" width="23" height="11" '
        b'fill="none" stroke="#8a9199" stroke-width="1"/></svg>\n'
    ),
}

EXTENSION_ALIASES = {
    ".jpeg": ".jpg",
    ".jpe": ".jpg",
    ".svgz": ".svg",
}

MEDIA_TYPE_TO_EXTENSION = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/gif": ".gif",
    "image/svg+xml": ".svg",
    "image/bmp": ".bmp",
    "image/x-ms-bmp": ".bmp",
}

IMG_START = re.compile(
    rb"<(?:(?:[A-Za-z_][A-Za-z0-9_.-]*):)?img(?=[\s/>])", re.IGNORECASE
)
SRC_ATTRIBUTE = re.compile(
    rb"(?<![A-Za-z0-9_:.-])src\s*=\s*(?:\"([^\"]*)\"|'([^']*)'|([^\s>]+))",
    re.IGNORECASE,
)

# Some source EPUBs carry a broken image credit where the real text was lost
# and replaced with a long run of one repeated letter, e.g.
# "Source: AAAAAAAAAAAAAAAAAAAA". This only matches that "Source:"-prefixed
# garbage, not unrelated repeated-letter text that's actually meaningful
# (e.g. a caption reading "AAAA ::gasp:: AAAA" for someone screaming).
CORRUPTED_SOURCE_CAPTION = re.compile(
    rb"<p\b[^>]*>\s*Source:\s*([A-Za-z])\1{9,}\s*</p>", re.IGNORECASE
)


def normalized_member(base: str, href: str) -> str | None:
    """Resolve an OPF href to a normalized ZIP member name."""
    parsed = urlsplit(href)
    if parsed.scheme or parsed.netloc:
        return None
    path = unquote(parsed.path)
    resolved = posixpath.normpath(posixpath.join(base, path))
    if resolved == ".." or resolved.startswith("../") or resolved.startswith("/"):
        return None
    return resolved


def manifest_images(epub: zipfile.ZipFile) -> dict[str, str]:
    """Return {member name: placeholder extension} from every OPF manifest."""
    images: dict[str, str] = {}
    for info in epub.infolist():
        if info.is_dir() or PurePosixPath(info.filename).suffix.lower() != ".opf":
            continue
        try:
            root = ElementTree.fromstring(epub.read(info.filename))
        except ElementTree.ParseError, KeyError:
            continue

        opf_dir = posixpath.dirname(info.filename)
        for item in root.iter():
            if item.tag.rsplit("}", 1)[-1] != "item":
                continue
            media_type = item.attrib.get("media-type", "").lower().strip()
            placeholder_ext = MEDIA_TYPE_TO_EXTENSION.get(media_type)
            href = item.attrib.get("href")
            if placeholder_ext and href:
                member = normalized_member(opf_dir, href)
                if member:
                    images[member] = placeholder_ext
    return images


def manifest_xhtml_documents(epub: zipfile.ZipFile) -> set[str]:
    """Return XHTML document members, including files with unusual suffixes."""
    documents: set[str] = set()
    for info in epub.infolist():
        if info.is_dir() or PurePosixPath(info.filename).suffix.lower() != ".opf":
            continue
        try:
            root = ElementTree.fromstring(epub.read(info.filename))
        except ElementTree.ParseError, KeyError:
            continue

        opf_dir = posixpath.dirname(info.filename)
        for item in root.iter():
            if item.tag.rsplit("}", 1)[-1] != "item":
                continue
            if item.attrib.get("media-type", "").lower().strip() != (
                "application/xhtml+xml"
            ):
                continue
            href = item.attrib.get("href")
            if href:
                member = normalized_member(opf_dir, href)
                if member:
                    documents.add(member)
    return documents


def placeholder_extension(member: str, manifest: dict[str, str]) -> str | None:
    if member in manifest:
        return manifest[member]
    suffix = PurePosixPath(member).suffix.lower()
    suffix = EXTENSION_ALIASES.get(suffix, suffix)
    return suffix if suffix in PLACEHOLDERS else None


def find_tag_end(data: bytes, start: int) -> int | None:
    """Find a tag's closing ``>`` without being fooled by quoted values."""
    quote: int | None = None
    for index in range(start, len(data)):
        byte = data[index]
        if quote is None:
            if byte in (ord('"'), ord("'")):
                quote = byte
            elif byte == ord(">"):
                return index + 1
        elif byte == quote:
            quote = None
    return None


def attribute_pattern(name: bytes) -> re.Pattern[bytes]:
    return re.compile(
        rb"(?<![A-Za-z0-9_:.-])"
        + re.escape(name)
        + rb"\s*=\s*(?:\"[^\"]*\"|'[^']*'|[^\s>]+)",
        re.IGNORECASE,
    )


def add_attribute(tag: bytes, attribute: bytes) -> bytes:
    """Insert an attribute before ``>`` or the slash in ``/>``."""
    insert_at = len(tag) - 1
    index = insert_at - 1
    while index >= 0 and tag[index : index + 1].isspace():
        index -= 1
    if index >= 0 and tag[index] == ord("/"):
        insert_at = index
    return tag[:insert_at] + b" " + attribute + tag[insert_at:]


def set_attribute(tag: bytes, name: bytes, value: bytes) -> bytes:
    replacement = name + b'="' + value + b'"'
    pattern = attribute_pattern(name)
    if pattern.search(tag):
        return pattern.sub(replacement, tag, count=1)
    return add_attribute(tag, replacement)


def force_image_style(tag: bytes) -> bytes:
    """Append sizing rules to inline style so EPUB CSS cannot upscale it."""
    quoted_style = re.compile(
        rb"(?<![A-Za-z0-9_:.-])(style)(\s*=\s*)([\"'])(.*?)\3",
        re.IGNORECASE | re.DOTALL,
    )
    match = quoted_style.search(tag)
    if match:
        existing = match.group(4).rstrip()
        separator = b" " if not existing or existing.endswith(b";") else b"; "
        replacement = (
            match.group(1)
            + match.group(2)
            + match.group(3)
            + existing
            + separator
            + FORCED_STYLE
            + b";"
            + match.group(3)
        )
        return tag[: match.start()] + replacement + tag[match.end() :]
    return set_attribute(tag, b"style", FORCED_STYLE + b";")


def constrain_img_tag(tag: bytes) -> bytes:
    tag = set_attribute(tag, b"width", str(PLACEHOLDER_WIDTH).encode("ascii"))
    tag = set_attribute(tag, b"height", str(PLACEHOLDER_HEIGHT).encode("ascii"))
    # The original description can be very long and some readers display it
    # inside a tiny image box. The replacement frame is deliberately decorative.
    tag = set_attribute(tag, b"alt", b"")
    tag = set_attribute(tag, b"title", b"")
    tag = set_attribute(tag, b"aria-label", b"")
    tag = set_attribute(tag, b"role", b"presentation")
    tag = set_attribute(tag, b"aria-hidden", b"true")
    return force_image_style(tag)


def resize_xhtml_images(
    data: bytes, document_member: str, image_members: set[str]
) -> tuple[bytes, int]:
    """Constrain matching XHTML ``img`` tags while preserving all other bytes."""
    document_dir = posixpath.dirname(document_member)
    output: list[bytes] = []
    cursor = 0
    resized = 0

    while match := IMG_START.search(data, cursor):
        tag_end = find_tag_end(data, match.end())
        if tag_end is None:
            break
        tag = data[match.start() : tag_end]
        src_match = SRC_ATTRIBUTE.search(tag)
        new_tag = tag
        if src_match:
            raw_src = next(group for group in src_match.groups() if group is not None)
            src = html.unescape(raw_src.decode("utf-8", errors="replace"))
            referenced_member = normalized_member(document_dir, src)
            if referenced_member in image_members:
                new_tag = constrain_img_tag(tag)
                resized += 1
        output.extend((data[cursor : match.start()], new_tag))
        cursor = tag_end

    if not output:
        return data, 0
    output.append(data[cursor:])
    return b"".join(output), resized


def strip_corrupted_captions(data: bytes) -> tuple[bytes, int]:
    """Drop ``Source:``-style captions whose text is a garbled letter run."""
    stripped = 0

    def remove(match: re.Match[bytes]) -> bytes:
        nonlocal stripped
        stripped += 1
        return b""

    return CORRUPTED_SOURCE_CAPTION.sub(remove, data), stripped


def output_info(source: zipfile.ZipInfo, compress_type: int) -> zipfile.ZipInfo:
    """Copy member metadata while allowing compression to be selected."""
    target = zipfile.ZipInfo(source.filename, source.date_time)
    target.comment = source.comment
    target.extra = source.extra
    target.create_system = source.create_system
    target.create_version = source.create_version
    target.extract_version = source.extract_version
    target.flag_bits = source.flag_bits
    target.volume = source.volume
    target.internal_attr = source.internal_attr
    target.external_attr = source.external_attr
    target.compress_type = compress_type
    return target


def replace_images(input_path: Path, output_path: Path) -> tuple[int, int, int]:
    if input_path.resolve() == output_path.resolve():
        raise ValueError("input and output paths must be different")
    if not zipfile.is_zipfile(input_path):
        raise ValueError(f"not a valid ZIP/EPUB file: {input_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    replaced = 0
    resized_tags = 0
    stripped_captions = 0

    try:
        with zipfile.ZipFile(input_path, "r") as source:
            manifest = manifest_images(source)
            xhtml_documents = manifest_xhtml_documents(source)
            members = source.infolist()
            mimetype = next((i for i in members if i.filename == "mimetype"), None)
            image_members = {
                info.filename
                for info in members
                if not info.is_dir()
                and placeholder_extension(info.filename, manifest) is not None
            }

            with zipfile.ZipFile(output_path, "w", allowZip64=True) as target:
                # EPUB requires this member to be first and stored without compression.
                if mimetype is not None:
                    target.writestr(
                        output_info(mimetype, zipfile.ZIP_STORED),
                        source.read(mimetype),
                    )

                for info in members:
                    if info.filename == "mimetype":
                        continue
                    data = source.read(info)
                    if not info.is_dir() and (
                        info.filename in xhtml_documents
                        or PurePosixPath(info.filename).suffix.lower()
                        in XHTML_EXTENSIONS
                    ):
                        data, count = resize_xhtml_images(
                            data, info.filename, image_members
                        )
                        resized_tags += count
                        data, caption_count = strip_corrupted_captions(data)
                        stripped_captions += caption_count
                    extension = (
                        None
                        if info.is_dir()
                        else placeholder_extension(info.filename, manifest)
                    )
                    if extension:
                        data = PLACEHOLDERS[extension]
                        replaced += 1
                    target.writestr(output_info(info, info.compress_type), data)
    except Exception:
        output_path.unlink(missing_ok=True)
        raise

    return replaced, resized_tags, stripped_captions


class ImageReplacer:
    def __init__(self, src_dir: Path, dst_dir: Path, logger: Logger):
        self.src_dir = src_dir
        self.dst_dir = dst_dir
        self.logger = logger

    def run(self) -> None:
        self.dst_dir.mkdir(parents=True, exist_ok=True)
        self._replace_epubs()
        self._copy_opf_files()
        self.logger.info(f"Replaced images for {self.src_dir} -> {self.dst_dir}")

    def _replace_epubs(self) -> None:
        for epub_path in sorted(self.src_dir.glob("*.epub")):
            self.logger.verbose(f"Replacing images in {epub_path.name}...")
            replaced, resized, stripped = replace_images(
                epub_path, self.dst_dir / epub_path.name
            )
            self.logger.verbose(
                f"{epub_path.name}: replaced {replaced} image(s), resized {resized} tag(s), "
                f"stripped {stripped} caption(s)"
            )

    def _copy_opf_files(self) -> None:
        for opf_path in sorted(self.src_dir.glob("*.opf")):
            self.logger.verbose(f"Copying {opf_path.name}...")
            (self.dst_dir / opf_path.name).write_bytes(opf_path.read_bytes())
