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
    `SELECT b.id, b.txt_part_id, b.part_num, b.line
     FROM bookmarks b
     JOIN txt_parts tp ON b.txt_part_id = tp.id
     WHERE tp.txt_id = ?
     ORDER BY b.part_num, b.line`,
    [txtId],
  ));
}

export async function insertBookmark(txtPartId, partNum, line) {
  const result = await execute(
    'INSERT INTO bookmarks (txt_part_id, part_num, line) VALUES (?, ?, ?)',
    [txtPartId, partNum, line],
  );
  return parseInt(result.last_insert_rowid, 10);
}

export async function deleteBookmark(id) {
  await execute('DELETE FROM bookmarks WHERE id = ?', [id]);
}
