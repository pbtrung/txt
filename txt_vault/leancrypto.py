import ctypes
import ctypes.util


def _bind_hkdf_hmac(lib):
    S, CP, VP = ctypes.c_size_t, ctypes.c_char_p, ctypes.c_void_p
    lib.lc_hkdf.restype = ctypes.c_int
    lib.lc_hkdf.argtypes = [VP, CP, S, CP, S, CP, S, CP, S]
    lib.lc_hmac.restype = ctypes.c_int
    lib.lc_hmac.argtypes = [VP, CP, S, CP, S, CP]


def _bind_aead(lib):
    S, CP, VP = ctypes.c_size_t, ctypes.c_char_p, ctypes.c_void_p
    _A = [VP, CP, CP, S, CP, S, CP, S]
    lib.lc_ak_alloc_taglen.restype = ctypes.c_int
    lib.lc_ak_alloc_taglen.argtypes = [VP, ctypes.c_uint8, ctypes.POINTER(VP)]
    lib.lc_aead_setkey.restype = ctypes.c_int
    lib.lc_aead_setkey.argtypes = [VP, CP, S, CP, S]
    lib.lc_aead_encrypt.restype = ctypes.c_int
    lib.lc_aead_encrypt.argtypes = _A
    lib.lc_aead_decrypt.restype = ctypes.c_int
    lib.lc_aead_decrypt.argtypes = _A
    lib.lc_aead_zero_free.restype = None
    lib.lc_aead_zero_free.argtypes = [VP]


def _load_leancrypto():
    name = ctypes.util.find_library("leancrypto")
    if not name:
        raise RuntimeError("leancrypto not found; install it and run ldconfig")
    lib = ctypes.CDLL(name)
    sha3_512 = ctypes.c_void_p.in_dll(lib, "lc_sha3_512")
    sha3_256 = ctypes.c_void_p.in_dll(lib, "lc_sha3_256")
    _bind_hkdf_hmac(lib)
    _bind_aead(lib)
    return name, lib, sha3_512, sha3_256


library_name, lib, sha3_512, sha3_256 = _load_leancrypto()
