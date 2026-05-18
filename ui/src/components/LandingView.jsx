import React from 'react';

const titleStyle = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

function RemoveButton({ title = 'Remove', onClick }) {
  return (
    <button className="btn btn-sm btn-link text-muted p-0 flex-shrink-0" style={{ fontSize: '1rem', lineHeight: 1 }} title={title} onClick={onClick}>
      &times;
    </button>
  );
}

function ItemTitle({ children }) {
  return <div className="small fw-medium" style={titleStyle}>{children}</div>;
}

function RecentAccessItem({ item, onSelectTxt, onRemoveAccess }) {
  const select = () => onSelectTxt(
    { id: item.txtId, name: item.name },
    item.lastPartNum,
    { partNum: item.lastPartNum, lineIndex: null },
  );
  const remove = e => { e.stopPropagation(); onRemoveAccess(item.txtId); };
  return (
    <li className="list-group-item list-group-item-action py-2 px-2 d-flex align-items-start gap-2" style={{ cursor: 'pointer' }} onClick={select}>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <ItemTitle>{item.name}</ItemTitle>
        <div className="text-muted" style={{ fontSize: '0.7rem' }}>Part {item.lastPartNum}</div>
      </div>
      <RemoveButton onClick={remove} />
    </li>
  );
}

function RecentAccessList({ recentAccess, onSelectTxt, onRemoveAccess }) {
  if (recentAccess.length === 0) return null;
  return (
    <>
      <p className="text-muted small mb-2">Recently opened:</p>
      <ul className="list-group list-group-flush mb-3">
        {recentAccess.map(item => <RecentAccessItem key={item.txtId} item={item} onSelectTxt={onSelectTxt} onRemoveAccess={onRemoveAccess} />)}
      </ul>
    </>
  );
}

function BookmarkMeta({ bm }) {
  return (
    <div className="text-muted" style={{ fontSize: '0.7rem' }}>
      Part {bm.partNum} &middot; Line {bm.lineIndex + 1}
      {bm.preview && ` · ${bm.preview}…`}
    </div>
  );
}

function RecentBookmarkItem({ bm, onSelectTxt, onRemoveBookmark }) {
  const select = () => onSelectTxt(
    { id: bm.txtId, name: bm.txtName },
    bm.partNum,
    { partNum: bm.partNum, lineIndex: bm.lineIndex },
  );
  const remove = e => { e.stopPropagation(); onRemoveBookmark(bm.dbId); };
  return (
    <li className="list-group-item list-group-item-action py-2 px-2 d-flex align-items-start gap-2" style={{ cursor: 'pointer' }} onClick={select}>
      <div className="flex-grow-1" style={{ minWidth: 0 }}>
        <ItemTitle>{bm.txtName}</ItemTitle>
        <BookmarkMeta bm={bm} />
      </div>
      <RemoveButton onClick={remove} />
    </li>
  );
}

function RecentBookmarkList({ recentBookmarks, onSelectTxt, onRemoveBookmark }) {
  if (recentBookmarks.length === 0) return null;
  return (
    <>
      <p className="text-muted small mb-2">Recent bookmarks:</p>
      <ul className="list-group list-group-flush">
        {recentBookmarks.map(bm => <RecentBookmarkItem key={bm.dbId} bm={bm} onSelectTxt={onSelectTxt} onRemoveBookmark={onRemoveBookmark} />)}
      </ul>
    </>
  );
}

function EmptyLanding({ recentAccess, recentBookmarks }) {
  return recentAccess.length === 0 && recentBookmarks.length === 0
    ? <p className="text-muted small mb-0">Select a file to view its content.</p>
    : null;
}

export default function LandingView(props) {
  return (
    <div style={{ paddingLeft: '1rem' }}>
      <EmptyLanding {...props} />
      <RecentAccessList {...props} />
      <RecentBookmarkList {...props} />
    </div>
  );
}
