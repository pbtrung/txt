"""ctypes bindings to leancrypto: AEAD, HKDF, HMAC, PBKDF2, ML-KEM-1024 + X448.

Signatures verified against /usr/include/leancrypto/{lc_ascon_keccak,lc_hkdf,
lc_hmac,lc_pbkdf2,lc_kyber_1024}.h.
"""

import ctypes
import ctypes.util

_S, _CP, _VP = ctypes.c_size_t, ctypes.c_char_p, ctypes.c_void_p


def _bind_hash_kdf(lib: ctypes.CDLL) -> None:
    lib.lc_hkdf.restype = ctypes.c_int
    lib.lc_hkdf.argtypes = [_VP, _CP, _S, _CP, _S, _CP, _S, _CP, _S]
    lib.lc_hmac.restype = ctypes.c_int
    lib.lc_hmac.argtypes = [_VP, _CP, _S, _CP, _S, _CP]
    lib.lc_pbkdf2.restype = ctypes.c_int
    lib.lc_pbkdf2.argtypes = [_VP, _CP, _S, _CP, _S, ctypes.c_uint32, _CP, _S]


def _bind_aead(lib: ctypes.CDLL) -> None:
    aead_args = [_VP, _CP, _CP, _S, _CP, _S, _CP, _S]
    lib.lc_ak_alloc_taglen.restype = ctypes.c_int
    lib.lc_ak_alloc_taglen.argtypes = [_VP, ctypes.c_uint8, ctypes.POINTER(_VP)]
    lib.lc_aead_setkey.restype = ctypes.c_int
    lib.lc_aead_setkey.argtypes = [_VP, _CP, _S, _CP, _S]
    lib.lc_aead_encrypt.restype = ctypes.c_int
    lib.lc_aead_encrypt.argtypes = aead_args
    lib.lc_aead_decrypt.restype = ctypes.c_int
    lib.lc_aead_decrypt.argtypes = aead_args
    lib.lc_aead_zero_free.restype = None
    lib.lc_aead_zero_free.argtypes = [_VP]


def _bind_kem(lib: ctypes.CDLL) -> None:
    lib.lc_kyber_1024_x448_keypair.restype = ctypes.c_int
    lib.lc_kyber_1024_x448_keypair.argtypes = [_CP, _CP, _VP]
    lib.lc_kyber_1024_x448_enc.restype = ctypes.c_int
    lib.lc_kyber_1024_x448_enc.argtypes = [_CP, _CP, _CP]
    lib.lc_kyber_1024_x448_dec.restype = ctypes.c_int
    lib.lc_kyber_1024_x448_dec.argtypes = [_CP, _CP, _CP]


def _load_leancrypto() -> tuple[str, ctypes.CDLL, _VP, _VP, _VP]:
    name = ctypes.util.find_library("leancrypto")
    if not name:
        raise RuntimeError("leancrypto not found; install it and run ldconfig")
    lib = ctypes.CDLL(name)
    sha3_512 = ctypes.c_void_p.in_dll(lib, "lc_sha3_512")
    sha3_256 = ctypes.c_void_p.in_dll(lib, "lc_sha3_256")
    seeded_rng = ctypes.c_void_p.in_dll(lib, "lc_seeded_rng")
    _bind_hash_kdf(lib)
    _bind_aead(lib)
    _bind_kem(lib)
    return name, lib, sha3_512, sha3_256, seeded_rng


library_name, lib, sha3_512, sha3_256, seeded_rng = _load_leancrypto()
