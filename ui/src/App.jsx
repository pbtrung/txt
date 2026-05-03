import React, { useState, useEffect, useCallback, useRef } from 'react';
import { initCrypto, parseMasterKey, decryptName, decryptPart } from './crypto.js';
import { initDb, fetchTxts, fetchPartCount, fetchPartByOffset } from './db.js';

export default function App() {
  const [cryptoReady, setCryptoReady] = useState(false);
  const [creds, setCreds] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { initCrypto().then(() => setCryptoReady(true)); }, []);

  async function handleFile(file) {
    setError(null);
    try {
      const json = JSON.parse(await file.text());
      if (!json.turso_database_url || !json.turso_auth_token || !json.master_key)
        throw new Error('Missing required fields in creds.json');
      initDb(json.turso_database_url, json.turso_auth_token);
      setCreds({ masterKey: parseMasterKey(json.master_key) });
    } catch (e) {
      setError(e.message);
    }
  }

  if (!creds) {
    return (
      <div className="min-vh-100 d-flex align-items-center justify-content-center bg-light">
        <div className="card shadow-sm" style={{ maxWidth: 440, width: '100%', margin: '1rem' }}>
          <div className="card-body p-4">
            <h4 className="mb-1 fw-bold">txt_vault</h4>
            <p className="text-muted mb-4 small">
              Upload <code>creds.json</code> to connect to your Turso database.
            </p>
            {!cryptoReady && (
              <div className="d-flex align-items-center gap-2 mb-3 text-secondary small">
                <span className="spinner-border spinner-border-sm" />
                Initialising crypto…
              </div>
            )}
            {error && <div className="alert alert-danger py-2 small">{error}</div>}
            <label className="form-label fw-semibold">creds.json</label>
            <input
              type="file"
              className="form-control"
              accept=".json,application/json"
              disabled={!cryptoReady}
              onChange={e => e.target.files[0] && handleFile(e.target.files[0])}
            />
          </div>
        </div>
      </div>
    );
  }

  return <DataScreen masterKey={creds.masterKey} onDisconnect={() => setCreds(null)} />;
}

