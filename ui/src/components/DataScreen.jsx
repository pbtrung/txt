import React, {
  useState, useEffect, useCallback, useRef,
} from 'react';
import { decryptName, decryptPart } from '../crypto.js';
import {
  fetchTxts,
  fetchPartCount,
  fetchPartByOffset,
} from '../db.js';
import FileDropdown from './FileDropdown.jsx';
import PartFooter from './PartFooter.jsx';

export default function DataScreen({ masterKey, onDisconnect }) {
  const [txts, setTxts]               = useState([]);
  const [selectedTxt, setSelectedTxt] = useState(null);
  const [totalParts, setTotalParts]   = useState(0);
  const [currentPartNum, setCurrentPartNum] = useState(1);
  const [content, setContent]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [fontSize, setFontSize]       = useState(16);
  const loadedPartRef = useRef(null);

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
    if (lp && lp.txtId === txt.id && lp.partNum === clamped)
      return;
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

  const hasTxt   = !!selectedTxt;
  const hasParts = totalParts > 0;

  return (
    <div
      className={
        'container py-3 vault-container' +
        ' d-flex flex-column'
      }
      style={{ minHeight: '100vh' }}
    >

      {/* Top bar */}
      <div className={
        'd-flex align-items-center' +
        ' justify-content-between mb-3'
      }>
        <span className="fw-bold">Text Reader</span>
        <button
          className="btn btn-sm btn-outline-secondary"
          onClick={onDisconnect}
        >
          Disconnect
        </button>
      </div>

      {error && (
        <div
          className="alert alert-danger py-2 small mb-3"
          role="alert"
        >
          {error}
        </div>
      )}

      {/* Card fills remaining height */}
      <div
        className="card d-flex flex-column"
        style={{ flex: '1 1 0', minHeight: 0 }}
      >

        <div className="card-header py-2">
          <FileDropdown
            txts={txts}
            selectedTxt={selectedTxt}
            onSelect={selectTxt}
          />
        </div>

        <div
          className="card-body overflow-auto p-3"
          style={{ flex: '1 1 0', minHeight: 0 }}
        >
          {loading ? (
            <div className={
              'd-flex justify-content-center' +
              ' align-items-center py-4'
            }>
              <span
                className="spinner-border text-secondary"
              />
            </div>
          ) : !hasTxt ? (
            <p className="text-muted small mb-0">
              Select a file to view its content.
            </p>
          ) : content === null ? (
            <p className="text-muted small mb-0">
              Loading…
            </p>
          ) : (
            <pre className="mb-0" style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontSize,
              maxWidth: '65ch',
              fontFamily: "'Literata', serif",
            }}>
              {content}
            </pre>
          )}
        </div>

        <PartFooter
          hasTxt={hasTxt}
          hasParts={hasParts}
          currentPartNum={currentPartNum}
          totalParts={totalParts}
          onPartNumChange={setCurrentPartNum}
          onLoadPart={partNum => loadPart(selectedTxt, partNum)}
          fontSize={fontSize}
          setFontSize={setFontSize}
        />

      </div>
    </div>
  );
}
