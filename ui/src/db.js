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
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ requests: [{ type: 'execute', stmt }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = await res.json();
  const r = data.results[0];
  if (r.type === 'error') throw new Error(r.error.message);
  return r.response.result;
}

function toWireValue(v) {
  if (typeof v === 'number') return { type: 'integer', value: String(v) };
  if (typeof v === 'string') return { type: 'text', value: v };
  return { type: 'null' };
}

function fromWireValue(v) {
  if (!v || v.type === 'null') return null;
  if (v.type === 'integer') return parseInt(v.value, 10);
  if (v.type === 'float') return parseFloat(v.value);
  if (v.type === 'text') return v.value;
  if (v.type === 'blob') return Uint8Array.from(atob(v.base64), c => c.charCodeAt(0));
  return null;
}

function toRows(result) {
  return result.rows.map(row =>
    Object.fromEntries(result.cols.map((col, i) => [col.name, fromWireValue(row[i])]))
  );
}

export async function fetchTxts() {
  return toRows(await execute('SELECT id, name FROM txt ORDER BY id'));
}

export async function fetchParts(txtId) {
  return toRows(await execute(
    'SELECT id FROM txt_parts WHERE txt_id = ? ORDER BY id', [txtId]
  ));
}

export async function fetchPartContent(partId) {
  const rows = toRows(await execute(
    'SELECT content FROM txt_parts WHERE id = ?', [partId]
  ));
  return rows[0]?.content ?? null;
}
