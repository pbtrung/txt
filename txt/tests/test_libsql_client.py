import base64

from txt.libsql_client import _cell_value, _to_arg


def test_to_arg_int():
    assert _to_arg(42) == {"type": "integer", "value": "42"}


def test_to_arg_text():
    assert _to_arg("hello") == {"type": "text", "value": "hello"}


def test_to_arg_bytes_is_base64_blob():
    data = bytes(range(10))
    arg = _to_arg(data)
    assert arg["type"] == "blob"
    assert base64.b64decode(arg["base64"]) == data


def test_cell_value_roundtrips_blob():
    data = bytes(range(20))
    cell = _to_arg(data)
    assert _cell_value(cell) == data


def test_cell_value_text_and_integer():
    assert _cell_value({"type": "text", "value": "hi"}) == "hi"
    assert _cell_value({"type": "integer", "value": "7"}) == "7"


def test_cell_value_null():
    assert _cell_value({"type": "null"}) is None
