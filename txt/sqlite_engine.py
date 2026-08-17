"""A real, writable SQLCipher-keyed SQLite database, driven through
sqlcipher.wasm via an in-memory sqlite3_vfs whose xOpen/xRead/xWrite/...
are plain Python callbacks turned into real, indirectly-callable WASM
function pointers via the exported __indirect_function_table, wired into
an actual C sqlite3_vfs struct by the wasm build's own
sqlite3_js_vfs_register(). The whole database lives in a Python
bytearray, never touching a real file, so no OS-level filesystem
syscalls are needed inside the sandbox.
"""

import secrets
import struct
import time

import wasmtime

from .leancrypto_wasm import LeancryptoEngine, WasmCall

DB_FILENAME = "/db.sqlite"

SQLITE_OK = 0
SQLITE_ROW = 100
SQLITE_DONE = 101
SQLITE_OPEN_READWRITE = 0x00000002
SQLITE_OPEN_CREATE = 0x00000004
SQLITE_ACCESS_EXISTS = 0
SQLITE_IOERR_SHORT_READ = 522
SQLITE_NOTFOUND = 12
SQLITE_TRANSIENT = -1

SQLITE_INTEGER = 1
SQLITE_TEXT = 3
SQLITE_BLOB = 4

_VALTYPE = {"i32": wasmtime.ValType.i32(), "i64": wasmtime.ValType.i64()}


def _functype(params, results):
    return wasmtime.FuncType(
        [_VALTYPE[p] for p in params], [_VALTYPE[r] for r in results]
    )


def _add_function(engine, callback, params, results):
    table = engine._exports["__indirect_function_table"]
    func = wasmtime.Func(engine.store, _functype(params, results), callback)
    idx = table.grow(engine.store, 1, None)
    table.set(engine.store, idx, func)
    return idx


def _read_cstring(engine, ptr: int) -> str:
    if ptr == 0:
        return ""
    end = ptr
    while engine.memory.read(engine.store, end, end + 1)[0] != 0:
        end += 1
    return bytes(engine.memory.read(engine.store, ptr, end)).decode("utf-8")


def _write_cstring(engine, s: str, ptr: int, max_len: int) -> None:
    encoded = s.encode("utf-8")[: max(max_len - 1, 0)]
    engine.memory.write(engine.store, encoded + b"\x00", ptr)


def _read_i32(engine, ptr: int) -> int:
    return int.from_bytes(
        engine.memory.read(engine.store, ptr, ptr + 4), "little", signed=True
    )


def _write_i32(engine, ptr: int, value: int) -> None:
    engine.memory.write(
        engine.store, int(value).to_bytes(4, "little", signed=True), ptr
    )


def _write_i64(engine, ptr: int, value: int) -> None:
    engine.memory.write(
        engine.store, int(value).to_bytes(8, "little", signed=False), ptr
    )


def _resize_file(files: dict, name: str, new_len: int) -> None:
    entry = files[name]
    if new_len == len(entry):
        return
    if new_len < len(entry):
        del entry[new_len:]
    else:
        entry.extend(b"\x00" * (new_len - len(entry)))


class IoMethods:
    def __init__(self, engine, files: dict, open_files: dict):
        self.engine, self.files, self.open_files = engine, files, open_files

    def x_close(self, p_file):
        info = self.open_files.pop(p_file, None)
        if info and info["delete_on_close"]:
            self.files.pop(info["name"], None)
        return SQLITE_OK

    def x_read(self, p_file, p_buf, i_amt, i_ofst):
        entry = self.files[self.open_files[p_file]["name"]]
        avail = len(entry) - i_ofst
        if avail <= 0:
            self._write_zeros(p_buf, i_amt)
            return SQLITE_IOERR_SHORT_READ
        n = min(avail, i_amt)
        data = bytes(entry[i_ofst : i_ofst + n])
        self.engine.memory.write(self.engine.store, data, p_buf)
        if n < i_amt:
            self._write_zeros(p_buf + n, i_amt - n)
            return SQLITE_IOERR_SHORT_READ
        return SQLITE_OK

    def _write_zeros(self, ptr: int, size: int) -> None:
        self.engine.memory.write(self.engine.store, b"\x00" * size, ptr)

    def x_write(self, p_file, p_buf, i_amt, i_ofst):
        name = self.open_files[p_file]["name"]
        _ensure_file_size(self.files, name, i_ofst + i_amt)
        data = bytes(self.engine.memory.read(self.engine.store, p_buf, p_buf + i_amt))
        self.files[name][i_ofst : i_ofst + i_amt] = data
        return SQLITE_OK

    def x_truncate(self, p_file, size):
        _resize_file(self.files, self.open_files[p_file]["name"], size)
        return SQLITE_OK

    def x_file_size(self, p_file, p_size):
        size = len(self.files[self.open_files[p_file]["name"]])
        _write_i64(self.engine, p_size, size)
        return SQLITE_OK

    def x_check_reserved_lock(self, p_file, p_res_out):
        _write_i32(self.engine, p_res_out, 0)
        return SQLITE_OK

    @staticmethod
    def x_sync(p_file, flags):
        return SQLITE_OK

    @staticmethod
    def x_lock(p_file, e_lock):
        return SQLITE_OK

    @staticmethod
    def x_unlock(p_file, e_lock):
        return SQLITE_OK

    @staticmethod
    def x_file_control(p_file, op, p_arg):
        return SQLITE_NOTFOUND

    @staticmethod
    def x_sector_size(p_file):
        return 4096

    @staticmethod
    def x_device_characteristics(p_file):
        return 0


