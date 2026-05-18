import React from 'react';

function sortedBookmarks(bookmarks) {
  return [...bookmarks.values()]
    .sort((a, b) => a.partNum - b.partNum || a.lineIndex - b.lineIndex);
}

function ChooserPrompt({ empty }) {
  return empty
    ? <p className="text-muted small mb-0">No bookmarks left. Use the part controls below to navigate.</p>
    : <p className="text-muted small mb-2">Pick up where you left off:</p>;
}

function BookmarkPreview({ bookmark }) {
  return (
    <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {bookmark.preview ? `${bookmark.preview}…` : <em className="text-muted">empty line</em>}
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

function BookmarkItem({ bookmark, onNavigate, onRemove }) {
  const navigate = () => onNavigate({ partNum: bookmark.partNum, lineIndex: bookmark.lineIndex });
  const remove = e => { e.stopPropagation(); onRemove(bookmark.key); };
  return (
    <li className="list-group-item list-group-item-action py-2 px-2 d-flex align-items-start gap-2" style={{ cursor: 'pointer' }} onClick={navigate}>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Part {bookmark.partNum} &middot; Line {bookmark.lineIndex + 1}</div>
        <BookmarkPreview bookmark={bookmark} />
      </div>
      <RemoveButton onClick={remove} />
    </li>
  );
}

function BookmarkList({ items, onNavigate, onRemove }) {
  return (
    <ul className="list-group list-group-flush mb-3">
      {items.map(bookmark => <BookmarkItem key={bookmark.key} bookmark={bookmark} onNavigate={onNavigate} onRemove={onRemove} />)}
    </ul>
  );
}

export default function BookmarkChooser({ bookmarks, onNavigate, onRemove }) {
  const items = sortedBookmarks(bookmarks);
  return (
    <div style={{ paddingLeft: '1rem' }}>
      <ChooserPrompt empty={bookmarks.size === 0} />
      <BookmarkList items={items} onNavigate={onNavigate} onRemove={onRemove} />
    </div>
  );
}
