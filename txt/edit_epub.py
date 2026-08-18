"""Split EPUBs into size-bounded series entries and replace their images."""

from __future__ import annotations

import posixpath
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from xml.etree import ElementTree as ET

from .logger import Logger
from .replace_images import (
    PLACEHOLDERS,
    manifest_images,
    normalized_member,
    output_info,
    replace_images,
)

TARGET_EPUB_BYTES = 1_200_000
CONTAINER_MEMBER = "META-INF/container.xml"
DC_NAMESPACE = "http://purl.org/dc/elements/1.1/"
ZIP_MEMBER_OVERHEAD = 100


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _namespace(tag: str) -> str:
    return tag[1:].split("}", 1)[0] if tag.startswith("{") else ""


def _child_tag(parent: ET.Element, name: str) -> str:
    namespace = _namespace(parent.tag)
    return f"{{{namespace}}}{name}" if namespace else name


def _first(root: ET.Element, name: str) -> ET.Element:
    element = next(
        (item for item in root.iter() if _local_name(item.tag) == name), None
    )
    if element is None:
        raise ValueError(f"EPUB package has no <{name}> element")
    return element


def _rootfile_name(epub: zipfile.ZipFile) -> str:
    try:
        root = ET.fromstring(epub.read(CONTAINER_MEMBER))
    except (KeyError, ET.ParseError) as error:
        raise ValueError("EPUB has no valid META-INF/container.xml") from error
    rootfile = next(
        (item for item in root.iter() if _local_name(item.tag) == "rootfile"), None
    )
    name = rootfile.attrib.get("full-path") if rootfile is not None else None
    if not name or normalized_member("", name) != name:
        raise ValueError("EPUB container has no valid rootfile path")
    return name


def _manifest_members(root: ET.Element, opf_dir: str) -> dict[str, str]:
    result = {}
    for item in _first(root, "manifest"):
        if _local_name(item.tag) != "item" or not item.get("id"):
            continue
        member = normalized_member(opf_dir, item.get("href", ""))
        if member is not None:
            result[item.get("id")] = member
    return result


def _spine_entries(root: ET.Element, members: dict[str, str]) -> tuple[SpineEntry, ...]:
    entries = []
    for item in _first(root, "spine"):
        idref = item.get("idref")
        if _local_name(item.tag) == "itemref" and idref in members:
            entries.append(SpineEntry(idref, members[idref], 0))
    if not entries:
        raise ValueError("EPUB package has no readable spine items")
    return tuple(entries)


def _book_title(root: ET.Element, fallback: str) -> str:
    metadata = _first(root, "metadata")
    title = next(
        (
            (item.text or "").strip()
            for item in metadata
            if _local_name(item.tag) == "title"
        ),
        "",
    )
    return title or fallback


def _package_entries(root: ET.Element, opf_member: str) -> tuple[SpineEntry, ...]:
    opf_dir = posixpath.dirname(opf_member)
    return _spine_entries(root, _manifest_members(root, opf_dir))


def _estimated_size(info: zipfile.ZipInfo, images: dict[str, str]) -> int:
    extension = images.get(info.filename)
    payload = len(PLACEHOLDERS[extension]) if extension else info.compress_size
    return payload + len(info.filename.encode()) + ZIP_MEMBER_OVERHEAD


@dataclass(frozen=True)
class SpineEntry:
    idref: str
    member: str
    size: int


