import React from 'react';

export default function ReaderView({
  content, currentPartNum, bookmarks, lineRefs, onToggleBookmark, fontSize,
}) {
  return (
    <div style={{ fontFamily: "'Literata', serif", fontSize, maxWidth: '70ch' }}>
      {content.split('\n').map((line, i) => {
        const key = `${currentPartNum}:${i}`;
        const isBookmarked = bookmarks.has(key);
        return (
          <div
            key={i}
            ref={el => { lineRefs.current[i] = el; }}
            className={`reader-line${isBookmarked ? ' bookmarked-line' : ''}`}
          >
            <button
              className="line-bar"
              onClick={() => onToggleBookmark(i, line.trim().slice(0, 60))}
              title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
            />
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>
              {line || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}
