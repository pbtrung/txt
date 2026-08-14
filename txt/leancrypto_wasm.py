import pathlib
import time

import wasmtime

WASM_PATH = pathlib.Path(__file__).resolve().parent.parent / "sqlcipher" / "sqlcipher.wasm"

# Composite ML-KEM-1024 + X448 sizes (docs/crypto.md's Composite KEM Key Sizes).
KEM_PK_SIZE = 1624
KEM_SK_SIZE = 3224
KEM_CT_SIZE = 1624
KEM_SS_SIZE = 88

# env.* imports this build needs beyond WASI, with stub behavior: our own
# calls (lc_wasm_hkdf_sha3_512/lc_wasm_aead_encrypt/decrypt, malloc/free) do
# no file I/O, date math, or signals, so these are unreachable in practice —
# defined only so the module instantiates. -1 is ENOSYS-ish "unsupported".
_ENV_STUB_SIGNATURES = {
    "__syscall_faccessat": (["i32", "i32", "i32", "i32"], ["i32"]),
    "__syscall_fchmod": (["i32", "i32"], ["i32"]),
    "__syscall_chmod": (["i32", "i32"], ["i32"]),
    "__syscall_fchown32": (["i32", "i32", "i32"], ["i32"]),
    "__syscall_fcntl64": (["i32", "i32", "i32"], ["i32"]),
    "__syscall_openat": (["i32", "i32", "i32", "i32"], ["i32"]),
    "__syscall_ioctl": (["i32", "i32", "i32"], ["i32"]),
    "__syscall_fstat64": (["i32", "i32"], ["i32"]),
    "__syscall_stat64": (["i32", "i32"], ["i32"]),
    "__syscall_newfstatat": (["i32", "i32", "i32", "i32"], ["i32"]),
    "__syscall_lstat64": (["i32", "i32"], ["i32"]),
    "__syscall_ftruncate64": (["i32", "i64"], ["i32"]),
    "__syscall_getcwd": (["i32", "i32"], ["i32"]),
    "__syscall_geteuid32": ([], ["i32"]),
    "__syscall_mkdirat": (["i32", "i32", "i32"], ["i32"]),
    "__syscall_readlinkat": (["i32", "i32", "i32", "i32"], ["i32"]),
    "__syscall_rmdir": (["i32"], ["i32"]),
    "__syscall_unlinkat": (["i32", "i32", "i32"], ["i32"]),
    "__syscall_utimensat": (["i32", "i32", "i32", "i32"], ["i32"]),
    "_timegm_js": (["i32"], ["i64"]),
    "_mktime_js": (["i32"], ["i64"]),
    "_localtime_js": (["i64", "i32"], ["i32"]),
    "_gmtime_js": (["i64", "i32"], ["i32"]),
    "_munmap_js": (["i32", "i32", "i32", "i32", "i32", "i64"], ["i32"]),
    "_msync_js": (["i32", "i32", "i32", "i32", "i32", "i64"], ["i32"]),
    "_mmap_js": (["i32", "i32", "i32", "i32", "i64", "i32", "i32"], ["i32"]),
    "__call_sighandler": (["i32", "i32"], []),
    "_tzset_js": (["i32", "i32", "i32", "i32"], []),
}

_VALTYPE = {"i32": wasmtime.ValType.i32(), "i64": wasmtime.ValType.i64(), "f64": wasmtime.ValType.f64()}


def _stub_functype(params, results):
    return wasmtime.FuncType([_VALTYPE[p] for p in params], [_VALTYPE[r] for r in results])


def _define(linker, store, name, params, results, fn):
    linker.define(store, "env", name, wasmtime.Func(store, _stub_functype(params, results), fn))


def _define_env_stubs(linker, store):
    for name, (params, results) in _ENV_STUB_SIGNATURES.items():
        fill = (lambda *_: -1) if results else (lambda *_: None)
        _define(linker, store, name, params, results, fill)