@dataclass(frozen=True)
class EpubPackage:
    path: Path
    opf_member: str
    opf_bytes: bytes
    members: tuple[zipfile.ZipInfo, ...]
    entries: tuple[SpineEntry, ...]
    title: str
    base_size: int

    @classmethod
    def load(cls, path: Path) -> EpubPackage:
        if not zipfile.is_zipfile(path):
            raise ValueError(f"not a valid ZIP/EPUB file: {path}")
        with zipfile.ZipFile(path) as epub:
            return cls._read(path, epub)

    @classmethod
    def _read(cls, path: Path, epub: zipfile.ZipFile) -> EpubPackage:
        opf_member = _rootfile_name(epub)
        opf_bytes = epub.read(opf_member)
        root = ET.fromstring(opf_bytes)
        members = tuple(epub.infolist())
        images = manifest_images(epub)
        entries = _package_entries(root, opf_member)
        weighted = cls._weighted_entries(entries, members, images)
        base_size = cls._base_size(weighted, members, images)
        title = _book_title(root, path.stem)
        return cls(path, opf_member, opf_bytes, members, weighted, title, base_size)

    @staticmethod
    def _weighted_entries(entries, members, images) -> tuple[SpineEntry, ...]:
        info_by_name = {info.filename: info for info in members}
        return tuple(
            SpineEntry(
                item.idref,
                item.member,
                _estimated_size(info_by_name[item.member], images),
            )
            for item in entries
        )

    @staticmethod
    def _base_size(entries, members, images) -> int:
        spine_members = {item.member for item in entries}
        return sum(
            _estimated_size(info, images)
            for info in members
            if info.filename not in spine_members
        )


class SplitPlanner:
    def __init__(self, package: EpubPackage, target_bytes: int):
        self.package = package
        self.target_bytes = target_bytes

    def initial_groups(self) -> list[tuple[SpineEntry, ...]]:
        budget = max(1, self.target_bytes - self.package.base_size)
        groups, current, size = [], [], 0
        for entry in self.package.entries:
            if current and size + entry.size > budget:
                groups.append(tuple(current))
                current, size = [], 0
            current.append(entry)
            size += entry.size
        if current:
            groups.append(tuple(current))
        return groups

    def refine(self, groups, sizes) -> tuple[list[tuple[SpineEntry, ...]], bool]:
        result, changed = [], False
        for group, size in zip(groups, sizes, strict=True):
            if size <= self.target_bytes or len(group) == 1:
                result.append(group)
                continue
            result.extend(self._halve(group))
            changed = True
        return result, changed

    @staticmethod
    def _halve(group: tuple[SpineEntry, ...]) -> tuple[tuple, tuple]:
        halfway = sum(item.size for item in group) / 2
        used, boundary = 0, 1
        for index, item in enumerate(group[:-1], 1):
            used += item.size
            if abs(halfway - used) < abs(
                halfway - sum(x.size for x in group[:boundary])
            ):
                boundary = index
        return group[:boundary], group[boundary:]


def _metadata(root: ET.Element) -> ET.Element:
    return _first(root, "metadata")


def _replace_title(metadata: ET.Element, title: str) -> None:
    titles = [item for item in metadata if _local_name(item.tag) == "title"]
    if not titles:
        titles = [ET.SubElement(metadata, f"{{{DC_NAMESPACE}}}title")]
    titles[0].text = title
    for duplicate in titles[1:]:
        metadata.remove(duplicate)


def _set_named_meta(metadata: ET.Element, name: str, value: str) -> None:
    matches = [
        item
        for item in metadata
        if _local_name(item.tag) == "meta" and item.get("name") == name
    ]
    if not matches:
        matches = [
            ET.SubElement(metadata, _child_tag(metadata, "meta"), {"name": name})
        ]
    matches[0].set("content", value)
    for duplicate in matches[1:]:
        metadata.remove(duplicate)


def _replace_identifier(root: ET.Element, label: str) -> None:
    metadata = _metadata(root)
    identifier_id = root.get("unique-identifier")
    identifiers = [item for item in metadata if _local_name(item.tag) == "identifier"]
    selected = next(
        (item for item in identifiers if item.get("id") == identifier_id), None
    )
    if selected is None and identifiers:
        selected = identifiers[0]
    if selected is not None:
        selected.text = f"{(selected.text or '').strip()}-part-{label}"


