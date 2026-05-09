import React, {
  useState, useEffect, useCallback, useRef,
} from 'react';
import { decryptName, decryptPart } from '../crypto.js';
import {
  fetchTxts,
  fetchPartCount,
  fetchPartByOffset,
  fetchBookmarks,
  insertBookmark,
  deleteBookmark,
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
  const [bookmarks, setBookmarks]         = useState(new Map());
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [pendingScrollLine, setPendingScrollLine] = useState(null);
  const [currentTxtPartId, setCurrentTxtPartId] = useState(null);
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

  function applyPreviews(bMap, partId, content) {
    const lines = content.split('\n');
    let changed = false;
    const next = new Map(bMap);
    for (const [key, bm] of next) {
      if (bm.txtPartId === partId && !bm.preview) {
        const preview = lines[bm.lineIndex]?.trim().slice(0, 60) ?? '';
        if (preview) { next.set(key, { ...bm, preview }); changed = true; }
      }
    }
    return changed ? next : bMap;
  }

  async function loadPart(txt, partNum, total = totalParts) {
    const clamped = Math.max(1, Math.min(partNum, total || 1));
    const lp = loadedPartRef.current;
    if (lp && lp.txtId === txt.id && lp.partNum === clamped)
      return;
    loadedPartRef.current = { txtId: txt.id, partNum: clamped };
    setCurrentPartNum(clamped);
    setContent(null);
    setCurrentTxtPartId(null);
    wrap(async () => {
      const part = await fetchPartByOffset(txt.id, clamped - 1);
      const decrypted = part ? decryptPart(part.content, masterKey) : '';
      setCurrentTxtPartId(part?.id ?? null);
      setContent(decrypted);
      if (part?.id && decrypted)
        setBookmarks(prev => applyPreviews(prev, part.id, decrypted));
    });
  }

  async function selectTxt(txt) {
    setSelectedTxt(txt);
    setCurrentPartNum(1);
    setTotalParts(0);
    setContent(null);
    setCurrentTxtPartId(null);
    setPendingScrollLine(null);
    setShowBookmarks(false);
    setBookmarks(new Map());
    loadedPartRef.current = null;
    wrap(async () => {
      const [total, bmarks] = await Promise.all([
        fetchPartCount(txt.id),
        fetchBookmarks(txt.id),
      ]);
      setTotalParts(total);
      const bMap = new Map();
      for (const b of bmarks) {
        const key = `${b.txt_part_id}:${b.line}`;
        bMap.set(key, {
          key, dbId: b.id, txtId: txt.id,
          txtPartId: b.txt_part_id, partNum: b.part_num,
          lineIndex: b.line, preview: '',
        });
      }
      if (total > 0) {
        loadedPartRef.current = { txtId: txt.id, partNum: 1 };
        const part = await fetchPartByOffset(txt.id, 0);
        const decrypted = part ? decryptPart(part.content, masterKey) : '';
        setCurrentTxtPartId(part?.id ?? null);
        setContent(decrypted);
        setBookmarks(
          part?.id && decrypted ? applyPreviews(bMap, part.id, decrypted) : bMap
        );
      } else {
        setBookmarks(bMap);
      }
    });
  }

  async function toggleBookmark(lineIdx, preview) {
    if (!currentTxtPartId) return;
    const key = `${currentTxtPartId}:${lineIdx}`;
    if (bookmarks.has(key)) {
      const { dbId } = bookmarks.get(key);
      try {
        await deleteBookmark(dbId);
        setBookmarks(prev => { const n = new Map(prev); n.delete(key); return n; });
      } catch (e) { setError(e.message); }
    } else {
      try {
        const dbId = await insertBookmark(currentTxtPartId, currentPartNum, lineIdx);
        setBookmarks(prev => {
          const n = new Map(prev);
          n.set(key, {
            key, dbId,
            txtId: selectedTxt.id,
            txtPartId: currentTxtPartId,
            partNum: currentPartNum,
            lineIndex: lineIdx,
            preview,
          });
          return n;
        });
      } catch (e) { setError(e.message); }
    }
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

  async function removeBookmark(key) {
    const bm = bookmarks.get(key);
    if (!bm) return;
    try {
      await deleteBookmark(bm.dbId);
      setBookmarks(prev => { const n = new Map(prev); n.delete(key); return n; });
    } catch (e) { setError(e.message); }
  }

  const hasTxt   = !!selectedTxt;
  const hasParts = totalParts > 0;

  const fileBookmarkCount = bookmarks.size;

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
                const key = `${currentTxtPartId}:${i}`;
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
