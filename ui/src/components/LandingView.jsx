import React from 'react';

export default function LandingView({ recentAccess, recentBookmarks, onSelectTxt }) {
  return (
    <div style={{ paddingLeft: '1rem' }}>
      {recentAccess.length > 0 ? (
        <>
          <p className="text-muted small mb-2">Recently opened:</p>
          <ul className="list-group list-group-flush mb-3">
            {recentAccess.map(item => (
              <li
                key={item.txtId}
                className="list-group-item list-group-item-action py-2 px-2"
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectTxt({ id: item.txtId, name: item.name }, item.lastPartNum)}
              >
                <div className="small fw-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.name}
                </div>
                <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                  Part {item.lastPartNum}
                </div>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-muted small mb-0">Select a file to view its content.</p>
      )}
      {recentBookmarks.length > 0 && (
        <>
          <p className="text-muted small mb-2">Recent bookmarks:</p>
          <ul className="list-group list-group-flush">
            {recentBookmarks.map(bm => (
              <li
                key={bm.dbId}
                className="list-group-item list-group-item-action py-2 px-2"
                style={{ cursor: 'pointer' }}
                onClick={() => onSelectTxt(
                  { id: bm.txtId, name: bm.txtName },
                  bm.partNum,
                  { partNum: bm.partNum, lineIndex: bm.lineIndex },
                )}
              >
                <div className="small fw-medium" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {bm.txtName}
                </div>
                <div className="text-muted" style={{ fontSize: '0.7rem' }}>
                  Part {bm.partNum} &middot; Line {bm.lineIndex + 1}
                  {bm.preview && ` · ${bm.preview}…`}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
