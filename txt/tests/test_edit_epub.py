import random
import xml.etree.ElementTree as ET
import zipfile

import pytest

from txt.edit_epub import EpubEditor
from txt.logger import Logger
from txt.opf import parse_opf_metadata
from txt.replace_images import PLACEHOLDERS

CONTAINER = """<?xml version="1.0"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf"
    media-type="application/oebps-package+xml"/></rootfiles>
</container>
"""


def _local_name(tag):
    return tag.rsplit("}", 1)[-1]


def _package(chapter_count):
    manifest = "".join(
        f'<item id="c{index}" href="c{index}.xhtml" '
        'media-type="application/xhtml+xml"/>'
        for index in range(1, chapter_count + 1)
    )
    spine = "".join(
        f'<itemref idref="c{index}"/>' for index in range(1, chapter_count + 1)
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
  unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:test:abc</dc:identifier>
    <dc:title>ABC</dc:title><dc:creator>Author One</dc:creator>
    <meta name="calibre:series" content="XYZ"/>
    <meta name="calibre:series_index" content="0"/>
    <meta property="belongs-to-collection" id="old-series">XYZ</meta>
    <meta refines="#old-series" property="collection-type">series</meta>
    <meta refines="#old-series" property="group-position">0</meta>
  </metadata>
  <manifest>
    <item id="cover" href="cover.png" media-type="image/png"/>{manifest}
  </manifest>
  <spine>{spine}</spine>
</package>
"""


def _chapter(index, text):
    return (
        '<html xmlns="http://www.w3.org/1999/xhtml"><body>'
        f'<h1>Chapter {index}</h1><img src="cover.png"/><p>{text}</p>'
        "</body></html>"
    )


def _write_epub(path, chapter_count=3, text_size=40_000):
    randomizer = random.Random(123)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as epub:
        epub.writestr(
            "mimetype", "application/epub+zip", compress_type=zipfile.ZIP_STORED
        )
        epub.writestr("META-INF/container.xml", CONTAINER)
        epub.writestr("OEBPS/content.opf", _package(chapter_count))
        epub.writestr("OEBPS/cover.png", randomizer.randbytes(80_000))
        for index in range(1, chapter_count + 1):
            text = "".join(
                randomizer.choices("abcdefghijklmnopqrstuvwxyz", k=text_size)
            )
            epub.writestr(f"OEBPS/c{index}.xhtml", _chapter(index, text))


def _opf_root(epub):
    return ET.fromstring(epub.read("OEBPS/content.opf"))


def _metadata(root):
    return next(item for item in root.iter() if _local_name(item.tag) == "metadata")


def _metadata_value(root, name):
    for item in _metadata(root):
        if _local_name(item.tag) == name:
            return (item.text or "").strip()
        if _local_name(item.tag) == "meta" and item.get("name") == name:
            return item.get("content")
    return None


def _spine_ids(root):
    spine = next(item for item in root.iter() if _local_name(item.tag) == "spine")
    return [item.get("idref") for item in spine]


def _property_value(root, name):
    return next(
        (item.text or "").strip()
        for item in _metadata(root)
        if item.get("property") == name
    )


def test_edit_epub_splits_metadata_and_replaces_images(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    source = src / "source.epub"
    _write_epub(source)

    EpubEditor(src, dst, Logger(False), target_bytes=38_000).run()

    outputs = sorted(dst.glob("*.epub"))
    assert [path.name for path in outputs] == [
        "source 01.epub",
        "source 02.epub",
        "source 03.epub",
    ]
    for index, output in enumerate(outputs, 1):
        _assert_part(output, index, 38_000)
    with zipfile.ZipFile(source) as original:
        assert original.read("OEBPS/cover.png") != PLACEHOLDERS[".png"]


def _assert_part(path, index, target_bytes):
    label = f"{index:02d}"
    assert path.stat().st_size <= target_bytes
    with zipfile.ZipFile(path) as epub:
        assert epub.infolist()[0].filename == "mimetype"
        assert epub.infolist()[0].compress_type == zipfile.ZIP_STORED
        assert epub.read("OEBPS/cover.png") == PLACEHOLDERS[".png"]
        root = _opf_root(epub)
        assert _spine_ids(root) == [f"c{index}"]
        assert not {
            f"OEBPS/c{other}.xhtml" for other in range(1, 4) if other != index
        }.intersection(epub.namelist())
        assert _metadata_value(root, "title") == f"ABC {label}"
        assert _metadata_value(root, "calibre:series") == "ABC"
        assert _metadata_value(root, "calibre:series_index") == label
        assert _property_value(root, "belongs-to-collection") == "ABC"
        assert _property_value(root, "group-position") == label
        assert _metadata_value(root, "identifier").endswith(f"-part-{label}")
        assert b'width="24"' in epub.read(f"OEBPS/c{index}.xhtml")
    _assert_sidecar(path.with_suffix(".opf"), label)


def _assert_sidecar(path, label):
    metadata = parse_opf_metadata(path)
    assert metadata["title"] == f"ABC {label}"
    assert metadata["creator"] == "Author One"
    assert metadata["calibre:series"] == "ABC"
    assert metadata["calibre:series_index"] == label


def test_edit_epub_keeps_an_oversized_spine_document_intact(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    _write_epub(src / "large.epub", chapter_count=1, text_size=20_000)

    EpubEditor(src, dst, Logger(False), target_bytes=1_000).run()

    [output] = list(dst.glob("*.epub"))
    assert output.stat().st_size > 1_000
    with zipfile.ZipFile(output) as epub:
        assert _spine_ids(_opf_root(epub)) == ["c1"]


def test_edit_epub_rejects_the_same_source_and_destination(tmp_path):
    with pytest.raises(ValueError, match="must be different"):
        EpubEditor(tmp_path, tmp_path, Logger(False)).run()
