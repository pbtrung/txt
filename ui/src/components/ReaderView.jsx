import React from 'react';

function lineKey(currentPartNum, lineIndex) {
  return `${currentPartNum}:${lineIndex}`;
}

function lineClass(isBookmarked) {
  return `reader-line${isBookmarked ? ' bookmarked-line' : ''}`;
}

function LineText({ line }) {
  const style = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 };
  return <span style={style}>{line || ' '}</span>;
}

function BookmarkButton({ line, index, isBookmarked, onToggleBookmark }) {
  return (
    <button
      className="line-bar"
      onClick={() => onToggleBookmark(index, line.trim().slice(0, 60))}
      title={isBookmarked ? 'Remove bookmark' : 'Add bookmark'}
    />
  );
}

function ReaderLine({ line, index, currentPartNum, bookmarks, lineRefs, onToggleBookmark }) {
  const key = lineKey(currentPartNum, index);
  const isBookmarked = bookmarks.has(key);
  return (
    <div ref={el => { lineRefs.current[index] = el; }} className={lineClass(isBookmarked)}>
      <BookmarkButton line={line} index={index} isBookmarked={isBookmarked} onToggleBookmark={onToggleBookmark} />
      <LineText line={line} />
    </div>
  );
}

export default function ReaderView({
  content, currentPartNum, bookmarks, lineRefs, onToggleBookmark, fontSize,
}) {
  const style = { fontFamily: "'Literata', serif", fontSize, maxWidth: '70ch' };
  return (
    <div style={style}>
      {content.split('\n').map((line, index) => (
        <ReaderLine
          key={index} line={line} index={index} currentPartNum={currentPartNum}
          bookmarks={bookmarks} lineRefs={lineRefs} onToggleBookmark={onToggleBookmark}
        />
      ))}
    </div>
  );
}
