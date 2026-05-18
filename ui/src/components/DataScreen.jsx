import React, {
  useState, useEffect, useCallback, useMemo, useRef,
} from 'react';
import { decryptName, decryptPart, encryptBookmark, decryptBookmark } from '../crypto.js';
import {
  fetchTxts, fetchPartCount, fetchPartByNum, fetchBookmarks,
  insertBookmark, deleteBookmark, fetchRecentAccess, fetchRecentBookmarks,
  upsertAccess, deleteAccess,
} from '../db.js';
import FileDropdown from './FileDropdown.jsx';
import PartFooter from './PartFooter.jsx';
import TopBar from './TopBar.jsx';
import LandingView from './LandingView.jsx';
import BookmarkChooser from './BookmarkChooser.jsx';
import ReaderView from './ReaderView.jsx';

const BOOKMARK_LIMIT = 12;

const INITIAL_STATE = {
  txts: [], selectedTxt: null, totalParts: 0, currentPartNum: 1,
  content: null, loading: false, error: null, fontSize: 16,
  recentAccess: [], recentBookmarks: [], refreshLanding: 0,
  bookmarks: new Map(), showBookmarks: false,
  showBookmarkChooser: false, pendingScrollLine: null,
};

function resolvePatch(update, prev) {
  return typeof update === 'function' ? update(prev) : update;
}

function usePatchState(initialState) {
  const [state, setState] = useState(initialState);
  const patch = useCallback(update => {
    setState(prev => ({ ...prev, ...resolvePatch(update, prev) }));
  }, []);
  return [state, patch];
}

function useScreenRefs() {
  const loadedPartRef = useRef(null);
  const lineRefs = useRef({});
  const scrollContainerRef = useRef(null);
  const kbRef = useRef({});
  const fnRef = useRef({});
  return useMemo(() => ({
    loadedPartRef, lineRefs, scrollContainerRef, kbRef, fnRef,
  }), []);
}

function useWrap(patch) {
  return useCallback(async fn => {
    patch({ loading: true, error: null });
    try { await fn(); } catch (e) { patch({ error: e.message }); }
    patch({ loading: false });
  }, [patch]);
}

function decryptTxtRow(row, masterKey) {
  try {
    return { id: row.id, name: decryptName(row.name, masterKey) };
  } catch {
    return { id: row.id, name: `<id ${row.id}>` };
  }
}

function decryptTxtRows(rows, masterKey) {
  return rows.map(row => decryptTxtRow(row, masterKey));
}

function toNameMap(txts) {
  return new Map(txts.map(txt => [txt.id, txt.name]));
}

function toRecentAccessRow(row, nameMap) {
  return {
    txtId: row.txt_id,
    name: nameMap.get(row.txt_id),
    lastPartNum: row.last_part_num,
  };
}

function formatRecentAccess(recent, nameMap) {
  return recent
    .filter(row => nameMap.has(row.txt_id))
    .map(row => toRecentAccessRow(row, nameMap));
}

function decodeRecentBookmark(row, nameMap, masterKey) {
  if (!nameMap.has(row.txt_id)) return null;
  try {
    const obj = decryptBookmark(row.bookmark, masterKey);
    return makeRecentBookmark(row, obj, nameMap);
  } catch {
    return null;
  }
}

function makeRecentBookmark(row, obj, nameMap) {
  return {
    dbId: row.id, txtId: row.txt_id, txtName: nameMap.get(row.txt_id),
    partNum: obj.part_num, lineIndex: obj.line,
    preview: obj.txt_preview ?? '',
  };
}

function decodeRecentBookmarks(raw, nameMap, masterKey) {
  return raw
    .map(row => decodeRecentBookmark(row, nameMap, masterKey))
    .filter(Boolean);
}

async function loadLanding(patch, masterKey) {
  const [rows, recent, rawBmarks] = await Promise.all([
    fetchTxts(), fetchRecentAccess(), fetchRecentBookmarks(),
  ]);
  const txts = decryptTxtRows(rows, masterKey);
  const nameMap = toNameMap(txts);
  patch({
    txts, recentAccess: formatRecentAccess(recent, nameMap),
    recentBookmarks: decodeRecentBookmarks(rawBmarks, nameMap, masterKey),
  });
}

