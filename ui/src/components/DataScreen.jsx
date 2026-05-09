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
import BookmarkPanel from './BookmarkPanel.jsx';

export default function DataScreen({ masterKey, onDisconnect }) {
  const [txts, setTxts]               = useState([]);
  const [selectedTxt, setSelectedTxt] = useState(null);
  const [totalParts, setTotalParts]   = useState(0);
  const [currentPartNum, setCurrentPartNum] = useState(1);
  const [content, setContent]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [fontSize, setFontSize]       = useState(16);
  const [bookmarks, setBookmarks]     = useState(new Map());
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [pendingScrollLine, setPendingScrollLine] = useState(null);
  const loadedPartRef      = useRef(null);
  const lineRefs           = useRef({});
  const scrollContainerRef = useRef(null);

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

  function scrollLineToTop(idx) {
    const el = lineRefs.current[idx];
    const container = scrollContainerRef.current;
    if (!el || !container) return;
    const paddingTop = parseFloat(getComputedStyle(container).paddingTop) || 0;
    container.scrollTop += el.getBoundingClientRect().top
      - container.getBoundingClientRect().top
      - paddingTop;
  }

  useEffect(() => {
    if (pendingScrollLine === null || loading || content === null) return;
    scrollLineToTop(pendingScrollLine);
    setPendingScrollLine(null);
  }, [content, loading, pendingScrollLine]);

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
    setPendingScrollLine(null);
    setShowBookmarks(false);
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

  function bKey(txtId, partNum, lineIdx) {
    return `${txtId}:${partNum}:${lineIdx}`;
  }

  function toggleBookmark(lineIdx, preview) {
    const key = bKey(selectedTxt.id, currentPartNum, lineIdx);
    setBookmarks(prev => {
      const next = new Map(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.set(key, {
          key,
          txtId: selectedTxt.id,
          partNum: currentPartNum,
          lineIndex: lineIdx,
          preview,
        });
      }
      return next;
    });
  }

  function navigateToBookmark({ partNum, lineIndex }) {
    setShowBookmarks(false);
    if (partNum !== currentPartNum) {
      setPendingScrollLine(lineIndex);
      loadPart(selectedTxt, partNum);
    } else {
      scrollLineToTop(lineIndex);
    }
  }

  function removeBookmark(key) {
    setBookmarks(prev => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  const hasTxt   = !!selectedTxt;
  const hasParts = totalParts > 0;

  const fileBookmarkCount = selectedTxt
    ? [...bookmarks.values()].filter(b => b.txtId === selectedTxt.id).length
    : 0;

  return (
    <div
      className={
        'container py-3 vault-container' +
        ' d-flex flex-column'
      }
      style={{ minHeight: '100vh' }}
    >

      {/* Top bar */}
      <div
        className="d-flex align-items-center justify-content-between mb-3"
        style={{ position: 'relative' }}
      >
        <span className="fw-bold">Text Reader</span>
        <div className="d-flex align-items-center gap-2">
          <div>
            <button
              className={
                'btn btn-sm' +
                (showBookmarks
                  ? ' btn-secondary'
                  : ' btn-outline-secondary')
              }
              disabled={!hasTxt}
              onClick={() => setShowBookmarks(v => !v)}
            >
              Bookmarks
              {fileBookmarkCount > 0 && (
                <span className="ms-1 badge bg-primary rounded-pill" style={{ fontSize: '0.65rem' }}>
                  {fileBookmarkCount}
                </span>
              )}
            </button>
            {showBookmarks && (
              <>
                <div
                  style={{ position: 'fixed', inset: 0, zIndex: 199 }}
                  onClick={() => setShowBookmarks(false)}
                />
                <BookmarkPanel
                  bookmarks={bookmarks}
                  selectedTxt={selectedTxt}
                  onNavigate={navigateToBookmark}
                  onRemove={removeBookmark}
                />
              </>
            )}
          </div>
          <button
            className="btn btn-sm btn-outline-secondary"
            onClick={onDisconnect}
          >
            Disconnect
          </button>
        </div>
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
          ref={scrollContainerRef}
          className="overflow-auto"
          style={{ flex: '1 1 0', minHeight: 0, padding: '1rem 1rem 1rem 0' }}
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
            <p className="text-muted small mb-0" style={{ paddingLeft: '1rem' }}>
              Select a file to view its content.
            </p>
          ) : content === null ? (
            <p className="text-muted small mb-0">
              Loading…
            </p>
          ) : (
            <div style={{
              fontFamily: "'Literata', serif",
              fontSize,
              maxWidth: '70ch',
            }}>
              {content.split('\n').map((line, i) => {
                const key = bKey(selectedTxt.id, currentPartNum, i);
                const isBookmarked = bookmarks.has(key);
                return (
                  <div
                    key={i}
                    ref={el => { lineRefs.current[i] = el; }}
                    className={`reader-line${isBookmarked ? ' bookmarked-line' : ''}`}
                  >
                    <button
                      className="line-bar"
                      onClick={() => toggleBookmark(i, line.trim().slice(0, 60))}
                      title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
                    />
                    <span style={{
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      flex: 1,
                    }}>
                      {line || ' '}
                    </span>
                  </div>
                );
              })}
            </div>
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
