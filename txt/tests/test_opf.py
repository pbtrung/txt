import xml.etree.ElementTree as ET

import pytest

from txt.opf import find_opf_sidecar, parse_opf_metadata

SAMPLE_OPF = """<?xml version='1.0' encoding='utf-8'?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uuid_id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:identifier opf:scheme="calibre" id="calibre_id">123</dc:identifier>
    <dc:identifier opf:scheme="uuid" id="uuid_id">abcd-1234</dc:identifier>
    <dc:title>Sample Book &amp; Co.</dc:title>
    <dc:creator opf:role="aut" opf:file-as="Author, Sample">Sample Author</dc:creator>
    <dc:contributor opf:role="bkp" opf:file-as="calibre">calibre (7.0)</dc:contributor>
    <dc:date>2020-01-01T00:00:00+00:00</dc:date>
    <dc:subject>Fiction</dc:subject>
    <dc:subject>Adventure</dc:subject>
    <dc:publisher>Sample Publisher</dc:publisher>
    <dc:language>eng</dc:language>
    <meta name="calibre:timestamp" content="2020-01-01T00:00:00+00:00"/>
    <meta name="calibre:title_sort" content="Sample Book"/>
  </metadata>
  <guide>
    <reference type="cover" title="Cover" href="cover.jpg"/>
  </guide>
</package>
"""


def test_finds_case_insensitive_sibling_opf_for_epub(tmp_path):
    (tmp_path / "Book.EPUB").write_text("")
    (tmp_path / "book.OPF").write_text("")
    assert find_opf_sidecar(tmp_path / "Book.EPUB") == tmp_path / "book.OPF"


def test_returns_none_for_non_epub_file(tmp_path):
    (tmp_path / "plain.txt").write_text("")
    (tmp_path / "plain.opf").write_text("")
    assert find_opf_sidecar(tmp_path / "plain.txt") is None


def test_returns_none_when_no_sidecar_exists(tmp_path):
    (tmp_path / "lonely.epub").write_text("")
    assert find_opf_sidecar(tmp_path / "lonely.epub") is None


def test_parses_real_calibre_shaped_opf(tmp_path):
    opf_path = tmp_path / "book.opf"
    opf_path.write_text(SAMPLE_OPF)
    assert parse_opf_metadata(opf_path) == {
        "title": "Sample Book & Co.",
        "creator": {"text": "Sample Author", "role": "aut", "file-as": "Author, Sample"},
        "date": "2020-01-01T00:00:00+00:00",
        "subject": ["Fiction", "Adventure"],
        "publisher": "Sample Publisher",
        "language": "eng",
        "calibre:timestamp": "2020-01-01T00:00:00+00:00",
        "calibre:title_sort": "Sample Book",
    }


def test_returns_empty_dict_when_no_metadata_element(tmp_path):
    opf_path = tmp_path / "empty.opf"
    opf_path.write_text("<package><guide/></package>")
    assert parse_opf_metadata(opf_path) == {}


def test_drops_calibre_own_identifier_and_contributor(tmp_path):
    opf_path = tmp_path / "book.opf"
    opf_path.write_text(SAMPLE_OPF)
    result = parse_opf_metadata(opf_path)
    assert "identifier" not in result
    assert "contributor" not in result


def test_keeps_non_calibre_identifier(tmp_path):
    opf_path = tmp_path / "isbn.opf"
    opf_path.write_text(
        """<package><metadata xmlns:dc="urn:dc" xmlns:opf="urn:opf">
        <dc:identifier opf:scheme="ISBN">978-0-000-00000-0</dc:identifier>
    </metadata></package>"""
    )
    assert parse_opf_metadata(opf_path) == {"identifier": {"text": "978-0-000-00000-0", "scheme": "ISBN"}}


def test_treats_cdata_as_literal_text(tmp_path):
    opf_path = tmp_path / "cdata.opf"
    opf_path.write_text(
        """<package><metadata xmlns:dc="urn:dc">
        <dc:description><![CDATA[Has <b>markup</b> & an ampersand]]></dc:description>
    </metadata></package>"""
    )
    assert parse_opf_metadata(opf_path) == {"description": "Has <b>markup</b> & an ampersand"}


def test_handles_attribute_value_containing_literal_gt(tmp_path):
    opf_path = tmp_path / "gt.opf"
    opf_path.write_text(
        '<package><metadata xmlns:dc="urn:dc" xmlns:opf="urn:opf">\n'
        '    <dc:identifier opf:scheme="weird>scheme">value</dc:identifier>\n'
        "</metadata></package>"
    )
    assert parse_opf_metadata(opf_path) == {"identifier": {"text": "value", "scheme": "weird>scheme"}}


def test_throws_on_malformed_xml(tmp_path):
    opf_path = tmp_path / "broken.opf"
    opf_path.write_text(
        """<package><metadata xmlns:dc="urn:dc">
        <dc:title>Unclosed
    </metadata></package>"""
    )
    with pytest.raises(ET.ParseError):
        parse_opf_metadata(opf_path)
