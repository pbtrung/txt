import React from 'react';

export default function BookmarkChooser({ bookmarks, onNavigate, onRemove }) {
  return (
    <div style={{ paddingLeft: '1rem' }}>
      {bookmarks.size === 0
        ? <p className="text-muted small mb-0">No bookmarks left. Use the part controls below to navigate.</p>
        : <p className="text-muted small mb-2">Pick up where you left off:</p>
      }
      <ul className="list-group list-group-flush mb-3">
        {[...bookmarks.values()]
          .sort((a, b) => a.partNum - b.partNum || a.lineIndex - b.lineIndex)
          .map(bm => (
            <li
              key={bm.key}
              className="list-group-item list-group-item-action py-2 px-2 d-flex align-items-start gap-2"
              style={{ cursor: 'pointer' }}
              onClick={() => onNavigate({ partNum: bm.partNum, lineIndex: bm.lineIndex })}
            >
              <div className="flex-grow-1" style={{ minWidth: 0 }}>
                <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                  Part {bm.partNum} &middot; Line {bm.lineIndex + 1}
                </div>
                <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {bm.preview
                    ? `${bm.preview}…`
                    : <em className="text-muted">empty line</em>}
                </div>
              </div>
              <button
                className="btn btn-sm btn-link text-muted p-0 flex-shrink-0"
                style={{ fontSize: '1rem', lineHeight: 1 }}
                title="Remove bookmark"
                onClick={e => { e.stopPropagation(); onRemove(bm.key); }}
              >
                &times;
              </button>
            </li>
          ))
        }
      </ul>
    </div>
  );
}
