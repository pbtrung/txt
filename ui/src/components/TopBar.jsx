import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPowerOff, faBookmark, faHouse } from '@fortawesome/free-solid-svg-icons';
import BookmarkPanel from './BookmarkPanel.jsx';

function IconButton({ className, disabled, onClick, title, icon, children }) {
  return (
    <button className={className} disabled={disabled} onClick={onClick} title={title}>
      <FontAwesomeIcon icon={icon} />
      {children}
    </button>
  );
}

function BookmarkBadge({ count }) {
  return count > 0
    ? <span className="ms-1 badge bg-primary rounded-pill" style={{ fontSize: '0.65rem' }}>{count}</span>
    : null;
}

function BookmarkButton({ hasTxt, showBookmarks, setShowBookmarks, count }) {
  const type = showBookmarks ? ' btn-primary' : ' btn-outline-primary';
  return (
    <IconButton className={`btn btn-sm${type}`} disabled={!hasTxt} onClick={() => setShowBookmarks(v => !v)} icon={faBookmark}>
      <BookmarkBadge count={count} />
    </IconButton>
  );
}

function BookmarkOverlay({ visible, setShowBookmarks, panelProps }) {
  if (!visible) return null;
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 199 }} onClick={() => setShowBookmarks(false)} />
      <BookmarkPanel {...panelProps} />
    </>
  );
}

function BookmarkMenu(props) {
  const panelProps = {
    bookmarks: props.bookmarks, selectedTxt: props.selectedTxt,
    onNavigate: props.onNavigate, onRemove: props.onRemove,
  };
  return (
    <div>
      <BookmarkButton {...props} count={props.bookmarks.size} />
      <BookmarkOverlay visible={props.showBookmarks} setShowBookmarks={props.setShowBookmarks} panelProps={panelProps} />
    </div>
  );
}

function HomeButton({ hasTxt, onHome }) {
  return (
    <IconButton className="btn btn-sm btn-outline-primary" disabled={!hasTxt} onClick={onHome} title="Home" icon={faHouse} />
  );
}

function DisconnectButton({ onDisconnect }) {
  return (
    <IconButton className="btn btn-sm btn-outline-danger" onClick={onDisconnect} title="Disconnect" icon={faPowerOff} />
  );
}

export default function TopBar(props) {
  return (
    <div className="d-flex align-items-center justify-content-between mb-3" style={{ position: 'relative' }}>
      <span className="fw-bold">Text Reader</span>
      <div className="d-flex align-items-center gap-2">
        <BookmarkMenu {...props} />
        <HomeButton hasTxt={props.hasTxt} onHome={props.onHome} />
        <DisconnectButton onDisconnect={props.onDisconnect} />
      </div>
    </div>
  );
}
