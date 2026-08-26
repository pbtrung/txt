import json
from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_pages_config_uses_only_the_pages_output_directory():
    config = json.loads((ROOT / "wrangler.jsonc").read_text())
    assert config["pages_build_output_dir"] == "./dist"
    assert "assets" not in config


def test_deploy_script_uses_the_pages_command():
    script = (ROOT / "scripts/deploy.sh").read_text()
    assert 'wrangler pages deploy dist --project-name "$CF_PROJECT_NAME"' in script
    assert "CF_PROJECT_NAME is required" in script


def test_headers_csp_restricts_script_execution():
    headers = (ROOT / "ui/_headers").read_text()
    csp = next(
        line for line in headers.splitlines() if "Content-Security-Policy" in line
    )
    assert "default-src 'none'" in csp
    assert "script-src 'self' 'wasm-unsafe-eval'" in csp
