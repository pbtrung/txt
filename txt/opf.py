"""Calibre .opf sidecar detection and <metadata> extraction for --txt-ingest."""

import logging
import xml.etree.ElementTree as ET
from pathlib import Path

logger = logging.getLogger(__name__)

_EPUB_TXT_SUFFIX = ".epub.txt"


def find_opf_sidecar(path: Path) -> Path | None:
    """The sibling <name>.opf (any case) for a <name>.epub.txt (any case) file."""
    if not path.name.lower().endswith(_EPUB_TXT_SUFFIX):
        logger.debug("%s: not a .epub.txt file, skipping OPF lookup", path)
        return None
    base = path.name[: -len(_EPUB_TXT_SUFFIX)]
    target = f"{base}.opf".lower()
    for sibling in path.parent.iterdir():
        if sibling.is_file() and sibling.name.lower() == target:
            logger.debug("%s: found OPF sidecar %s", path, sibling)
            return sibling
    logger.debug("%s: no OPF sidecar (%s) found in %s", path, target, path.parent)
    return None


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _metadata_element(root: ET.Element) -> ET.Element | None:
    for el in root.iter():
        if _local_name(el.tag) == "metadata":
            return el
    return None


def _add_metadata_field(result: dict, key: str, value: str) -> None:
    if key not in result:
        result[key] = value
        return
    if not isinstance(result[key], list):
        result[key] = [result[key]]
    result[key].append(value)


def _metadata_dict(metadata_el: ET.Element) -> dict:
    result: dict = {}
    for child in metadata_el:
        tag = _local_name(child.tag)
        if tag == "meta":
            key, value = child.get("name"), child.get("content")
        else:
            key, value = tag, (child.text or "").strip()
        if key is not None:
            _add_metadata_field(result, key, value)
    return result


def parse_opf_metadata(opf_path: Path) -> dict:
    """Parses <name>.opf's <metadata> element into a flat dict.

    dc:* elements (title, creator, date, ...) become {tag: text}; Calibre's
    <meta name="calibre:x" content="y"/> elements become {name: content};
    repeated tags (e.g. multiple dc:subject) collapse into a list.
    """
    root = ET.parse(opf_path).getroot()
    metadata_el = _metadata_element(root)
    if metadata_el is None:
        logger.warning("%s: no <metadata> element found", opf_path)
        return {}
    metadata = _metadata_dict(metadata_el)
    logger.debug("%s: parsed field(s): %s", opf_path, sorted(metadata))
    return metadata
