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

from .leancrypto_wasm import LeancryptoEngine

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


def _make_io_methods(engine, files: dict, open_files: dict):
    def x_close(p_file):
        info = open_files.pop(p_file, None)
        if info and info["delete_on_close"]:
            files.pop(info["name"], None)
        return SQLITE_OK

    def x_read(p_file, p_buf, i_amt, i_ofst):
        entry = files[open_files[p_file]["name"]]
        avail = len(entry) - i_ofst
        if avail <= 0:
            engine.memory.write(engine.store, b"\x00" * i_amt, p_buf)
            return SQLITE_IOERR_SHORT_READ
        n = min(avail, i_amt)
        engine.memory.write(engine.store, bytes(entry[i_ofst : i_ofst + n]), p_buf)
        if n < i_amt:
            engine.memory.write(engine.store, b"\x00" * (i_amt - n), p_buf + n)
            return SQLITE_IOERR_SHORT_READ
        return SQLITE_OK

    def x_write(p_file, p_buf, i_amt, i_ofst):
        name = open_files[p_file]["name"]
        if i_ofst + i_amt > len(files[name]):
            _resize_file(files, name, i_ofst + i_amt)
        data = bytes(engine.memory.read(engine.store, p_buf, p_buf + i_amt))
        files[name][i_ofst : i_ofst + i_amt] = data
        return SQLITE_OK

    def x_truncate(p_file, size):
        _resize_file(files, open_files[p_file]["name"], size)
        return SQLITE_OK

    def x_file_size(p_file, p_size):
        _write_i64(engine, p_size, len(files[open_files[p_file]["name"]]))
        return SQLITE_OK

    def x_check_reserved_lock(p_file, p_res_out):
        _write_i32(engine, p_res_out, 0)
        return SQLITE_OK

    return {
        "x_close": x_close,
        "x_read": x_read,
        "x_write": x_write,
        "x_truncate": x_truncate,
        "x_sync": lambda p_file, flags: SQLITE_OK,
        "x_file_size": x_file_size,
        "x_lock": lambda p_file, e_lock: SQLITE_OK,
        "x_unlock": lambda p_file, e_lock: SQLITE_OK,
        "x_check_reserved_lock": x_check_reserved_lock,
        "x_file_control": lambda p_file, op, p_arg: SQLITE_NOTFOUND,
        "x_sector_size": lambda p_file: 4096,
        "x_device_characteristics": lambda p_file: 0,
    }


def _make_vfs_methods(engine, files: dict, open_files: dict, state: dict):
    def x_open(p_vfs, z_name, p_file, flags, p_out_flags):
        if z_name:
            fname = _read_cstring(engine, z_name)
        else:
            fname = f":jsvfs-temp-{state['temp_counter']}:"
            state["temp_counter"] += 1
        files.setdefault(fname, bytearray())
        _write_i32(engine, p_file, state["io_methods_ptr"])
        open_files[p_file] = {
            "name": fname,
            "delete_on_close": bool(flags & 0x00000008),
        }
        if p_out_flags:
            _write_i32(engine, p_out_flags, flags)
        return SQLITE_OK

    def x_delete(p_vfs, z_name, sync_dir):
        files.pop(_read_cstring(engine, z_name), None)
        return SQLITE_OK

    def x_access(p_vfs, z_name, flags, p_res_out):
        exists = _read_cstring(engine, z_name) in files
        value = (1 if exists else 0) if flags == SQLITE_ACCESS_EXISTS else 1
        _write_i32(engine, p_res_out, value)
        return SQLITE_OK

    def x_full_pathname(p_vfs, z_name, n_out, z_out):
        _write_cstring(engine, _read_cstring(engine, z_name), z_out, n_out)
        return SQLITE_OK

    def x_randomness(p_vfs, n_byte, z_out):
        engine.memory.write(engine.store, secrets.token_bytes(n_byte), z_out)
        return n_byte

    def x_current_time(p_vfs, p_time_out):
        julian_day = 2440587.5 + time.time() * 1000 / 86400000
        engine.memory.write(engine.store, struct.pack("<d", julian_day), p_time_out)
        return SQLITE_OK

    def x_get_last_error(p_vfs, n_buf, z_buf):
        if n_buf > 0:
            engine.memory.write(engine.store, b"\x00", z_buf)
        return SQLITE_OK

    return {
        "x_open": x_open,
        "x_delete": x_delete,
        "x_access": x_access,
        "x_full_pathname": x_full_pathname,
        "x_randomness": x_randomness,
        "x_sleep": lambda p_vfs, microseconds: microseconds,
        "x_current_time": x_current_time,
        "x_get_last_error": x_get_last_error,
    }


