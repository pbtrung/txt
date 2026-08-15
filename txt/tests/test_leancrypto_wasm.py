import pytest

from txt.leancrypto_wasm import KEM_PK_SIZE, KEM_SK_SIZE


def test_sizes_are_64(engine):
    assert (engine.key_size, engine.nonce_size, engine.tag_size) == (64, 64, 64)


def test_aead_round_trip(engine):
    key, nonce = bytes(range(64)), bytes(reversed(range(64)))
    aad, plaintext = b"context", b"a secret payload"
    ciphertext, tag = engine.aead_encrypt(key, nonce, aad, plaintext)
    assert engine.aead_decrypt(key, nonce, aad, ciphertext, tag) == plaintext


def test_aead_empty_plaintext_round_trips(engine):
    key, nonce = bytes(range(64)), bytes(range(64))
    ciphertext, tag = engine.aead_encrypt(key, nonce, b"", b"")
    assert engine.aead_decrypt(key, nonce, b"", ciphertext, tag) == b""


@pytest.mark.parametrize("field", ["ciphertext", "aad", "tag"])
def test_aead_decrypt_rejects_tampering(engine, field):
    key, nonce = bytes(range(64)), bytes(reversed(range(64)))
    aad, plaintext = b"context", b"a secret payload"
    ciphertext, tag = engine.aead_encrypt(key, nonce, aad, plaintext)
    tampered = {"ciphertext": ciphertext, "aad": aad, "tag": tag}
    original = tampered[field]
    tampered[field] = (
        bytes([original[0] ^ 0xFF]) + original[1:] if original else b"\x01"
    )
    with pytest.raises(ValueError):
        engine.aead_decrypt(
            key, nonce, tampered["aad"], tampered["ciphertext"], tampered["tag"]
        )


def test_aead_decrypt_rejects_wrong_key(engine):
    key, nonce, aad, plaintext = bytes(range(64)), bytes(range(64)), b"aad", b"payload"
    ciphertext, tag = engine.aead_encrypt(key, nonce, aad, plaintext)
    wrong_key = bytes([key[0] ^ 0xFF]) + key[1:]
    with pytest.raises(ValueError):
        engine.aead_decrypt(wrong_key, nonce, aad, ciphertext, tag)


def test_hkdf_is_deterministic_and_non_trivial(engine):
    ikm, salt, info = bytes(range(200)), bytes(range(64)), b"txt:test"
    out1 = engine.hkdf_sha3_512(ikm, salt, info, 64)
    out2 = engine.hkdf_sha3_512(ikm, salt, info, 64)
    assert out1 == out2
    assert any(b != 0 for b in out1)


def test_hkdf_differs_by_salt(engine):
    ikm, info = bytes(range(200)), b"txt:test"
    out1 = engine.hkdf_sha3_512(ikm, bytes(64), info, 64)
    out2 = engine.hkdf_sha3_512(ikm, bytes([1]) + bytes(63), info, 64)
    assert out1 != out2


def test_kem_keypair_sizes(engine):
    pk, sk = engine.kem_keypair()
    assert (len(pk), len(sk)) == (KEM_PK_SIZE, KEM_SK_SIZE)


def test_kem_keypair_is_random(engine):
    pk1, _ = engine.kem_keypair()
    pk2, _ = engine.kem_keypair()
    assert pk1 != pk2
