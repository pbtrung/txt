import secrets

import pytest

from txt.crypto_blob import MIN_BLOB_LEN, CryptoBlob


@pytest.fixture
def blob(engine):
    return CryptoBlob(engine)


def test_encrypt_produces_correct_header(blob):
    out = blob.encrypt(b"payload", secrets.token_bytes(256))
    assert out[0:2] == b"\x54\x58"
    assert out[2:4] == b"\x01\x00"
    assert len(out) >= MIN_BLOB_LEN


def test_round_trip(blob):
    ikm, plaintext = secrets.token_bytes(256), b"some raw payload bytes"
    assert blob.decrypt(blob.encrypt(plaintext, ikm), ikm) == plaintext


def test_wrong_ikm_rejected(blob):
    ikm, plaintext = secrets.token_bytes(256), b"payload"
    encrypted = blob.encrypt(plaintext, ikm)
    with pytest.raises(ValueError):
        blob.decrypt(encrypted, secrets.token_bytes(256))


def test_tampered_blob_rejected(blob):
    ikm = secrets.token_bytes(256)
    encrypted = bytearray(blob.encrypt(b"payload", ikm))
    encrypted[70] ^= 0xFF
    with pytest.raises(ValueError):
        blob.decrypt(bytes(encrypted), ikm)


def test_too_short_blob_rejected(blob):
    with pytest.raises(ValueError):
        blob.decrypt(b"short", secrets.token_bytes(256))


def test_bad_magic_rejected(blob):
    ikm = secrets.token_bytes(256)
    encrypted = bytearray(blob.encrypt(b"payload", ikm))
    encrypted[0] ^= 0xFF
    with pytest.raises(ValueError):
        blob.decrypt(bytes(encrypted), ikm)


def test_json_round_trip(blob):
    ikm = secrets.token_bytes(256)
    payload = {"display_name": "Trung", "db_master_key": secrets.token_bytes(256).hex()}
    assert blob.decrypt_json(blob.encrypt_json(payload, ikm), ikm) == payload
