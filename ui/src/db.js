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

async function execute(sql, args = []) {
  const stmt = args.length
    ? { sql, args: args.map(toWireValue) }
    : { sql };
  console.debug('[db]', sql, ...(args.length ? [args] : []));
  const t0 = performance.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      requests: [{ type: 'execute', stmt }],
    }),
  });
  if (!res.ok)
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const r = data.results[0];
  if (r.type === 'error') throw new Error(r.error.message);
  const result = r.response.result;
  const ms = (performance.now() - t0).toFixed(1);
  const n = result.rows.length;
  console.debug(`[db] ${ms}ms, ${n} row(s)`);
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

export async function fetchPartByOffset(txtId, offset) {
  const rows = toRows(await execute(
    'SELECT id, content FROM txt_parts' +
    ' WHERE txt_id = ? ORDER BY id LIMIT 1 OFFSET ?',
    [txtId, offset],
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
    `SELECT t.id AS txt_id, t.name, t.last_accessed,
       (SELECT COUNT(*) FROM txt_parts
        WHERE txt_id = t.id
        AND id <= (
          SELECT id FROM txt_parts
          WHERE txt_id = t.id AND last_accessed IS NOT NULL
          ORDER BY last_accessed DESC LIMIT 1
        )
       ) AS last_part_num
     FROM txt t
     WHERE t.last_accessed IS NOT NULL
     ORDER BY t.last_accessed DESC
     LIMIT 5`,
  ));
}

export async function upsertAccess(txtId, txtPartId) {
  const now = Date.now();
  await execute('UPDATE txt SET last_accessed = ? WHERE id = ?', [now, txtId]);
  await execute('UPDATE txt_parts SET last_accessed = ? WHERE id = ?', [now, txtPartId]);
}
