import React, {
  useState, useEffect, useCallback, useRef,
} from 'react';
import { decryptName, decryptPart, encryptBookmark, decryptBookmark } from '../crypto.js';
import {
  fetchTxts,
  fetchPartCount,
  fetchPartByNum,
  fetchBookmarks,
  insertBookmark,
  deleteBookmark,
  fetchRecentAccess,
  fetchRecentBookmarks,
  upsertAccess,
} from '../db.js';
import FileDropdown from './FileDropdown.jsx';
import PartFooter from './PartFooter.jsx';
import TopBar from './TopBar.jsx';
import LandingView from './LandingView.jsx';
import BookmarkChooser from './BookmarkChooser.jsx';
import ReaderView from './ReaderView.jsx';

const BOOKMARK_LIMIT = 12;

function decodeBookmarks(bmarks, txtId, masterKey) {
  const bMap = new Map();
  for (const b of bmarks) {
    let obj;
    try { obj = decryptBookmark(b.bookmark, masterKey); } catch { continue; }
    const key = `${obj.part_num}:${obj.line}`;
    bMap.set(key, { key, dbId: b.id, txtId, partNum: obj.part_num, lineIndex: obj.line, preview: obj.txt_preview ?? '' });
  }
  return bMap;
}

function addBookmarkToMap(prev, entry) {
  const n = new Map(prev);
  if (n.size >= BOOKMARK_LIMIT) {
    const oldest = [...n.values()].reduce((a, b) => a.dbId < b.dbId ? a : b);
    n.delete(oldest.key);
  }
  n.set(entry.key, entry);
  return n;
}