class VfsMethods:
    def __init__(self, engine, files: dict, open_files: dict):
        self.engine, self.files, self.open_files = engine, files, open_files
        self.io_methods_ptr = 0
        self.temp_counter = 0

    def x_open(self, p_vfs, z_name, p_file, flags, p_out_flags):
        name = self._filename(z_name)
        self.files.setdefault(name, bytearray())
        _write_i32(self.engine, p_file, self.io_methods_ptr)
        self.open_files[p_file] = {
            "name": name,
            "delete_on_close": bool(flags & 0x00000008),
        }
        if p_out_flags:
            _write_i32(self.engine, p_out_flags, flags)
        return SQLITE_OK

    def _filename(self, name_ptr: int) -> str:
        if name_ptr:
            return _read_cstring(self.engine, name_ptr)
        name = f":jsvfs-temp-{self.temp_counter}:"
        self.temp_counter += 1
        return name

    def x_delete(self, p_vfs, z_name, sync_dir):
        self.files.pop(_read_cstring(self.engine, z_name), None)
        return SQLITE_OK

    def x_access(self, p_vfs, z_name, flags, p_res_out):
        exists = _read_cstring(self.engine, z_name) in self.files
        value = (1 if exists else 0) if flags == SQLITE_ACCESS_EXISTS else 1
        _write_i32(self.engine, p_res_out, value)
        return SQLITE_OK

    def x_full_pathname(self, p_vfs, z_name, n_out, z_out):
        name = _read_cstring(self.engine, z_name)
        _write_cstring(self.engine, name, z_out, n_out)
        return SQLITE_OK

    def x_randomness(self, p_vfs, n_byte, z_out):
        self.engine.memory.write(self.engine.store, secrets.token_bytes(n_byte), z_out)
        return n_byte

    def x_current_time(self, p_vfs, p_time_out):
        julian_day = 2440587.5 + time.time() * 1000 / 86400000
        packed = struct.pack("<d", julian_day)
        self.engine.memory.write(self.engine.store, packed, p_time_out)
        return SQLITE_OK

    def x_get_last_error(self, p_vfs, n_buf, z_buf):
        if n_buf > 0:
            self.engine.memory.write(self.engine.store, b"\x00", z_buf)
        return SQLITE_OK

    @staticmethod
    def x_sleep(p_vfs, microseconds):
        return microseconds


VFS_SPECS = (
    ("x_open", ["i32"] * 5),
    ("x_delete", ["i32"] * 3),
    ("x_access", ["i32"] * 4),
    ("x_full_pathname", ["i32"] * 4),
    ("x_randomness", ["i32"] * 3),
    ("x_sleep", ["i32"] * 2),
    ("x_current_time", ["i32"] * 2),
    ("x_get_last_error", ["i32"] * 3),
)
IO_SPECS = (
    ("x_close", ["i32"]),
    ("x_read", ["i32", "i32", "i32", "i64"]),
    ("x_write", ["i32", "i32", "i32", "i64"]),
    ("x_truncate", ["i32", "i64"]),
    ("x_sync", ["i32"] * 2),
    ("x_file_size", ["i32"] * 2),
    ("x_lock", ["i32"] * 2),
    ("x_unlock", ["i32"] * 2),
    ("x_check_reserved_lock", ["i32"] * 2),
    ("x_file_control", ["i32"] * 3),
    ("x_sector_size", ["i32"]),
    ("x_device_characteristics", ["i32"]),
)


