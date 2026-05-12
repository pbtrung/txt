let endpoint = null;
let headers = null;

export function initDb(url, authToken) {
  const base = url.replace(/^libsql:\/\//, 'https://');
  endpoint = `${base}/v2/pipeline`;
  headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${authToken}`,
  };
}

function _parseResult(data) {
  const r = data.results[0];
  if (r.type === 'error') throw new Error(r.error.message);
  return r.response.result;
}

async function execute(sql, args = []) {
  const stmt = args.length ? { sql, args: args.map(toWireValue) } : { sql };
  console.debug('[db]', sql, ...(args.length ? [args] : []));
  const t0 = performance.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requests: [{ type: 'execute', stmt }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const result = _parseResult(await res.json());
  console.debug(`[db] ${(performance.now() - t0).toFixed(1)}ms, ${result.rows.length} row(s)`);
  return result;
}

function toWireValue(v) {
  if (typeof v === 'number')
    return { type: 'integer', value: String(v) };
  if (typeof v === 'string') return { type: 'text', value: v };
  if (v instanceof Uint8Array) {
    let s = '';
    for (const b of v) s += String.fromCharCode(b);
    return { type: 'blob', base64: btoa(s) };
  }
  return { type: 'null' };
}

function fromWireValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return parseInt(v.value, 10);
  if (v.type === 'float') return parseFloat(v.value);
  if (v.type === 'text') return v.value;
  if (v.type === 'blob')
    return Uint8Array.from(
      atob(v.base64), c => c.charCodeAt(0),
    );
  return null;
}

function toRows(result) {
  return result.rows.map(row =>
    Object.fromEntries(
      result.cols.map(
        (col, i) => [col.name, fromWireValue(row[i])],
      ),
    )
  );
}

export async function fetchOneTxt() {
  const rows = toRows(await execute(
    'SELECT id, name FROM txt ORDER BY RANDOM() LIMIT 1',
  ));
  return rows[0] ?? null;
}

export async function fetchTxts() {
  return toRows(await execute(
    'SELECT id, name FROM txt ORDER BY id',
  ));
}

export async function fetchPartCount(txtId) {
  const rows = toRows(await execute(
    'SELECT count FROM part_count WHERE txt_id = ?', [txtId]
  ));
  return rows[0]?.count ?? 0;
}

export async function fetchPartByNum(txtId, partNum) {
  const rows = toRows(await execute(
    'SELECT id, content FROM txt_parts WHERE txt_id = ? AND part_num = ?',
    [txtId, partNum],
  ));
  return rows[0] ?? null;
}

export async function fetchBookmarks(txtId) {
  return toRows(await execute(
    'SELECT id, bookmark FROM bookmarks WHERE txt_id = ? ORDER BY id',
    [txtId],
  ));
}

export async function insertBookmark(txtId, bookmarkBlob) {
  const result = await execute(
    'INSERT INTO bookmarks (txt_id, bookmark) VALUES (?, ?)',
    [txtId, bookmarkBlob],
  );
  return parseInt(result.last_insert_rowid, 10);
}

export async function deleteBookmark(id) {
  await execute('DELETE FROM bookmarks WHERE id = ?', [id]);
}

export async function fetchRecentAccess() {
  return toRows(await execute(
    'SELECT txt_id, last_part_num FROM txt_access ORDER BY last_accessed DESC LIMIT 5',
  ));
}

export async function fetchRecentBookmarks() {
  return toRows(await execute(
    'SELECT id, txt_id, bookmark FROM bookmarks ORDER BY id DESC LIMIT 5',
  ));
}

export async function upsertAccess(txtId, partNum) {
  await execute(
    'INSERT OR REPLACE INTO txt_access (txt_id, last_part_num, last_accessed) VALUES (?, ?, ?)',
    [txtId, partNum, Date.now()],
  );
}
