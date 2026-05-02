import React, { useState, useEffect, useCallback } from 'react';
import { initCrypto, parseMasterKey, decryptName, decryptPart } from './crypto.js';
import { initDb, fetchTxts, fetchParts, fetchPartContent } from './db.js';

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
  const [parts, setParts]             = useState([]);
  const [selectedPart, setSelectedPart] = useState(null);
  const [content, setContent]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [fontSize, setFontSize]       = useState(16);
  const MIN_FONT = 8, MAX_FONT = 32;

  const wrap = useCallback(async (fn) => {
    setLoading(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    setLoading(false);
  }, []);

  // Load txt list on mount
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

  async function selectTxt(txt) {
    setSelectedTxt(txt);
    setSelectedPart(null);
    setContent(null);
    wrap(async () => {
      const rows = await fetchParts(txt.id);
      const mapped = rows.map((r, i) => ({ id: r.id, label: String(i + 1).padStart(3, '0') }));
      setParts(mapped);
      if (mapped.length > 0) await selectPart(mapped[0]);
    });
  }

  async function selectPart(part) {
    setSelectedPart(part);
    setContent(null);
    wrap(async () => {
      const blob = await fetchPartContent(part.id);
      setContent(blob ? decryptPart(blob, masterKey) : '');
    });
  }

  return (
    <div className="container-fluid py-3 px-3">
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div className="d-flex align-items-center gap-2">
          <span className="fw-bold">txt_vault</span>
          {loading && <span className="spinner-border spinner-border-sm text-secondary" />}
        </div>
        <button className="btn btn-sm btn-outline-secondary" onClick={onDisconnect}>
          Disconnect
        </button>
      </div>

      {error && (
        <div className="alert alert-danger py-2 small mb-3" role="alert">{error}</div>
      )}

      <div className="row g-2">
        {/* Column 1 — file names */}
        <div className="col-12 col-md-3">
          <div className="card h-100">
            <div className="card-header py-2 fw-semibold small">Files</div>
            <div className="list-group list-group-flush overflow-auto" style={{ maxHeight: '78vh' }}>
              {txts.length === 0 && !loading && (
                <div className="list-group-item text-muted small">No files found.</div>
              )}
              {txts.map(txt => (
                <button
                  key={txt.id}
                  className={`list-group-item list-group-item-action small${selectedTxt?.id === txt.id ? ' active' : ''}`}
                  onClick={() => selectTxt(txt)}
                >
                  {txt.name}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Column 2 — content */}
        <div className="col-12 col-md-9">
          <div className="card h-100">
            <div className="card-header py-2 d-flex align-items-center justify-content-between gap-2">
              <div className="d-flex align-items-center gap-2" style={{ flex: '1 1 0', minWidth: 0 }}>
                <span className="fw-semibold small text-truncate">
                  {selectedTxt ? selectedTxt.name : 'Content'}
                </span>
                {(() => {
                  const partIdx = parts.findIndex(p => p.id === selectedPart?.id);
                  return (
                    <div className="d-flex align-items-center gap-1 flex-shrink-0">
                      <button
                        className="btn btn-sm btn-outline-secondary py-0 px-2"
                        disabled={partIdx <= 0}
                        onClick={() => selectPart(parts[partIdx - 1])}
                        title="Previous part"
                      >‹</button>
                      <select
                        className="form-select form-select-sm py-0"
                        style={{ width: 'auto', minWidth: 90 }}
                        value={selectedPart?.id ?? ''}
                        disabled={!selectedTxt || parts.length === 0}
                        onChange={e => {
                          const part = parts.find(p => p.id === Number(e.target.value));
                          if (part) selectPart(part);
                        }}
                      >
                        {!selectedTxt && <option value="">— no file —</option>}
                        {selectedTxt && parts.length === 0 && <option value="">— no parts —</option>}
                        {parts.map(part => (
                          <option key={part.id} value={part.id}>{part.label}</option>
                        ))}
                      </select>
                      <button
                        className="btn btn-sm btn-outline-secondary py-0 px-2"
                        disabled={partIdx < 0 || partIdx >= parts.length - 1}
                        onClick={() => selectPart(parts[partIdx + 1])}
                        title="Next part"
                      >›</button>
                    </div>
                  );
                })()}
              </div>
              <div className="d-flex align-items-center gap-1 flex-shrink-0">
                <button
                  className="btn btn-sm btn-outline-secondary py-0 px-1 lh-1"
                  style={{ fontSize: 16 }}
                  disabled={fontSize <= MIN_FONT}
                  onClick={() => setFontSize(f => Math.max(MIN_FONT, f - 1))}
                  title="Decrease font size"
                >−</button>
                <span className="small text-muted" style={{ minWidth: 32, textAlign: 'center' }}>
                  {fontSize}px
                </span>
                <button
                  className="btn btn-sm btn-outline-secondary py-0 px-1 lh-1"
                  style={{ fontSize: 16 }}
                  disabled={fontSize >= MAX_FONT}
                  onClick={() => setFontSize(f => Math.min(MAX_FONT, f + 1))}
                  title="Increase font size"
                >+</button>
              </div>
            </div>
            <div className="card-body overflow-auto p-3" style={{ maxHeight: '78vh' }}>
              {!selectedPart && (
                <p className="text-muted small mb-0">Select a file to view its content.</p>
              )}
              {selectedPart && content === null && !loading && (
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
