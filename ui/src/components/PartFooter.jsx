import React from 'react';

const MIN_FONT = 8;
const MAX_FONT = 32;

export default function PartFooter({
  hasTxt, hasParts,
  currentPartNum, totalParts,
  onPartNumChange, onLoadPart,
  fontSize, setFontSize,
}) {
  return (
    <div className={
      'card-footer d-flex align-items-center' +
      ' justify-content-between gap-2'
    }>
      <div className="d-flex align-items-center gap-1">
        <button
          className="btn btn-sm btn-outline-secondary px-2 py-0"
          disabled={!hasParts || currentPartNum <= 1}
          onClick={() => onLoadPart(currentPartNum - 1)}
        >−</button>
        {hasTxt ? (
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            className="form-control form-control-sm text-center"
            style={{ width: '5ch' }}
            value={currentPartNum}
            disabled={!hasParts}
            onChange={e =>
              onPartNumChange(Number(e.target.value))
            }
            onBlur={() => onLoadPart(currentPartNum)}
            onKeyDown={e => {
              if (e.key === 'Enter') onLoadPart(currentPartNum);
            }}
          />
        ) : (
          <span className="text-muted px-2">&mdash;</span>
        )}
        <span
          className="text-muted flex-shrink-0"
          style={{ fontSize: '0.875rem' }}
        >
          /{' '}
          {hasTxt && hasParts ? totalParts : '—'}
        </span>
        <button
          className="btn btn-sm btn-outline-secondary px-2 py-0"
          disabled={!hasParts || currentPartNum >= totalParts}
          onClick={() => onLoadPart(currentPartNum + 1)}
        >+</button>
      </div>
      <div className="d-flex align-items-center gap-1">
        <button
          className="btn btn-sm btn-outline-secondary px-2 py-0"
          disabled={fontSize <= MIN_FONT}
          onClick={
            () => setFontSize(f => Math.max(MIN_FONT, f - 1))
          }
          title="Decrease font size"
        >−</button>
        <span
          className="text-muted"
          style={{
            minWidth: 36,
            textAlign: 'center',
            fontSize: '0.875rem',
          }}
        >
          {fontSize}px
        </span>
        <button
          className="btn btn-sm btn-outline-secondary px-2 py-0"
          disabled={fontSize >= MAX_FONT}
          onClick={
            () => setFontSize(f => Math.min(MAX_FONT, f + 1))
          }
          title="Increase font size"
        >+</button>
      </div>
    </div>
  );
}
