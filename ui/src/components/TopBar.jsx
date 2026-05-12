import React from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPowerOff, faBookmark } from '@fortawesome/free-solid-svg-icons';
import BookmarkPanel from './BookmarkPanel.jsx';

export default function TopBar({
  hasTxt, showBookmarks, setShowBookmarks,
  bookmarks, selectedTxt, onNavigate, onRemove, onDisconnect,
}) {
  const count = bookmarks.size;
  return (
    <div
      className="d-flex align-items-center justify-content-between mb-3"
      style={{ position: 'relative' }}
    >
      <span className="fw-bold">Text Reader</span>
      <div className="d-flex align-items-center gap-2">
        <div>
          <button
            className={'btn btn-sm' + (showBookmarks ? ' btn-secondary' : ' btn-outline-secondary')}
            disabled={!hasTxt}
            onClick={() => setShowBookmarks(v => !v)}
          >
            <FontAwesomeIcon icon={faBookmark} />
            {count > 0 && (
              <span className="ms-1 badge bg-primary rounded-pill" style={{ fontSize: '0.65rem' }}>
                {count}
              </span>
            )}
          </button>
          {showBookmarks && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 199 }}
                onClick={() => setShowBookmarks(false)}
              />
              <BookmarkPanel
                bookmarks={bookmarks}
                selectedTxt={selectedTxt}
                onNavigate={onNavigate}
                onRemove={onRemove}
              />
            </>
          )}
        </div>
        <button
          className="btn btn-sm btn-outline-secondary"
          onClick={onDisconnect}
          title="Disconnect"
        >
          <FontAwesomeIcon icon={faPowerOff} />
        </button>
      </div>
    </div>
  );
}
