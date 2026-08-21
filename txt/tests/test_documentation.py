import re
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).parents[2]
DOCS = [ROOT / "README.md", ROOT / "CLAUDE.md", ROOT / "docker/README.md"]
DOCS.extend(sorted((ROOT / "docs").glob("*.md")))
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^]]*]\(([^)]+)\)")


def test_local_documentation_links_resolve():
    broken = []
    for document in DOCS:
        for target in MARKDOWN_LINK.findall(document.read_text()):
            relative = unquote(target.split("#", 1)[0])
            if not relative or "://" in relative:
                continue
            if not (document.parent / relative).resolve().exists():
                broken.append(f"{document.relative_to(ROOT)} -> {target}")
    assert not broken, "Broken documentation links:\n" + "\n".join(broken)