def _define_env_abort(linker, store):
    def abort_js():
        raise RuntimeError("sqlcipher.wasm called abort()")

    def assert_fail(_cond, _file, _line, _func):
        raise RuntimeError("sqlcipher.wasm assertion failed")

    _define(linker, store, "_abort_js", [], [], abort_js)
    _define(linker, store, "__assert_fail", ["i32", "i32", "i32", "i32"], [], assert_fail)


def _define_env_lifecycle(linker, store):
    _define(linker, store, "exit", ["i32"], [], lambda code: None)
    _define(linker, store, "_emscripten_runtime_keepalive_clear", [], [], lambda: None)


def _define_env_time(linker, store):
    now_ms = lambda: time.time() * 1000
    _define(linker, store, "emscripten_date_now", [], ["f64"], now_ms)
    _define(linker, store, "emscripten_get_now", [], ["f64"], now_ms)
    _define(linker, store, "emscripten_get_heap_max", [], ["i32"], lambda: 2**31 - 1)


def _define_env_resize_heap(linker, store, memory_holder):
    def resize_heap(requested_bytes):
        memory = memory_holder["memory"]
        current_bytes = memory.data_len(store)
        if requested_bytes <= current_bytes:
            return 1
        memory.grow(store, -(-(requested_bytes - current_bytes) // 65536))
        return 1

    _define(linker, store, "emscripten_resize_heap", ["i32"], ["i32"], resize_heap)


class LeancryptoEngine:
    def __init__(self):
        engine = wasmtime.Engine()
        module = wasmtime.Module.from_file(engine, str(WASM_PATH))
        self.store = wasmtime.Store(engine)
        self.store.set_wasi(wasmtime.WasiConfig())
        self._exports = self._instantiate(engine, module)
        self._activate()

    def _instantiate(self, engine, module):
        linker = wasmtime.Linker(engine)
        linker.define_wasi()
        _define_env_stubs(linker, self.store)
        _define_env_abort(linker, self.store)
        _define_env_lifecycle(linker, self.store)
        _define_env_time(linker, self.store)
        memory_holder = {"memory": None}
        _define_env_resize_heap(linker, self.store, memory_holder)
        instance = linker.instantiate(self.store, module)
        exports = instance.exports(self.store)
        memory_holder["memory"] = self.memory = exports["memory"]
        return exports

    def _activate(self):
        # Emscripten's JS glue normally runs these during module init; hosting
        # the module ourselves means we must call them explicitly, or every
        # leancrypto call fails as if the library were never activated.
        self._exports["__wasm_call_ctors"](self.store)
        self._exports["lc_activate_library"](self.store)
        self.key_size = self._exports["lc_wasm_key_size"](self.store)
        self.nonce_size = self._exports["lc_wasm_nonce_size"](self.store)
        self.tag_size = self._exports["lc_wasm_tag_size"](self.store)
        # lc_seeded_rng is `extern struct lc_rng_ctx *lc_seeded_rng` — the
        # exported wasm global holds the address of that pointer variable,
        # not the pointer value itself, so this needs one dereference.
        rng_var_addr = self._exports["lc_seeded_rng"].value(self.store)
        self._rng_ctx_ptr = int.from_bytes(self._read(rng_var_addr, 4), "little")

    def _malloc(self, nbytes: int) -> int:
        return self._exports["malloc"](self.store, nbytes)

    def _free(self, ptr: int) -> None:
        self._exports["free"](self.store, ptr)

    def _write(self, data: bytes) -> int:
        ptr = self._malloc(len(data)) if data else 0
        if data:
            self.memory.write(self.store, data, ptr)
        return ptr

    def _read(self, ptr: int, length: int) -> bytes:
        return bytes(self.memory.read(self.store, ptr, ptr + length))

    def _call(self, name: str, *args) -> None:
        rc = self._exports[name](self.store, *args)
        if rc != 0:
            raise ValueError(f"{name} failed: rc={rc}")

    def _free_all(self, *ptrs) -> None:
        for ptr in ptrs:
            self._free(ptr)

    def hkdf_sha3_512(self, ikm: bytes, salt: bytes, info: bytes, dlen: int) -> bytes:
        ikm_ptr, salt_ptr, info_ptr, out_ptr = self._write(ikm), self._write(salt), self._write(info), self._malloc(dlen)
        try:
            self._call("lc_wasm_hkdf_sha3_512", ikm_ptr, len(ikm), salt_ptr, len(salt), info_ptr, len(info), out_ptr, dlen)
            return self._read(out_ptr, dlen)
        finally:
            self._free_all(ikm_ptr, salt_ptr, info_ptr, out_ptr)

    def aead_encrypt(self, key: bytes, nonce: bytes, aad: bytes, plaintext: bytes) -> tuple[bytes, bytes]:
        key_ptr, nonce_ptr, aad_ptr = self._write(key), self._write(nonce), self._write(aad)
        pt_ptr, ct_ptr, tag_ptr = self._write(plaintext), self._malloc(len(plaintext) or 1), self._malloc(self.tag_size)
        try:
            self._call(
                "lc_wasm_aead_encrypt", key_ptr, self.key_size, nonce_ptr, self.nonce_size,
                aad_ptr, len(aad), pt_ptr, len(plaintext), ct_ptr, tag_ptr, self.tag_size,
            )
            return self._read(ct_ptr, len(plaintext)), self._read(tag_ptr, self.tag_size)
        finally:
            self._free_all(key_ptr, nonce_ptr, aad_ptr, pt_ptr, ct_ptr, tag_ptr)

    def aead_decrypt(self, key: bytes, nonce: bytes, aad: bytes, ciphertext: bytes, tag: bytes) -> bytes:
        key_ptr, nonce_ptr, aad_ptr = self._write(key), self._write(nonce), self._write(aad)
        ct_ptr, tag_ptr, pt_ptr = self._write(ciphertext), self._write(tag), self._malloc(len(ciphertext) or 1)
        try:
            self._call(
                "lc_wasm_aead_decrypt", key_ptr, self.key_size, nonce_ptr, self.nonce_size,
                aad_ptr, len(aad), ct_ptr, len(ciphertext), pt_ptr, tag_ptr, self.tag_size,
            )
            return self._read(pt_ptr, len(ciphertext))
        finally:
            self._free_all(key_ptr, nonce_ptr, aad_ptr, ct_ptr, tag_ptr, pt_ptr)

    def kem_keypair(self) -> tuple[bytes, bytes]:
        pk_ptr, sk_ptr = self._malloc(KEM_PK_SIZE), self._malloc(KEM_SK_SIZE)
        try:
            self._call("lc_kyber_1024_x448_keypair", pk_ptr, sk_ptr, self._rng_ctx_ptr)
            return self._read(pk_ptr, KEM_PK_SIZE), self._read(sk_ptr, KEM_SK_SIZE)
        finally:
            self._free_all(pk_ptr, sk_ptr)

    def kem_encapsulate(self, pk: bytes) -> tuple[bytes, bytes]:
        ct_ptr, ss_ptr, pk_ptr = self._malloc(KEM_CT_SIZE), self._malloc(KEM_SS_SIZE), self._write(pk)
        try:
            self._call("lc_kyber_1024_x448_enc", ct_ptr, ss_ptr, pk_ptr)
            return self._read(ct_ptr, KEM_CT_SIZE), self._read(ss_ptr, KEM_SS_SIZE)
        finally:
            self._free_all(ct_ptr, ss_ptr, pk_ptr)

    def kem_decapsulate(self, ct: bytes, sk: bytes) -> bytes:
        ss_ptr, ct_ptr, sk_ptr = self._malloc(KEM_SS_SIZE), self._write(ct), self._write(sk)
        try:
            self._call("lc_kyber_1024_x448_dec", ss_ptr, ct_ptr, sk_ptr)
            return self._read(ss_ptr, KEM_SS_SIZE)
        finally:
            self._free_all(ss_ptr, ct_ptr, sk_ptr)
