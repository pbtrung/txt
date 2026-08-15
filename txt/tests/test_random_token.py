from txt.random_token import generate_random_prefix, to_base32_crockford

CROCKFORD_CHARS = set("0123456789abcdefghjkmnpqrstvwxyz")


def test_known_vectors():
    assert to_base32_crockford(b"\x00") == "00"
    assert to_base32_crockford(b"\xff") == "zw"
    assert to_base32_crockford(b"") == ""


def test_32_bytes_encodes_to_52_chars():
    assert len(to_base32_crockford(bytes(32))) == 52


def test_generate_random_prefix_shape():
    token = generate_random_prefix()
    assert len(token) == 52
    assert set(token) <= CROCKFORD_CHARS


def test_generate_random_prefix_is_random():
    assert generate_random_prefix() != generate_random_prefix()
