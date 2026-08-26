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
    assert 'while [ "${UI_ORIGIN%/}" != "$UI_ORIGIN" ]; do' in entrypoint
    assert "UI_ORIGIN=${UI_ORIGIN%/}" in entrypoint
    assert "export DNS_RESOLVER RQLITE_ADMIN_HTPASSWD UI_ORIGIN" in entrypoint
    assert "$DNS_RESOLVER $RQLITE_ADMIN_HTPASSWD $UI_ORIGIN" in entrypoint


def test_nginx_rejects_wrong_origins_before_api_handlers():
    config = (ROOT / "docker/nginx.conf").read_text()
    assert "map_hash_bucket_size 128;" in config
    assert '"${UI_ORIGIN}" 1;' in config
    guard = "if ($ui_origin_allowed = 0) { return 403; }"
    assert config.count(guard) == 4


def test_lua_outbound_https_uses_the_system_ca_bundle():
    config = (ROOT / "docker/nginx.conf").read_text()
    dockerfile = (ROOT / "docker/Dockerfile").read_text()
    assert "lua_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;" in config
    assert "lua_ssl_verify_depth 4;" in config
    assert "ca-certificates" in dockerfile


def test_nginx_workers_drop_to_the_non_root_rqlite_user():
    config = (ROOT / "docker/nginx.conf").read_text()
    assert config.startswith("user rqlite rqlite;\n")


def test_entrypoint_hashes_the_operator_password_with_bcrypt():
    entrypoint = (ROOT / "docker/entrypoint.sh").read_text()
    assert "htpasswd -iBc" in entrypoint


def test_entrypoint_prepares_nginx_temp_dirs_for_the_non_root_user():
    entrypoint = (ROOT / "docker/entrypoint.sh").read_text()
    assert "mkdir -p" in entrypoint
    assert "/tmp/client-body /tmp/proxy" in entrypoint
    assert "chown -R rqlite:rqlite" in entrypoint
    assert "/tmp/client-body /tmp/proxy" in entrypoint.split("chown -R", 1)[1]