function useLandingData(refreshLanding, patch, wrap, masterKey) {
  useEffect(() => {
    wrap(() => loadLanding(patch, masterKey));
  }, [masterKey, patch, refreshLanding, wrap]);
}

function bookmarkKey(partNum, lineIndex) {
  return `${partNum}:${lineIndex}`;
}

function makeBookmarkEntry(obj, dbId, txtId) {
  const key = bookmarkKey(obj.part_num, obj.line);
  return {
    key, dbId, txtId,
    partNum: obj.part_num,
    lineIndex: obj.line,
    preview: obj.txt_preview ?? '',
  };
}

function decodeBookmarkEntry(row, txtId, masterKey) {
  try {
    const obj = decryptBookmark(row.bookmark, masterKey);
    return [bookmarkKey(obj.part_num, obj.line), makeBookmarkEntry(obj, row.id, txtId)];
  } catch {
    return null;
  }
}

function decodeBookmarks(rows, txtId, masterKey) {
  return new Map(
    rows.map(row => decodeBookmarkEntry(row, txtId, masterKey)).filter(Boolean),
  );
}

function addBookmarkToMap(prev, entry) {
  const next = new Map(prev);
  if (next.size >= BOOKMARK_LIMIT) {
    const oldest = [...next.values()].reduce((a, b) => a.dbId < b.dbId ? a : b);
    next.delete(oldest.key);
  }
  next.set(entry.key, entry);
  return next;
}

function removeBookmarkFromMap(prev, key) {
  const next = new Map(prev);
  next.delete(key);
  return next;
}

function clampPart(partNum, total) {
  return Math.max(1, Math.min(partNum, total || 1));
}

function setLoadedPart(refs, txt, partNum) {
  refs.loadedPartRef.current = { txtId: txt.id, partNum };
}

function isLoadedPart(refs, txt, partNum) {
  const loaded = refs.loadedPartRef.current;
  return loaded && loaded.txtId === txt.id && loaded.partNum === partNum;
}

async function fetchPartContent(txt, partNum, masterKey) {
  const part = await fetchPartByNum(txt.id, partNum);
  if (part) upsertAccess(txt.id, partNum);
  return part ? decryptPart(part.content, masterKey) : '';
}

async function loadFirstPart(ctx, txt, initialPartNum, total) {
  const partNum = clampPart(initialPartNum, total);
  setLoadedPart(ctx.refs, txt, partNum);
  ctx.patch({ currentPartNum: partNum });
  const content = await fetchPartContent(txt, partNum, ctx.masterKey);
  ctx.patch({ content });
}

function loadPart(ctx, txt, partNum, total = ctx.state.totalParts) {
  if (!txt) return;
  const clamped = clampPart(partNum, total);
  if (isLoadedPart(ctx.refs, txt, clamped)) return;
  setLoadedPart(ctx.refs, txt, clamped);
  ctx.patch({ currentPartNum: clamped, content: null });
  ctx.wrap(async () => {
    const content = await fetchPartContent(txt, clamped, ctx.masterKey);
    ctx.patch({ content });
  });
}

function resetForTxt(ctx, txt) {
  ctx.refs.loadedPartRef.current = null;
  ctx.patch({
    selectedTxt: txt, currentPartNum: 1, totalParts: 0, content: null,
    pendingScrollLine: null, showBookmarks: false,
    showBookmarkChooser: false, bookmarks: new Map(),
  });
}

async function selectTxtData(ctx, txt, initialPartNum, jumpTo) {
  const [total, rows] = await Promise.all([
    fetchPartCount(txt.id), fetchBookmarks(txt.id),
  ]);
  const bookmarks = decodeBookmarks(rows, txt.id, ctx.masterKey);
  ctx.patch({ totalParts: total, bookmarks });
  if (jumpTo) return jumpToPart(ctx, txt, total, jumpTo);
  if (bookmarks.size > 0) return ctx.patch({ showBookmarkChooser: true });
  if (total > 0) await loadFirstPart(ctx, txt, initialPartNum, total);
}

function selectTxt(ctx, txt, initialPartNum = 1, jumpTo = null) {
  resetForTxt(ctx, txt);
  ctx.wrap(() => selectTxtData(ctx, txt, initialPartNum, jumpTo));
}

