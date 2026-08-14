import zipfile

from txt.logger import Logger
from txt.replace_images import PLACEHOLDERS, replace_images, replace_images_dir


def _write_minimal_epub(path):
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("content.opf", "<package><metadata/></package>")


def test_replace_images_dir_processes_all_epubs_and_copies_opf(tmp_path):
    src, dst = tmp_path / "src", tmp_path / "dst"
    src.mkdir()
    _write_minimal_epub(src / "book1.epub")
    _write_minimal_epub(src / "book2.epub")
    (src / "book1.opf").write_text("<package/>")
    (src / "book2.opf").write_text("<package/>")

    replace_images_dir(src, dst, Logger(False))

    assert (dst / "book1.epub").exists()
    assert (dst / "book2.epub").exists()
    assert (dst / "book1.opf").read_text() == "<package/>"
    assert (dst / "book2.opf").read_text() == "<package/>"
    with zipfile.ZipFile(dst / "book1.epub") as zf:
        assert zf.read("mimetype") == b"application/epub+zip"


def test_replace_images_dir_creates_dst_dir(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    dst = tmp_path / "nested" / "dst"
    replace_images_dir(src, dst, Logger(False))
    assert dst.is_dir()


def test_replace_images_replaces_manifest_image_and_constrains_img_tag(tmp_path):
    src, dst = tmp_path / "in.epub", tmp_path / "out.epub"
    opf = (
        "<package><manifest>"
        '<item id="cover" href="images/cover.png" media-type="image/png"/>'
        '<item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>'
        "</manifest></package>"
    )
    xhtml = b'<html><body><img src="images/cover.png" width="500" height="800"/></body></html>'
    with zipfile.ZipFile(src, "w") as zf:
        zf.writestr("mimetype", "application/epub+zip")
        zf.writestr("content.opf", opf)
        zf.writestr("images/cover.png", b"not a real png, just needs to be replaced")
        zf.writestr("ch1.xhtml", xhtml)

    replaced, resized, stripped = replace_images(src, dst)
    assert (replaced, resized, stripped) == (1, 1, 0)

    with zipfile.ZipFile(dst) as zf:
        assert zf.read("images/cover.png") == PLACEHOLDERS[".png"]
        new_xhtml = zf.read("ch1.xhtml")
        assert b'width="24"' in new_xhtml
        assert b'height="12"' in new_xhtml
