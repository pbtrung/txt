import React from 'react';

const panelStyle = {
  position: 'absolute',
  top: 'calc(100% + 4px)',
  right: 0,
  zIndex: 200,
  width: 'min(280px, 100%)',
  maxHeight: 360,
  overflowY: 'auto',
};

function selectedBookmarks(bookmarks, selectedTxt) {
  if (!selectedTxt) return [];
  return [...bookmarks.values()]
    .filter(bookmark => bookmark.txtId === selectedTxt.id)
    .sort((a, b) => a.partNum - b.partNum || a.lineIndex - b.lineIndex);
}

function PanelHeader() {
  return (
    <div className="card-header py-2 small fw-semibold" style={{ position: 'sticky', top: 0 }}>
      Bookmarks
    </div>
  );
}

function EmptyPanel() {
  return (
    <div className="card-body py-2 small text-muted">
      No bookmarks yet. Click the bar to the left of a line to add one.
    </div>
  );
}

function RemoveButton({ onClick }) {
  return (
    <button className="btn btn-sm btn-link text-muted p-0 flex-shrink-0" style={{ fontSize: '1rem', lineHeight: 1 }} title="Remove bookmark" onClick={onClick}>
      &times;
    </button>
  );
}

function BookmarkPreview({ bookmark }) {
  return (
    <div className="small text-truncate" style={{ fontSize: '0.8125rem' }}>
      {bookmark.preview || <em className="text-muted">empty line</em>}
    </div>
  );
}

function BookmarkItem({ bookmark, onNavigate, onRemove }) {
  const navigate = () => onNavigate({ partNum: bookmark.partNum, lineIndex: bookmark.lineIndex });
  const remove = e => { e.stopPropagation(); onRemove(bookmark.key); };
  return (
    <li className="list-group-item list-group-item-action d-flex align-items-start gap-2 py-2" style={{ cursor: 'pointer' }} onClick={navigate}>
      <div className="flex-grow-1 overflow-hidden">
        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Part {bookmark.partNum} &middot; Line {bookmark.lineIndex + 1}</div>
        <BookmarkPreview bookmark={bookmark} />
      </div>
      <RemoveButton onClick={remove} />
    </li>
  );
}

function BookmarkList({ items, onNavigate, onRemove }) {
  if (items.length === 0) return <EmptyPanel />;
  return (
    <ul className="list-group list-group-flush">
      {items.map(bookmark => <BookmarkItem key={bookmark.key} bookmark={bookmark} onNavigate={onNavigate} onRemove={onRemove} />)}
    </ul>
  );
}

export default function BookmarkPanel(props) {
  const items = selectedBookmarks(props.bookmarks, props.selectedTxt);
  return (
    <div className="card shadow border" style={panelStyle}>
      <PanelHeader />
      <BookmarkList items={items} onNavigate={props.onNavigate} onRemove={props.onRemove} />
    </div>
  );
}