async function jumpToPart(ctx, txt, total, jumpTo) {
  if (total <= 0) return;
  ctx.patch({ pendingScrollLine: jumpTo.lineIndex });
  await loadFirstPart(ctx, txt, jumpTo.partNum, total);
}

async function runWithError(ctx, fn) {
  try { await fn(); }
  catch (e) { ctx.patch({ error: e.message }); }
}

async function toggleBookmark(ctx, lineIdx, previewText) {
  if (!ctx.state.selectedTxt) return;
  await runWithError(ctx, () => toggleBookmarkUnsafe(ctx, lineIdx, previewText));
}

async function toggleBookmarkUnsafe(ctx, lineIdx, previewText) {
  const key = bookmarkKey(ctx.state.currentPartNum, lineIdx);
  if (ctx.state.bookmarks.has(key))
    return removeBookmarkKey(ctx, key);
  await addBookmarkKey(ctx, key, lineIdx, previewText);
}

async function removeBookmarkKey(ctx, key) {
  await deleteBookmark(ctx.state.bookmarks.get(key).dbId);
  ctx.patch(prev => ({ bookmarks: removeBookmarkFromMap(prev.bookmarks, key) }));
}

async function addBookmarkKey(ctx, key, lineIdx, previewText) {
  const obj = {
    part_num: ctx.state.currentPartNum,
    line: lineIdx,
    txt_preview: previewText ?? '',
  };
  const blob = encryptBookmark(obj, ctx.masterKey);
  const dbId = await insertBookmark(ctx.state.selectedTxt.id, blob);
  const entry = makeBookmarkEntry(obj, dbId, ctx.state.selectedTxt.id);
  ctx.patch(prev => ({ bookmarks: addBookmarkToMap(prev.bookmarks, { ...entry, key }) }));
}

function navigateToBookmark(ctx, { partNum, lineIndex }) {
  ctx.patch({ showBookmarks: false, showBookmarkChooser: false });
  if (partNum === ctx.state.currentPartNum)
    return scrollLineToTop(ctx.refs, lineIndex);
  ctx.patch({ pendingScrollLine: lineIndex });
  loadPart(ctx, ctx.state.selectedTxt, partNum);
}

async function refreshRecentAccess(ctx) {
  const nameMap = toNameMap(ctx.state.txts);
  const recent = await fetchRecentAccess();
  ctx.patch({ recentAccess: formatRecentAccess(recent, nameMap) });
}

async function removeRecentAccess(ctx, txtId) {
  await runWithError(ctx, async () => {
    await deleteAccess(txtId);
    await refreshRecentAccess(ctx);
  });
}

async function refreshRecentBookmarks(ctx) {
  const nameMap = toNameMap(ctx.state.txts);
  const raw = await fetchRecentBookmarks();
  const recentBookmarks = decodeRecentBookmarks(raw, nameMap, ctx.masterKey);
  ctx.patch({ recentBookmarks });
}

async function removeRecentBookmark(ctx, dbId) {
  await runWithError(ctx, async () => {
    await deleteBookmark(dbId);
    await refreshRecentBookmarks(ctx);
  });
}

async function removeBookmark(ctx, key) {
  if (!ctx.state.bookmarks.has(key)) return;
  await runWithError(ctx, () => removeBookmarkKey(ctx, key));
}

function handleHome(ctx) {
  resetForTxt(ctx, null);
  ctx.patch(prev => ({ refreshLanding: prev.refreshLanding + 1 }));
}

function loadFooterPart(ctx, partNum) {
  ctx.patch({ showBookmarkChooser: false });
  loadPart(ctx, ctx.state.selectedTxt, partNum);
}

function resolveUpdate(value, current) {
  return typeof value === 'function' ? value(current) : value;
}

function patchKey(ctx, key, value) {
  ctx.patch(prev => ({ [key]: resolveUpdate(value, prev[key]) }));
}

function navigationActions(ctx) {
  return {
    selectTxt: (...args) => selectTxt(ctx, ...args),
    loadPart: (...args) => loadPart(ctx, ...args),
    navigateToBookmark: mark => navigateToBookmark(ctx, mark),
    handleHome: () => handleHome(ctx),
    loadFooterPart: partNum => loadFooterPart(ctx, partNum),
  };
}