def _ensure_file_size(files: dict, name: str, size: int) -> None:
    if size > len(files[name]):
        _resize_file(files, name, size)


def _method_specs(vfs: VfsMethods, io: IoMethods) -> list:
    return _owner_specs(vfs, VFS_SPECS) + _owner_specs(io, IO_SPECS)


def _owner_specs(owner, specs: tuple) -> list:
    return [(getattr(owner, name), params) for name, params in specs]


def register_js_vfs(engine, name: str = "jsvfs", make_default: bool = True) -> dict:
    files: dict[str, bytearray] = {}
    open_files: dict[int, dict] = {}
    io = IoMethods(engine, files, open_files)
    vfs = VfsMethods(engine, files, open_files)
    ptr_buf = _register_callbacks(engine, _method_specs(vfs, io))
    _register_vfs(engine, name, make_default, ptr_buf)
    vfs.io_methods_ptr = engine._exports["sqlite3_js_vfs_io_methods"](engine.store)
    return files


def _register_callbacks(engine, specs: list) -> int:
    pointers = [_add_function(engine, fn, params, ["i32"]) for fn, params in specs]
    ptr_buf = engine._malloc(len(pointers) * 4)
    for i, ptr in enumerate(pointers):
        _write_i32(engine, ptr_buf + i * 4, ptr)
    return ptr_buf


def _register_vfs(engine, name: str, make_default: bool, ptr_buf: int) -> None:
    with WasmCall(engine) as call:
        call.ptrs.append(ptr_buf)
        name_ptr = call.write(name.encode("utf-8") + b"\x00")
        rc = engine._exports["sqlite3_js_vfs_register"](
            engine.store, name_ptr, 4, 512, int(make_default), ptr_buf
        )
    if rc != SQLITE_OK:
        raise ValueError(f"sqlite3_js_vfs_register('{name}') failed: rc={rc}")


