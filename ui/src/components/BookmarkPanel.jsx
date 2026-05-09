import React from 'react';

export default function BookmarkPanel({
  bookmarks, selectedTxt, onNavigate, onRemove,
}) {
  const items = selectedTxt
    ? [...bookmarks.values()]
        .filter(b => b.txtId === selectedTxt.id)
        .sort((a, b) => a.partNum - b.partNum || a.lineIndex - b.lineIndex)
    : [];

  return (
    <div
      className="card shadow border"
      style={{
        position: 'absolute',
        top: 'calc(100% + 4px)',
        right: 0,
        zIndex: 200,
        width: 'min(280px, 100%)',
        maxHeight: 360,
        overflowY: 'auto',
      }}
    >
      <div
        className="card-header py-2 small fw-semibold"
        style={{ position: 'sticky', top: 0 }}
      >
        Bookmarks
      </div>
      {items.length === 0 ? (
        <div className="card-body py-2 small text-muted">
          No bookmarks yet. Click the dot beside a line to add one.
        </div>
      ) : (
        <ul className="list-group list-group-flush">
          {items.map(b => (
            <li
              key={b.key}
              className="list-group-item list-group-item-action d-flex align-items-start gap-2 py-2"
              style={{ cursor: 'pointer' }}
              onClick={() => onNavigate({ partNum: b.partNum, lineIndex: b.lineIndex })}
            >
              <div className="flex-grow-1 overflow-hidden">
                <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                  Part {b.partNum} &middot; Line {b.lineIndex + 1}
                </div>
                <div className="small text-truncate" style={{ fontSize: '0.8125rem' }}>
                  {b.preview
                    ? b.preview
                    : <em className="text-muted">empty line</em>}
                </div>
              </div>
              <button
                className="btn btn-sm btn-link text-muted p-0 flex-shrink-0"
                style={{ fontSize: '1rem', lineHeight: 1 }}
                title="Remove bookmark"
                onClick={e => { e.stopPropagation(); onRemove(b.key); }}
              >
                &times;
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