function bookmarkActions(ctx) {
  return {
    toggleBookmark: (...args) => toggleBookmark(ctx, ...args),
    removeRecentAccess: id => removeRecentAccess(ctx, id),
    removeRecentBookmark: id => removeRecentBookmark(ctx, id),
    removeBookmark: key => removeBookmark(ctx, key),
  };
}

function setterActions(ctx) {
  return {
    setShowBookmarks: value => patchKey(ctx, 'showBookmarks', value),
    setCurrentPartNum: value => patchKey(ctx, 'currentPartNum', value),
    setFontSize: value => patchKey(ctx, 'fontSize', value),
  };
}

function useActions(ctx) {
  return {
    ...navigationActions(ctx),
    ...bookmarkActions(ctx),
    ...setterActions(ctx),
  };
}

function containerTop(container) {
  return container.getBoundingClientRect().top
    + (parseFloat(getComputedStyle(container).paddingTop) || 0);
}

function scrollLineToTop(refs, idx) {
  const el = refs.lineRefs.current[idx];
  const container = refs.scrollContainerRef.current;
  if (!el || !container) return;
  const top = containerTop(container);
  container.scrollTop += el.getBoundingClientRect().top - top;
}

function visibleLineScore(entry, top) {
  const [idx, el] = entry;
  if (!el) return null;
  return { idx: parseInt(idx, 10), dist: Math.abs(el.getBoundingClientRect().top - top) };
}

function closerLine(best, score) {
  if (!score) return best;
  return score.dist < best.dist ? score : best;
}

function getFirstVisibleLineIndex(refs) {
  const container = refs.scrollContainerRef.current;
  if (!container) return null;
  const scores = Object.entries(refs.lineRefs.current);
  return scores
    .map(entry => visibleLineScore(entry, containerTop(container)))
    .reduce(closerLine, { idx: null, dist: Infinity }).idx;
}

function usePendingScroll(state, patch, refs) {
  useEffect(() => {
    if (state.pendingScrollLine === null || state.loading || state.content === null) return;
    scrollLineToTop(refs, state.pendingScrollLine);
    patch({ pendingScrollLine: null });
  }, [state.content, state.loading, state.pendingScrollLine, patch, refs]);
}

function handleArrow(e, state, actions) {
  if (e.key === 'ArrowLeft' && state.currentPartNum > 1) {
    e.preventDefault();
    actions.loadPart(state.selectedTxt, state.currentPartNum - 1, state.totalParts);
  } else if (e.key === 'ArrowRight' && state.currentPartNum < state.totalParts) {
    e.preventDefault();
    actions.loadPart(state.selectedTxt, state.currentPartNum + 1, state.totalParts);
  }
}

function handleBookmarkKey(refs, actions) {
  const idx = getFirstVisibleLineIndex(refs);
  if (idx === null) return;
  const preview = refs.lineRefs.current[idx]?.textContent?.trim().slice(0, 60) ?? '';
  actions.toggleBookmark(idx, preview);
}

function ignoreKey(e, state) {
  if (!state.hasTxt || !state.hasParts || state.showBookmarkChooser) return true;
  if (state.content === null) return true;
  return e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
}

function handleKey(e, refs) {
  const state = refs.kbRef.current;
  const actions = refs.fnRef.current;
  if (ignoreKey(e, state)) return;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    handleArrow(e, state, actions);
  else if (e.key === 'b')
    handleBookmarkKey(refs, actions);
}

