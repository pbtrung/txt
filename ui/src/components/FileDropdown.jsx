import React, { useState, useEffect, useRef } from 'react';

export default function FileDropdown({
  txts, selectedTxt, onSelect,
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (ref.current && !ref.current.contains(e.target))
        setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () =>
      document.removeEventListener('mousedown', onClickOutside);
  }, []);

  return (
    <div className="dropdown" ref={ref}>
      <button
        type="button"
        className={
          'form-select form-select-sm text-truncate text-start' +
          (!selectedTxt ? ' text-muted' : '')
        }
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
      >
        {selectedTxt
          ? selectedTxt.name
          : `— select one of ${txts.length} files —`}
      </button>
      {open && (
        <ul
          className="dropdown-menu show w-100"
          style={{
            maxHeight: '60vh',
            overflowY: 'auto',
            fontSize: '0.875rem',
          }}
        >
          {txts.map(txt => (
            <li key={txt.id}>
              <button
                type="button"
                className={
                  'dropdown-item text-truncate' +
                  (selectedTxt?.id === txt.id ? ' active' : '')
                }
                title={txt.name}
                onClick={() => {
                  onSelect(txt);
                  setOpen(false);
                }}
              >
                {txt.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
