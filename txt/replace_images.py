"""Replace EPUB images and constrain their XHTML display size.

The input EPUB is never modified. The output EPUB preserves ZIP member metadata
and keeps the required ``mimetype`` member first and uncompressed.

replace_images_dir() drives this over a whole directory for --replace-images.
"""

from __future__ import annotations

import base64
import html
import posixpath
import re
import zipfile
from dataclasses import dataclass
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
QUOTED_STYLE = re.compile(
    rb"(?<![A-Za-z0-9_:.-])(style)(\s*=\s*)([\"'])(.*?)\3",
    re.IGNORECASE | re.DOTALL,
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


def _opf_roots(epub: zipfile.ZipFile):
    for info in epub.infolist():
        if info.is_dir() or PurePosixPath(info.filename).suffix.lower() != ".opf":
            continue
        try:
            root = ElementTree.fromstring(epub.read(info.filename))
        except ElementTree.ParseError, KeyError:
            continue
        yield posixpath.dirname(info.filename), root


def _manifest_items(epub: zipfile.ZipFile):
    for opf_dir, root in _opf_roots(epub):
        for item in root.iter():
            if item.tag.rsplit("}", 1)[-1] == "item":
                yield opf_dir, item


def _item_member(opf_dir: str, item: ElementTree.Element) -> str | None:
    href = item.attrib.get("href")
    return normalized_member(opf_dir, href) if href else None


def manifest_images(epub: zipfile.ZipFile) -> dict[str, str]:
    """Return {member name: placeholder extension} from every OPF manifest."""
    images: dict[str, str] = {}
    for opf_dir, item in _manifest_items(epub):
        media_type = item.attrib.get("media-type", "").lower().strip()
        extension = MEDIA_TYPE_TO_EXTENSION.get(media_type)
        member = _item_member(opf_dir, item)
        if extension and member:
            images[member] = extension
    return images


def manifest_xhtml_documents(epub: zipfile.ZipFile) -> set[str]:
    """Return XHTML document members, including files with unusual suffixes."""
    documents: set[str] = set()
    for opf_dir, item in _manifest_items(epub):
        media_type = item.attrib.get("media-type", "").lower().strip()
        member = _item_member(opf_dir, item)
        if media_type == "application/xhtml+xml" and member:
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
    match = QUOTED_STYLE.search(tag)
    if not match:
        return set_attribute(tag, b"style", FORCED_STYLE + b";")
    replacement = _forced_style_value(match)
    return tag[: match.start()] + replacement + tag[match.end() :]


def _forced_style_value(match: re.Match[bytes]) -> bytes:
    existing = match.group(4).rstrip()
    separator = b" " if not existing or existing.endswith(b";") else b"; "
    return b"".join(
        (*match.group(1, 2, 3), existing, separator, FORCED_STYLE, b";", match[3])
    )


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


class XhtmlImageResizer:
    def __init__(self, data: bytes, document: str, images: set[str]):
        self.data = data
        self.document_dir = posixpath.dirname(document)
        self.images = images
        self.output: list[bytes] = []
        self.cursor = 0
        self.resized = 0

    def run(self) -> tuple[bytes, int]:
        while match := IMG_START.search(self.data, self.cursor):
            if not self._consume(match):
                break
        if not self.output:
            return self.data, 0
        self.output.append(self.data[self.cursor :])
        return b"".join(self.output), self.resized

    def _consume(self, match: re.Match[bytes]) -> bool:
        tag_end = find_tag_end(self.data, match.end())
        if tag_end is None:
            return False
        tag = self.data[match.start() : tag_end]
        new_tag = self._resized_tag(tag)
        self.output.extend((self.data[self.cursor : match.start()], new_tag))
        self.cursor = tag_end
        return True

    def _resized_tag(self, tag: bytes) -> bytes:
        src_match = SRC_ATTRIBUTE.search(tag)
        if not src_match:
            return tag
        raw = next(group for group in src_match.groups() if group is not None)
        src = html.unescape(raw.decode("utf-8", errors="replace"))
        member = normalized_member(self.document_dir, src)
        if member not in self.images:
            return tag
        self.resized += 1
        return constrain_img_tag(tag)


def resize_xhtml_images(
    data: bytes, document_member: str, image_members: set[str]
) -> tuple[bytes, int]:
    """Constrain matching XHTML ``img`` tags while preserving all other bytes."""
    return XhtmlImageResizer(data, document_member, image_members).run()


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


@dataclass(frozen=True)
class EpubCatalog:
    manifest: dict[str, str]
    xhtml_documents: set[str]
    members: list[zipfile.ZipInfo]
    image_members: set[str]
    mimetype: zipfile.ZipInfo | None


def _epub_catalog(source: zipfile.ZipFile) -> EpubCatalog:
    manifest = manifest_images(source)
    members = source.infolist()
    images = {
        info.filename
        for info in members
        if not info.is_dir() and placeholder_extension(info.filename, manifest)
    }
    mimetype = next((i for i in members if i.filename == "mimetype"), None)
    return EpubCatalog(
        manifest, manifest_xhtml_documents(source), members, images, mimetype
    )


class EpubImageTransformer:
    def __init__(self, input_path: Path, output_path: Path):
        self.input_path = input_path
        self.output_path = output_path
        self.replaced = 0
        self.resized = 0
        self.stripped = 0

    def run(self) -> tuple[int, int, int]:
        self._validate()
        self.output_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            self._transform()
        except Exception:
            self.output_path.unlink(missing_ok=True)
            raise
        return self.replaced, self.resized, self.stripped

    def _validate(self) -> None:
        if self.input_path.resolve() == self.output_path.resolve():
            raise ValueError("input and output paths must be different")
        if not zipfile.is_zipfile(self.input_path):
            raise ValueError(f"not a valid ZIP/EPUB file: {self.input_path}")

    def _transform(self) -> None:
        with zipfile.ZipFile(self.input_path, "r") as source:
            catalog = _epub_catalog(source)
            with zipfile.ZipFile(self.output_path, "w", allowZip64=True) as target:
                self._write_epub(source, target, catalog)

    def _write_epub(
        self, source: zipfile.ZipFile, target: zipfile.ZipFile, catalog: EpubCatalog
    ) -> None:
        self._write_mimetype(source, target, catalog.mimetype)
        for info in catalog.members:
            if info.filename != "mimetype":
                data = self._member_data(source, info, catalog)
                target.writestr(output_info(info, info.compress_type), data)

    @staticmethod
    def _write_mimetype(source, target, mimetype: zipfile.ZipInfo | None) -> None:
        if mimetype is not None:
            info = output_info(mimetype, zipfile.ZIP_STORED)
            target.writestr(info, source.read(mimetype))

    def _member_data(
        self, source: zipfile.ZipFile, info: zipfile.ZipInfo, catalog: EpubCatalog
    ) -> bytes:
        data = source.read(info)
        if self._is_xhtml(info, catalog):
            data = self._transform_xhtml(data, info.filename, catalog.image_members)
        extension = self._image_extension(info, catalog.manifest)
        if extension:
            self.replaced += 1
            return PLACEHOLDERS[extension]
        return data

    def _transform_xhtml(self, data: bytes, name: str, images: set[str]) -> bytes:
        data, resized = resize_xhtml_images(data, name, images)
        data, stripped = strip_corrupted_captions(data)
        self.resized += resized
        self.stripped += stripped
        return data

    @staticmethod
    def _is_xhtml(info: zipfile.ZipInfo, catalog: EpubCatalog) -> bool:
        suffix = PurePosixPath(info.filename).suffix.lower()
        return not info.is_dir() and (
            info.filename in catalog.xhtml_documents or suffix in XHTML_EXTENSIONS
        )

    @staticmethod
    def _image_extension(info: zipfile.ZipInfo, manifest: dict[str, str]) -> str | None:
        return None if info.is_dir() else placeholder_extension(info.filename, manifest)


def replace_images(input_path: Path, output_path: Path) -> tuple[int, int, int]:
    return EpubImageTransformer(input_path, output_path).run()


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
                f"{epub_path.name}: replaced {replaced} image(s), resized {resized} "
                f"tag(s), stripped {stripped} caption(s)"
            )

    def _copy_opf_files(self) -> None:
        for opf_path in sorted(self.src_dir.glob("*.opf")):
            self.logger.verbose(f"Copying {opf_path.name}...")
            (self.dst_dir / opf_path.name).write_bytes(opf_path.read_bytes())