def _replace_epub3_series(metadata: ET.Element, series: str, label: str) -> None:
    collections = [
        item
        for item in metadata
        if _local_name(item.tag) == "meta"
        and item.get("property") == "belongs-to-collection"
    ]
    collection = collections[0] if collections else _new_collection(metadata)
    collection.text = series
    collection_id = collection.get("id") or "txt-series"
    collection.set("id", collection_id)
    _set_refinement(metadata, collection_id, "collection-type", "series")
    _set_refinement(metadata, collection_id, "group-position", label)


def _new_collection(metadata: ET.Element) -> ET.Element:
    return ET.SubElement(
        metadata,
        _child_tag(metadata, "meta"),
        {"property": "belongs-to-collection", "id": "txt-series"},
    )


def _set_refinement(metadata, target: str, prop: str, value: str) -> None:
    match = next(
        (
            item
            for item in metadata
            if item.get("refines") == f"#{target}" and item.get("property") == prop
        ),
        None,
    )
    if match is None:
        match = ET.SubElement(metadata, _child_tag(metadata, "meta"))
        match.attrib.update({"refines": f"#{target}", "property": prop})
    match.text = value


def _rewrite_metadata(root: ET.Element, title: str, series: str, label: str) -> None:
    metadata = _metadata(root)
    _replace_title(metadata, title)
    _set_named_meta(metadata, "calibre:series", series)
    _set_named_meta(metadata, "calibre:series_index", label)
    _replace_epub3_series(metadata, series, label)
    _replace_identifier(root, label)


def _filter_package(root: ET.Element, selected: set[str], all_ids: set[str]) -> None:
    excluded = all_ids - selected
    manifest = _first(root, "manifest")
    for item in list(manifest):
        if item.get("id") in excluded:
            manifest.remove(item)
    spine = _first(root, "spine")
    for item in list(spine):
        if item.get("idref") not in selected:
            spine.remove(item)


def _serialize_opf(root: ET.Element) -> bytes:
    namespace = _namespace(root.tag)
    if namespace:
        ET.register_namespace("", namespace)
    ET.register_namespace("dc", DC_NAMESPACE)
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


@dataclass(frozen=True)
class RenderedPart:
    path: Path
    opf_bytes: bytes
    size: int
    replaced: int
    resized: int
    stripped: int


class SplitWriter:
    def __init__(self, package: EpubPackage, work_dir: Path):
        self.package = package
        self.work_dir = work_dir
        self.all_ids = {item.idref for item in package.entries}
        self.all_members = {item.member for item in package.entries}

    def render(self, groups) -> list[RenderedPart]:
        width = max(2, len(str(len(groups))))
        return [
            self._render(group, f"{index:0{width}d}")
            for index, group in enumerate(groups, 1)
        ]

    def _render(self, group, label: str) -> RenderedPart:
        output_name = f"{self.package.path.stem} {label}.epub"
        raw_path = self.work_dir / f"raw-{label}.epub"
        output_path = self.work_dir / output_name
        opf_bytes = self._opf_bytes(group, label)
        self._write_raw(raw_path, group, opf_bytes)
        counts = replace_images(raw_path, output_path)
        return RenderedPart(output_path, opf_bytes, output_path.stat().st_size, *counts)

    def _opf_bytes(self, group, label: str) -> bytes:
        root = ET.fromstring(self.package.opf_bytes)
        selected = {item.idref for item in group}
        _filter_package(root, selected, self.all_ids)
        title = f"{self.package.title} {label}"
        _rewrite_metadata(root, title, self.package.title, label)
        return _serialize_opf(root)

    def _write_raw(self, output: Path, group, opf_bytes: bytes) -> None:
        selected_members = {item.member for item in group}
        excluded = self.all_members - selected_members
        with zipfile.ZipFile(self.package.path) as source:
            with zipfile.ZipFile(output, "w", allowZip64=True) as target:
                self._copy_members(source, target, excluded, opf_bytes)

    def _copy_members(self, source, target, excluded, opf_bytes: bytes) -> None:
        mimetype = next(
            (item for item in self.package.members if item.filename == "mimetype"), None
        )
        if mimetype is None:
            raise ValueError("EPUB has no mimetype member")
        target.writestr(
            output_info(mimetype, zipfile.ZIP_STORED), source.read(mimetype)
        )
        for info in self.package.members:
            if info.filename != "mimetype" and info.filename not in excluded:
                self._copy_member(source, target, info, opf_bytes)

    def _copy_member(self, source, target, info, opf_bytes: bytes) -> None:
        data = (
            opf_bytes if info.filename == self.package.opf_member else source.read(info)
        )
        compression = zipfile.ZIP_STORED if info.is_dir() else zipfile.ZIP_DEFLATED
        target.writestr(output_info(info, compression), data)


