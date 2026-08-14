from txt.random_token import generate_db_path, generate_random_prefix, to_base32_crockford

CROCKFORD_CHARS = set("0123456789abcdefghjkmnpqrstvwxyz")


def test_known_vectors():
    assert to_base32_crockford(b"\x00") == "00"
    assert to_base32_crockford(b"\xff") == "zw"
    assert to_base32_crockford(b"") == ""


def test_32_bytes_encodes_to_52_chars():
    assert len(to_base32_crockford(bytes(32))) == 52


def test_generate_db_path_shape():
    token = generate_db_path()
    assert len(token) == 52
    assert set(token) <= CROCKFORD_CHARS


def test_generate_db_path_is_random():
    assert generate_db_path() != generate_db_path()


def test_generate_random_prefix_is_the_same_recipe():
    assert generate_random_prefix is generate_db_path