def _method_specs(vfs: dict, io: dict) -> list:
    i32 = "i32"
    return [
        (vfs["x_open"], [i32] * 5),
        (vfs["x_delete"], [i32] * 3),
        (vfs["x_access"], [i32] * 4),
        (vfs["x_full_pathname"], [i32] * 4),
        (vfs["x_randomness"], [i32] * 3),
        (vfs["x_sleep"], [i32] * 2),
        (vfs["x_current_time"], [i32] * 2),
        (vfs["x_get_last_error"], [i32] * 3),
        (io["x_close"], [i32]),
        (io["x_read"], [i32, i32, i32, "i64"]),
        (io["x_write"], [i32, i32, i32, "i64"]),
        (io["x_truncate"], [i32, "i64"]),
        (io["x_sync"], [i32] * 2),
        (io["x_file_size"], [i32] * 2),
        (io["x_lock"], [i32] * 2),
        (io["x_unlock"], [i32] * 2),
        (io["x_check_reserved_lock"], [i32] * 2),
        (io["x_file_control"], [i32] * 3),
        (io["x_sector_size"], [i32]),
        (io["x_device_characteristics"], [i32]),
    ]


def register_js_vfs(engine, name: str = "jsvfs", make_default: bool = True) -> dict:
    files: dict[str, bytearray] = {}
    open_files: dict[int, dict] = {}
    state = {"io_methods_ptr": 0, "temp_counter": 0}
    io = _make_io_methods(engine, files, open_files)
    vfs = _make_vfs_methods(engine, files, open_files, state)

    method_ptrs = [
        _add_function(engine, fn, params, ["i32"])
        for fn, params in _method_specs(vfs, io)
    ]
    ptr_buf = engine._malloc(len(method_ptrs) * 4)
    for i, ptr in enumerate(method_ptrs):
        _write_i32(engine, ptr_buf + i * 4, ptr)
    name_ptr = engine._write(name.encode("utf-8") + b"\x00")

    rc = engine._exports["sqlite3_js_vfs_register"](
        engine.store, name_ptr, 4, 512, 1 if make_default else 0, ptr_buf
    )
    engine._free(name_ptr)
    engine._free(ptr_buf)
    if rc != SQLITE_OK:
        raise ValueError(f"sqlite3_js_vfs_register('{name}') failed: rc={rc}")

    state["io_methods_ptr"] = engine._exports["sqlite3_js_vfs_io_methods"](engine.store)
    return files


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
        self._key_db(db, key)
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
        rc = self._exports["sqlite3_step"](self.store, stmt)
        self._exports["sqlite3_finalize"](self.store, stmt)
        if rc != SQLITE_DONE:
            raise ValueError(f"{sql!r} step failed: rc={rc}, {self._errmsg()}")

    def query(self, sql: str, params: list | None = None) -> list:
        stmt = self._prepare(sql, params or [])
        rows = []
        while self._exports["sqlite3_step"](self.store, stmt) == SQLITE_ROW:
            rows.append(self._row(stmt))
        self._exports["sqlite3_finalize"](self.store, stmt)
        return rows

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
        for i, value in enumerate(params, start=1):
            self._bind(stmt, i, value)
        return stmt

    def _bind(self, stmt: int, idx: int, value) -> None:
        if isinstance(value, bool) or isinstance(value, int):
            self._exports["sqlite3_bind_int64"](self.store, stmt, idx, int(value))
        elif isinstance(value, (bytes, bytearray)):
            ptr = self._write(bytes(value))
            self._exports["sqlite3_bind_blob"](
                self.store, stmt, idx, ptr, len(value), SQLITE_TRANSIENT
            )
        elif isinstance(value, str):
            encoded = value.encode("utf-8")
            ptr = self._write(encoded)
            self._exports["sqlite3_bind_text"](
                self.store, stmt, idx, ptr, len(encoded), SQLITE_TRANSIENT
            )
        elif value is None:
            self._exports["sqlite3_bind_null"](self.store, stmt, idx)
        else:
            raise TypeError(f"unsupported bind type: {type(value)}")

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