class EpubSplitter:
    def __init__(self, path: Path, dst_dir: Path, logger: Logger, target_bytes: int):
        self.package = EpubPackage.load(path)
        self.dst_dir = dst_dir
        self.logger = logger
        self.planner = SplitPlanner(self.package, target_bytes)

    def run(self) -> list[RenderedPart]:
        groups = self.planner.initial_groups()
        with tempfile.TemporaryDirectory(
            dir=self.dst_dir, prefix=".edit-epub-"
        ) as name:
            parts = self._render_until_sized(groups, Path(name))
            self._install(parts)
        return parts

    def _render_until_sized(self, groups, work_dir: Path) -> list[RenderedPart]:
        iteration = 0
        while True:
            iteration += 1
            output_dir = work_dir / str(iteration)
            output_dir.mkdir()
            parts = SplitWriter(self.package, output_dir).render(groups)
            groups, changed = self.planner.refine(groups, [part.size for part in parts])
            if not changed:
                return parts

    def _install(self, parts: list[RenderedPart]) -> None:
        for part in parts:
            destination = self.dst_dir / part.path.name
            part.path.replace(destination)
            destination.with_suffix(".opf").write_bytes(part.opf_bytes)
            self._log_part(destination, part)

    def _log_part(self, destination: Path, part: RenderedPart) -> None:
        self.logger.verbose(
            f"{destination.name}: {part.size} byte(s), replaced {part.replaced} "
            f"image(s), resized {part.resized} tag(s), stripped "
            f"{part.stripped} caption(s)"
        )


class EpubEditor:
    def __init__(
        self,
        src_dir: Path,
        dst_dir: Path,
        logger: Logger,
        target_bytes=TARGET_EPUB_BYTES,
    ):
        self.src_dir = src_dir
        self.dst_dir = dst_dir
        self.logger = logger
        self.target_bytes = target_bytes

    def run(self) -> None:
        self._validate()
        self.dst_dir.mkdir(parents=True, exist_ok=True)
        paths = sorted(
            path
            for path in self.src_dir.iterdir()
            if path.is_file() and path.suffix.lower() == ".epub"
        )
        for path in paths:
            self._edit(path)
        self.logger.info(
            f"Edited {len(paths)} EPUB(s) from {self.src_dir} -> {self.dst_dir}"
        )

    def _validate(self) -> None:
        if not self.src_dir.is_dir():
            raise ValueError(f"source directory does not exist: {self.src_dir}")
        if self.src_dir.resolve() == self.dst_dir.resolve():
            raise ValueError("source and destination directories must be different")

    def _edit(self, path: Path) -> None:
        self.logger.verbose(f"Splitting and replacing images in {path.name}...")
        parts = EpubSplitter(path, self.dst_dir, self.logger, self.target_bytes).run()
        oversized = sum(part.size > self.target_bytes for part in parts)
        self.logger.verbose(
            f"{path.name}: wrote {len(parts)} part(s); {oversized} unavoidable "
            "oversized part(s) contain a single spine document"
        )