export default function DataScreen({ masterKey, onDisconnect }) {
  const [txts, setTxts]               = useState([]);
  const [selectedTxt, setSelectedTxt] = useState(null);
  const [totalParts, setTotalParts]   = useState(0);
  const [currentPartNum, setCurrentPartNum] = useState(1);
  const [content, setContent]         = useState(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [fontSize, setFontSize]       = useState(16);
  const [recentAccess, setRecentAccess]       = useState([]);
  const [recentBookmarks, setRecentBookmarks] = useState([]);
  const [bookmarks, setBookmarks]             = useState(new Map());
  const [showBookmarks, setShowBookmarks]     = useState(false);
  const [showBookmarkChooser, setShowBookmarkChooser] = useState(false);
  const [pendingScrollLine, setPendingScrollLine]     = useState(null);
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
      const [rows, recent, rawBmarks] = await Promise.all([
        fetchTxts(), fetchRecentAccess(), fetchRecentBookmarks(),
      ]);
      const decrypted = rows.map(r => {
        let name;
        try { name = decryptName(r.name, masterKey); }
        catch { name = `<id ${r.id}>`; }
        return { id: r.id, name };
      });
      setTxts(decrypted);
      const nameMap = new Map(decrypted.map(t => [t.id, t.name]));
      setRecentAccess(recent
        .filter(r => nameMap.has(r.txt_id))
        .map(r => ({
          txtId: r.txt_id,
          name: nameMap.get(r.txt_id),
          lastPartNum: r.last_part_num,
        }))
      );
      const decoded = [];
      for (const b of rawBmarks) {
        if (!nameMap.has(b.txt_id)) continue;
        let obj;
        try { obj = decryptBookmark(b.bookmark, masterKey); } catch { continue; }
        decoded.push({
          dbId: b.id,
          txtId: b.txt_id,
          txtName: nameMap.get(b.txt_id),
          partNum: obj.part_num,
          lineIndex: obj.line,
          preview: obj.txt_preview ?? '',
        });
      }
      setRecentBookmarks(decoded);
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

  function resetForTxt(txt) {
    setSelectedTxt(txt); setCurrentPartNum(1); setTotalParts(0);
    setContent(null); setPendingScrollLine(null);
    setShowBookmarks(false); setShowBookmarkChooser(false);
    setBookmarks(new Map()); loadedPartRef.current = null;
  }

  async function loadFirstPart(txt, initialPartNum, total) {
    const clamped = Math.max(1, Math.min(initialPartNum, total));
    loadedPartRef.current = { txtId: txt.id, partNum: clamped };
    setCurrentPartNum(clamped);
    const part = await fetchPartByNum(txt.id, clamped);
    setContent(part ? decryptPart(part.content, masterKey) : '');
    if (part) upsertAccess(txt.id, clamped);
  }

  async function loadPart(txt, partNum, total = totalParts) {
    const clamped = Math.max(1, Math.min(partNum, total || 1));
    const lp = loadedPartRef.current;
    if (lp && lp.txtId === txt.id && lp.partNum === clamped) return;
    loadedPartRef.current = { txtId: txt.id, partNum: clamped };
    setCurrentPartNum(clamped);
    setContent(null);
    wrap(async () => {
      const part = await fetchPartByNum(txt.id, clamped);
      setContent(part ? decryptPart(part.content, masterKey) : '');
      if (part) upsertAccess(txt.id, clamped);
    });
  }

  async function selectTxt(txt, initialPartNum = 1, jumpTo = null) {
    resetForTxt(txt);
    wrap(async () => {
      const [total, bmarks] = await Promise.all([
        fetchPartCount(txt.id), fetchBookmarks(txt.id),
      ]);
      setTotalParts(total);
      const bMap = decodeBookmarks(bmarks, txt.id, masterKey);
      setBookmarks(bMap);
      if (jumpTo) {
        if (total > 0) {
          setPendingScrollLine(jumpTo.lineIndex);
          await loadFirstPart(txt, jumpTo.partNum, total);
        }
        return;
      }
      if (bMap.size > 0) { setShowBookmarkChooser(true); return; }
      if (total > 0) await loadFirstPart(txt, initialPartNum, total);
    });
  }

  async function toggleBookmark(lineIdx, previewText) {
    if (!selectedTxt) return;
    const key = `${currentPartNum}:${lineIdx}`;
    try {
      if (bookmarks.has(key)) {
        await deleteBookmark(bookmarks.get(key).dbId);
        setBookmarks(prev => { const n = new Map(prev); n.delete(key); return n; });
      } else {
        const obj = { part_num: currentPartNum, line: lineIdx, txt_preview: previewText ?? '' };
        const dbId = await insertBookmark(selectedTxt.id, encryptBookmark(obj, masterKey));
        const entry = { key, dbId, txtId: selectedTxt.id, partNum: currentPartNum, lineIndex: lineIdx, preview: previewText ?? '' };
        setBookmarks(prev => addBookmarkToMap(prev, entry));
      }
    } catch (e) { setError(e.message); }
  }

  function navigateToBookmark({ partNum, lineIndex }) {
    setShowBookmarks(false);
    setShowBookmarkChooser(false);
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

  return (
    <div className="container py-3 vault-container d-flex flex-column" style={{ minHeight: '100vh' }}>

      <TopBar
        hasTxt={hasTxt}
        showBookmarks={showBookmarks}
        setShowBookmarks={setShowBookmarks}
        bookmarks={bookmarks}
        selectedTxt={selectedTxt}
        onNavigate={navigateToBookmark}
        onRemove={removeBookmark}
        onHome={() => resetForTxt(null)}
        onDisconnect={onDisconnect}
      />

      {error && (
        <div className="alert alert-danger py-2 small mb-3" role="alert">
          {error}
        </div>
      )}

      <div className="card d-flex flex-column" style={{ flex: '1 1 0', minHeight: 0 }}>

        <div className="card-header py-2">
          <FileDropdown txts={txts} selectedTxt={selectedTxt} onSelect={selectTxt} />
        </div>

        <div
          ref={scrollContainerRef}
          className="overflow-auto"
          style={{ flex: '1 1 0', minHeight: 0, padding: '1rem 1rem 1rem 0' }}
        >
          {loading ? (
            <div className="d-flex justify-content-center align-items-center py-4">
              <span className="spinner-border text-secondary" />
            </div>
          ) : !hasTxt ? (
            <LandingView
              recentAccess={recentAccess}
              recentBookmarks={recentBookmarks}
              onSelectTxt={selectTxt}
            />
          ) : showBookmarkChooser ? (
            <BookmarkChooser
              bookmarks={bookmarks}
              onNavigate={navigateToBookmark}
              onRemove={removeBookmark}
            />
          ) : content === null ? (
            <p className="text-muted small mb-0" style={{ paddingLeft: '1rem' }}>Loading…</p>
          ) : (
            <ReaderView
              content={content}
              currentPartNum={currentPartNum}
              bookmarks={bookmarks}
              lineRefs={lineRefs}
              onToggleBookmark={toggleBookmark}
              fontSize={fontSize}
            />
          )}
        </div>

        <PartFooter
          hasTxt={hasTxt}
          hasParts={hasParts}
          currentPartNum={showBookmarkChooser ? 0 : currentPartNum}
          totalParts={totalParts}
          onPartNumChange={setCurrentPartNum}
          onLoadPart={partNum => { setShowBookmarkChooser(false); loadPart(selectedTxt, partNum); }}
          fontSize={fontSize}
          setFontSize={setFontSize}
        />

      </div>
    </div>
  );
}
