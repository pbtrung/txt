import pathlib
import time

import wasmtime

WASM_PATH = (
    pathlib.Path(__file__).resolve().parent.parent / "sqlcipher" / "sqlcipher.wasm"
)

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

_VALTYPE = {
    "i32": wasmtime.ValType.i32(),
    "i64": wasmtime.ValType.i64(),
    "f64": wasmtime.ValType.f64(),
}


class WasmCall:
    def __init__(self, engine):
        self.engine = engine
        self.ptrs = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.engine._free_all(*self.ptrs)

    def write(self, data: bytes) -> int:
        ptr = self.engine._write(data)
        self.ptrs.append(ptr)
        return ptr

    def allocate(self, size: int) -> int:
        ptr = self.engine._malloc(size)
        self.ptrs.append(ptr)
        return ptr

    def read(self, ptr: int, size: int) -> bytes:
        return self.engine._read(ptr, size)


def _stub_functype(params, results):
    return wasmtime.FuncType(
        [_VALTYPE[p] for p in params], [_VALTYPE[r] for r in results]
    )


def _define(linker, store, name, params, results, fn):
    linker.define(
        store, "env", name, wasmtime.Func(store, _stub_functype(params, results), fn)
    )


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
    _define(
        linker, store, "__assert_fail", ["i32", "i32", "i32", "i32"], [], assert_fail
    )


def _define_env_lifecycle(linker, store):
    _define(linker, store, "exit", ["i32"], [], lambda code: None)
    _define(linker, store, "_emscripten_runtime_keepalive_clear", [], [], lambda: None)


def _define_env_time(linker, store):
    def now_ms():
        return time.time() * 1000

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
        with WasmCall(self) as call:
            args = self._hkdf_args(call, ikm, salt, info)
            out_ptr = call.allocate(dlen)
            self._call("lc_wasm_hkdf_sha3_512", *args, out_ptr, dlen)
            return call.read(out_ptr, dlen)

    def _hkdf_args(self, call: WasmCall, ikm, salt, info) -> list:
        return [
            call.write(ikm),
            len(ikm),
            call.write(salt),
            len(salt),
            call.write(info),
            len(info),
        ]

    def aead_encrypt(
        self, key: bytes, nonce: bytes, aad: bytes, plaintext: bytes
    ) -> tuple[bytes, bytes]:
        self._validate_aead(key, nonce)
        with WasmCall(self) as call:
            args = self._aead_args(call, key, nonce, aad, plaintext)
            ct_ptr = call.allocate(len(plaintext) or 1)
            tag_ptr = call.allocate(self.tag_size)
            self._call("lc_wasm_aead_encrypt", *args, ct_ptr, tag_ptr, self.tag_size)
            return call.read(ct_ptr, len(plaintext)), call.read(tag_ptr, self.tag_size)

    def aead_decrypt(
        self, key: bytes, nonce: bytes, aad: bytes, ciphertext: bytes, tag: bytes
    ) -> bytes:
        self._validate_aead(key, nonce, tag)
        with WasmCall(self) as call:
            args = self._aead_args(call, key, nonce, aad, ciphertext)
            pt_ptr = call.allocate(len(ciphertext) or 1)
            tag_ptr = call.write(tag)
            self._call("lc_wasm_aead_decrypt", *args, pt_ptr, tag_ptr, self.tag_size)
            return call.read(pt_ptr, len(ciphertext))

    def _aead_args(self, call: WasmCall, key, nonce, aad, data) -> list:
        return [
            call.write(key),
            self.key_size,
            call.write(nonce),
            self.nonce_size,
            call.write(aad),
            len(aad),
            call.write(data),
            len(data),
        ]

    def _validate_aead(self, key: bytes, nonce: bytes, tag: bytes | None = None):
        if len(key) != self.key_size:
            raise ValueError(f"AEAD key must be {self.key_size} bytes")
        if len(nonce) != self.nonce_size:
            raise ValueError(f"AEAD nonce must be {self.nonce_size} bytes")
        if tag is not None and len(tag) != self.tag_size:
            raise ValueError(f"AEAD tag must be {self.tag_size} bytes")

    def kem_keypair(self) -> tuple[bytes, bytes]:
        pk_ptr, sk_ptr = self._malloc(KEM_PK_SIZE), self._malloc(KEM_SK_SIZE)
        try:
            self._call("lc_kyber_1024_x448_keypair", pk_ptr, sk_ptr, self._rng_ctx_ptr)
            return self._read(pk_ptr, KEM_PK_SIZE), self._read(sk_ptr, KEM_SK_SIZE)
        finally:
            self._free_all(pk_ptr, sk_ptr)