function DataScreen({ masterKey, onDisconnect }) {
  const [txts, setTxts]               = useState([]);
  const [selectedTxt, setSelectedTxt] = useState(null);
  const [totalParts, setTotalParts]   = useState(0);
  const [currentPartNum, setCurrentPartNum] = useState(1);
  const [content, setContent]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [fontSize, setFontSize]       = useState(16);
  const MIN_FONT = 8, MAX_FONT = 32;
  const loadedPartRef = useRef(null); // {txtId, partNum} of last requested load

  const wrap = useCallback(async (fn) => {
    setLoading(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  useEffect(() => {
    wrap(async () => {
      const rows = await fetchTxts();
      setTxts(rows.map(r => {
        let name;
        try { name = decryptName(r.name, masterKey); }
        catch { name = `<id ${r.id}>`; }
        return { id: r.id, name };
      }));
    });
  }, [masterKey, wrap]);

  async function loadPart(txt, partNum, total = totalParts) {
    const clamped = Math.max(1, Math.min(partNum, total || 1));
    const lp = loadedPartRef.current;
    if (lp && lp.txtId === txt.id && lp.partNum === clamped) return;
    loadedPartRef.current = { txtId: txt.id, partNum: clamped };
    setCurrentPartNum(clamped);
    setContent(null);
    wrap(async () => {
      const blob = await fetchPartByOffset(txt.id, clamped - 1);
      setContent(blob ? decryptPart(blob, masterKey) : '');
    });
  }

  async function selectTxt(txt) {
    setSelectedTxt(txt);
    setCurrentPartNum(1);
    setTotalParts(0);
    setContent(null);
    loadedPartRef.current = null;
    wrap(async () => {
      const total = await fetchPartCount(txt.id);
      setTotalParts(total);
      if (total > 0) {
        loadedPartRef.current = { txtId: txt.id, partNum: 1 };
        const blob = await fetchPartByOffset(txt.id, 0);
        setContent(blob ? decryptPart(blob, masterKey) : '');
      }
    });
  }

  const hasTxt    = !!selectedTxt;
  const hasParts  = totalParts > 0;

  return (
    <div className="container py-3" style={{ maxWidth: '60%' }}>
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div className="d-flex align-items-center gap-2">
          <span className="fw-bold">txt_vault</span>
          {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
        </div>
        <button className="btn btn-outline-secondary" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>

      {error && (
        <div className="alert alert-danger py-2 small mb-3" role="alert">{error}</div>
      )}

      <div className="row g-2">
        {/* Content */}
        <div className="col-12">
          <div className="card h-100">
            <div className="card-header d-flex align-items-center justify-content-between gap-2">
              <div className="d-flex align-items-center gap-2" style={{ flex: '1 1 0', minWidth: 0 }}>
                <div style={{ flex: '1 1 0', minWidth: 0 }}>
                <select
                  className="form-select"
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}
                  value={selectedTxt?.id ?? ''}
                  onChange={e => {
                    const txt = txts.find(t => t.id === Number(e.target.value));
                    if (txt) selectTxt(txt);
                  }}
                >
                  <option value="" disabled>— select file —</option>
                  {txts.map(txt => {
                    const label = txt.name.length > 60
                      ? txt.name.slice(0, 59) + '…'
                      : txt.name;
                    return (
                      <option key={txt.id} value={txt.id} title={txt.name}>{label}</option>
                    );
                  })}
                </select>
                </div>
                <div className="d-flex align-items-center gap-1 flex-shrink-0">
                  <button
                    className="btn btn-outline-secondary"
                    disabled={!hasTxt || currentPartNum <= 1}
                    onClick={() => loadPart(selectedTxt, currentPartNum - 1)}
                    title="Previous part"
                  >‹</button>
                  {hasTxt ? (
                    <input
                      type="number"
                      className="form-control text-center"
                      style={{ width: 64 }}
                      value={currentPartNum}
                      min={1}
                      max={totalParts || 1}
                      disabled={!hasParts}
                      onChange={e => setCurrentPartNum(Number(e.target.value))}
                      onBlur={() => loadPart(selectedTxt, currentPartNum)}
                      onKeyDown={e => { if (e.key === 'Enter') loadPart(selectedTxt, currentPartNum); }}
                    />
                  ) : (
                    <span className="text-muted px-2">&mdash;</span>
                  )}
                  <span className="text-muted flex-shrink-0">
                    / {hasTxt && hasParts ? totalParts : <>&mdash;</>}
                  </span>
                  <button
                    className="btn btn-outline-secondary"
                    disabled={!hasTxt || currentPartNum >= totalParts}
                    onClick={() => loadPart(selectedTxt, currentPartNum + 1)}
                    title="Next part"
                  >›</button>
                </div>
              </div>
              <div className="d-flex align-items-center gap-1 flex-shrink-0">
                <button
                  className="btn btn-outline-secondary"
                  disabled={fontSize <= MIN_FONT}
                  onClick={() => setFontSize(f => Math.max(MIN_FONT, f - 1))}
                  title="Decrease font size"
                >−</button>
                <span className="text-muted" style={{ minWidth: 40, textAlign: 'center' }}>
                  {fontSize}px
                </span>
                <button
                  className="btn btn-outline-secondary"
                  disabled={fontSize >= MAX_FONT}
                  onClick={() => setFontSize(f => Math.min(MAX_FONT, f + 1))}
                  title="Increase font size"
                >+</button>
              </div>
            </div>
            <div className="card-body overflow-auto p-3" style={{ maxHeight: '78vh' }}>
              {!hasTxt && (
                <p className="text-muted small mb-0">Select a file to view its content.</p>
              )}
              {hasTxt && content === null && !loading && (
                <p className="text-muted small mb-0">Loading…</p>
              )}
              {content !== null && (
                <pre className="mb-0" style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontSize: fontSize,
                  maxWidth: '88ch',
                  fontFamily: "'Literata', serif",
                }}>
                  {content}
                </pre>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
