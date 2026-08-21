from pathlib import Path

ROOT = Path(__file__).parents[2]


def test_operator_proxy_allows_exact_ui_origin_preflight():
    config = (ROOT / "docker/nginx.conf").read_text()
    location = config.split("location /operator/rqlite/ {", 1)[1]
    location = location.split("location / {", 1)[0]
    assert 'Access-Control-Allow-Origin "${UI_ORIGIN}"' in location
    assert 'Access-Control-Allow-Methods "POST, OPTIONS"' in location
    assert 'Access-Control-Allow-Headers "Authorization, Content-Type"' in location
    assert "if ($request_method = OPTIONS) { return 204;" in location


def test_entrypoint_renders_ui_origin_into_nginx_config():
    entrypoint = (ROOT / "docker/entrypoint.sh").read_text()
    assert "export DNS_RESOLVER RQLITE_ADMIN_HTPASSWD UI_ORIGIN" in entrypoint
    assert "$DNS_RESOLVER $RQLITE_ADMIN_HTPASSWD $UI_ORIGIN" in entrypoint


def test_nginx_rejects_wrong_origins_before_api_and_operator_handlers():
    config = (ROOT / "docker/nginx.conf").read_text()
    assert '"${UI_ORIGIN}" 1;' in config
    guard = "if ($ui_origin_allowed = 0) { return 403; }"
    assert config.count(guard) == 5