function useKeyboardNavigation(refs) {
  useEffect(() => {
    const onKey = e => handleKey(e, refs);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [refs]);
}

function getStatus(state) {
  return { hasTxt: !!state.selectedTxt, hasParts: state.totalParts > 0 };
}

function syncRuntimeRefs(state, refs, actions) {
  const status = getStatus(state);
  refs.kbRef.current = { ...status, ...state };
  refs.fnRef.current = actions;
  return status;
}

function useScreenModel(masterKey, onDisconnect) {
  const [state, patch] = usePatchState(INITIAL_STATE);
  const refs = useScreenRefs();
  const wrap = useWrap(patch);
  const ctx = { state, patch, refs, wrap, masterKey };
  const actions = useActions(ctx);
  const status = syncRuntimeRefs(state, refs, actions);
  useLandingData(state.refreshLanding, patch, wrap, masterKey);
  usePendingScroll(state, patch, refs);
  useKeyboardNavigation(refs);
  return { state, refs, actions, status, onDisconnect };
}

function topBarProps(model) {
  return {
    hasTxt: model.status.hasTxt,
    showBookmarks: model.state.showBookmarks,
    setShowBookmarks: model.actions.setShowBookmarks,
    bookmarks: model.state.bookmarks,
    selectedTxt: model.state.selectedTxt,
    onNavigate: model.actions.navigateToBookmark,
    onRemove: model.actions.removeBookmark,
    onHome: model.actions.handleHome,
    onDisconnect: model.onDisconnect,
  };
}

function ScreenTop({ model }) {
  return <TopBar {...topBarProps(model)} />;
}

function ErrorAlert({ error }) {
  return error
    ? <div className="alert alert-danger py-2 small mb-3" role="alert">{error}</div>
    : null;
}

function FileHeader({ model }) {
  return (
    <div className="card-header py-2">
      <FileDropdown txts={model.state.txts} selectedTxt={model.state.selectedTxt} onSelect={model.actions.selectTxt} />
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="d-flex justify-content-center align-items-center py-4">
      <span className="spinner-border text-secondary" />
    </div>
  );
}

function LoadingText() {
  return <p className="text-muted small mb-0" style={{ paddingLeft: '1rem' }}>Loading…</p>;
}

function LandingContent({ model }) {
  return (
    <LandingView
      recentAccess={model.state.recentAccess}
      recentBookmarks={model.state.recentBookmarks}
      onSelectTxt={model.actions.selectTxt}
      onRemoveAccess={model.actions.removeRecentAccess}
      onRemoveBookmark={model.actions.removeRecentBookmark}
    />
  );
}

function ContentView({ model }) {
  const { state, status, actions } = model;
  if (state.loading) return <LoadingSpinner />;
  if (!status.hasTxt) return <LandingContent model={model} />;
  if (state.showBookmarkChooser)
    return <BookmarkChooser bookmarks={state.bookmarks} onNavigate={actions.navigateToBookmark} onRemove={actions.removeBookmark} />;
  if (state.content === null) return <LoadingText />;
  return <ReaderContent model={model} />;
}

function ReaderContent({ model }) {
  return (
    <ReaderView
      content={model.state.content}
      currentPartNum={model.state.currentPartNum}
      bookmarks={model.state.bookmarks}
      lineRefs={model.refs.lineRefs}
      onToggleBookmark={model.actions.toggleBookmark}
      fontSize={model.state.fontSize}
    />
  );
}

function ScrollPane({ model }) {
  const style = { flex: '1 1 0', minHeight: 0, padding: '1rem 1rem 1rem 0' };
  return (
    <div ref={model.refs.scrollContainerRef} className="overflow-auto" style={style}>
      <ContentView model={model} />
    </div>
  );
}

function Footer({ model }) {
  const { state, status, actions } = model;
  return (
    <PartFooter
      hasTxt={status.hasTxt} hasParts={status.hasParts}
      currentPartNum={state.showBookmarkChooser ? 0 : state.currentPartNum}
      totalParts={state.totalParts} onPartNumChange={actions.setCurrentPartNum}
      onLoadPart={actions.loadFooterPart}
      fontSize={state.fontSize} setFontSize={actions.setFontSize}
    />
  );
}

function ReaderCard({ model }) {
  const style = { flex: '1 1 0', minHeight: 0 };
  return (
    <div className="card d-flex flex-column" style={style}>
      <FileHeader model={model} />
      <ScrollPane model={model} />
      <Footer model={model} />
    </div>
  );
}

function DataScreenView({ model }) {
  const style = { minHeight: '100vh' };
  return (
    <div className="container py-3 vault-container d-flex flex-column" style={style}>
      <ScreenTop model={model} />
      <ErrorAlert error={model.state.error} />
      <ReaderCard model={model} />
    </div>
  );
}

export default function DataScreen({ masterKey, onDisconnect }) {
  const model = useScreenModel(masterKey, onDisconnect);
  return <DataScreenView model={model} />;
}