class SqliteEngine(LeancryptoEngine):
    def __init__(self):
        super().__init__()
        self.files = register_js_vfs(self)
        self.db = 0

    def open(self, db_master_key: bytes, initial_bytes: bytes | None = None) -> None:
        if initial_bytes:
            self.files[DB_FILENAME] = bytearray(initial_bytes)
        self.db = self._sqlite3_open(db_master_key)

    def to_bytes(self) -> bytes:
        return bytes(self.files.get(DB_FILENAME, b""))

    def close(self) -> None:
        if self.db:
            self._exports["sqlite3_close"](self.store, self.db)
        self.db = 0

    def last_insert_rowid(self) -> int:
        return self._exports["sqlite3_last_insert_rowid"](self.store, self.db)

    def vacuum(self) -> None:
        self.exec_sql("VACUUM")

    def _sqlite3_open(self, key: bytes) -> int:
        fn_ptr = self._write(DB_FILENAME.encode() + b"\x00")
        pp_db = self._malloc(4)
        flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE
        rc = self._exports["sqlite3_open_v2"](self.store, fn_ptr, pp_db, flags, 0)
        db = _read_i32(self, pp_db)
        self._free_all(fn_ptr, pp_db)
        if rc != SQLITE_OK:
            raise ValueError(f"sqlite3_open_v2 failed: rc={rc}")
        try:
            self._key_db(db, key)
        except Exception:
            self._exports["sqlite3_close"](self.store, db)
            raise
        return db

    def _key_db(self, db: int, key: bytes) -> None:
        key_str = "x'" + key.hex() + "'"
        key_ptr = self._write(key_str.encode() + b"\x00")
        rc = self._exports["sqlite3_key"](self.store, db, key_ptr, len(key_str))
        self._free(key_ptr)
        if rc != SQLITE_OK:
            raise ValueError(f"sqlite3_key failed: rc={rc}")

    def _errmsg(self) -> str:
        return _read_cstring(self, self._exports["sqlite3_errmsg"](self.store, self.db))

    def exec_sql(self, sql: str) -> None:
        ptr = self._write(sql.encode() + b"\x00")
        rc = self._exports["sqlite3_exec"](self.store, self.db, ptr, 0, 0, 0)
        self._free(ptr)
        if rc != SQLITE_OK:
            raise ValueError(f"{sql!r} failed: rc={rc}, {self._errmsg()}")

    def execute(self, sql: str, params: list | None = None) -> None:
        stmt = self._prepare(sql, params or [])
        try:
            rc = self._exports["sqlite3_step"](self.store, stmt)
            if rc != SQLITE_DONE:
                raise ValueError(f"{sql!r} step failed: rc={rc}, {self._errmsg()}")
        finally:
            self._finalize(stmt)

    def query(self, sql: str, params: list | None = None) -> list:
        stmt = self._prepare(sql, params or [])
        try:
            return self._query_rows(stmt, sql)
        finally:
            self._finalize(stmt)

    def _query_rows(self, stmt: int, sql: str) -> list:
        rows = []
        while True:
            rc = self._exports["sqlite3_step"](self.store, stmt)
            if rc == SQLITE_ROW:
                rows.append(self._row(stmt))
            elif rc == SQLITE_DONE:
                return rows
            else:
                raise ValueError(f"{sql!r} step failed: rc={rc}, {self._errmsg()}")

    def _finalize(self, stmt: int) -> None:
        self._exports["sqlite3_finalize"](self.store, stmt)

    def _prepare(self, sql: str, params: list) -> int:
        sql_ptr = self._write(sql.encode() + b"\x00")
        pp_stmt = self._malloc(4)
        rc = self._exports["sqlite3_prepare_v2"](
            self.store, self.db, sql_ptr, -1, pp_stmt, 0
        )
        stmt = _read_i32(self, pp_stmt)
        self._free_all(sql_ptr, pp_stmt)
        if rc != SQLITE_OK:
            raise ValueError(f"prepare {sql!r} failed: rc={rc}, {self._errmsg()}")
        self._bind_all(stmt, params)
        return stmt

    def _bind_all(self, stmt: int, params: list) -> None:
        try:
            for i, value in enumerate(params, start=1):
                self._bind(stmt, i, value)
        except Exception:
            self._finalize(stmt)
            raise

    def _bind(self, stmt: int, idx: int, value) -> None:
        if isinstance(value, bool) or isinstance(value, int):
            rc = self._exports["sqlite3_bind_int64"](self.store, stmt, idx, int(value))
        elif isinstance(value, (bytes, bytearray, memoryview)):
            rc = self._bind_bytes(stmt, idx, bytes(value), "sqlite3_bind_blob")
        elif isinstance(value, str):
            rc = self._bind_bytes(stmt, idx, value.encode(), "sqlite3_bind_text")
        elif value is None:
            rc = self._exports["sqlite3_bind_null"](self.store, stmt, idx)
        else:
            raise TypeError(f"unsupported bind type: {type(value)}")
        self._check_bind_result(rc, idx)

    def _bind_bytes(self, stmt: int, idx: int, value: bytes, export: str) -> int:
        ptr = self._write(value) if value else self._malloc(1)
        try:
            return self._exports[export](
                self.store, stmt, idx, ptr, len(value), SQLITE_TRANSIENT
            )
        finally:
            self._free(ptr)

    def _check_bind_result(self, rc: int, idx: int) -> None:
        if rc != SQLITE_OK:
            raise ValueError(f"bind parameter {idx} failed: rc={rc}, {self._errmsg()}")

    def _row(self, stmt: int) -> tuple:
        count = self._exports["sqlite3_column_count"](self.store, stmt)
        return tuple(self._column(stmt, i) for i in range(count))

    def _column(self, stmt: int, i: int):
        col_type = self._exports["sqlite3_column_type"](self.store, stmt, i)
        if col_type == SQLITE_INTEGER:
            return self._exports["sqlite3_column_int64"](self.store, stmt, i)
        if col_type == SQLITE_TEXT:
            return _read_cstring(
                self, self._exports["sqlite3_column_text"](self.store, stmt, i)
            )
        if col_type == SQLITE_BLOB:
            return self._column_blob(stmt, i)
        return None

    def _column_blob(self, stmt: int, i: int) -> bytes:
        ptr = self._exports["sqlite3_column_blob"](self.store, stmt, i)
        n = self._exports["sqlite3_column_bytes"](self.store, stmt, i)
        return bytes(self.memory.read(self.store, ptr, ptr + n)) if n else b""
