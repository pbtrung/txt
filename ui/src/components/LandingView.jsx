import React from 'react';

export default function LandingView({ recentAccess, recentBookmarks, onSelectTxt, onRemoveAccess, onRemoveBookmark }) {
  return (
    <div style={{ paddingLeft: '1rem' }}>
      {recentAccess.length === 0 && recentBookmarks.length === 0 && (
        <p className="text-muted small mb-0">Select a file to view its content.</p>
      )}
      {recentAccess.length > 0 && (
        <>
          <p className="text-muted small mb-2">Recently opened:</p>
          <ul className="list-group list-group-flush mb-3">
            {recentAccess.map(item => (
              <li
                key={item.txtId}
                className="list-group-item list-group-item-action py-2 px-2 d-flex align-items-start gap-2"
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectTxt(
                  { id: item.txtId, name: item.name },
                  item.lastPartNum,
                  { partNum: item.lastPartNum, lineIndex: null },
                )}
              >
                <div className="flex-grow-1" style={{ minWidth: 0 }}>
                  <div className="small fw-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {item.name}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                    Part {item.lastPartNum}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-link text-muted p-0 flex-shrink-0"
                  style={{ fontSize: '1rem', lineHeight: 1 }}
                  title="Remove"
                  onClick={e => { e.stopPropagation(); onRemoveAccess(item.txtId); }}
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {recentBookmarks.length > 0 && (
        <>
          <p className="text-muted small mb-2">Recent bookmarks:</p>
          <ul className="list-group list-group-flush">
            {recentBookmarks.map(bm => (
              <li
                key={bm.dbId}
                className="list-group-item list-group-item-action py-2 px-2 d-flex align-items-start gap-2"
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectTxt(
                  { id: bm.txtId, name: bm.txtName },
                  bm.partNum,
                  { partNum: bm.partNum, lineIndex: bm.lineIndex },
                )}
              >
                <div className="flex-grow-1" style={{ minWidth: 0 }}>
                  <div className="small fw-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {bm.txtName}
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                    Part {bm.partNum} &middot; Line {bm.lineIndex + 1}
                    {bm.preview && ` · ${bm.preview}…`}
                  </div>
                </div>
                <button
                  className="btn btn-sm btn-link text-muted p-0 flex-shrink-0"
                  style={{ fontSize: '1rem', lineHeight: 1 }}
                  title="Remove"
                  onClick={e => { e.stopPropagation(); onRemoveBookmark(bm.dbId); }}
                >
                  &times;
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
