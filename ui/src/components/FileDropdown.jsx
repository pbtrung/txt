import React, { useState, useEffect, useRef } from 'react';

function useOutsideClick(ref, onOutside) {
  useEffect(() => {
    function onMouseDown(e) {
      if (ref.current && !ref.current.contains(e.target)) onOutside();
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [onOutside, ref]);
}

function buttonLabel(txts, selectedTxt) {
  return selectedTxt
    ? selectedTxt.name
    : `— select one of ${txts.length} files —`;
}

function DropdownButton({ txts, selectedTxt, open, onClick }) {
  const className = `form-select form-select-sm text-truncate text-start${!selectedTxt ? ' text-muted' : ''}`;
  return (
    <button type="button" className={className} onClick={onClick} aria-expanded={open}>
      {buttonLabel(txts, selectedTxt)}
    </button>
  );
}

function sortedTxts(txts) {
  return [...txts].sort((a, b) => a.name.localeCompare(b.name));
}

function FileMenuItem({ txt, active, onSelect }) {
  const className = `dropdown-item text-truncate${active ? ' active' : ''}`;
  return (
    <li>
      <button type="button" className={className} title={txt.name} onClick={() => onSelect(txt)}>
        {txt.name}
      </button>
    </li>
  );
}

function FileMenu({ txts, selectedTxt, onSelect }) {
  const style = { maxHeight: '60vh', overflowY: 'auto', fontSize: '0.875rem' };
  return (
    <ul className="dropdown-menu show w-100" style={style}>
      {sortedTxts(txts).map(txt => <FileMenuItem key={txt.id} txt={txt} active={selectedTxt?.id === txt.id} onSelect={onSelect} />)}
    </ul>
  );
}

export default function FileDropdown({ txts, selectedTxt, onSelect }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const close = () => setOpen(false);
  const select = txt => { onSelect(txt); close(); };
  useOutsideClick(ref, close);
  return (
    <div className="dropdown" ref={ref}>
      <DropdownButton txts={txts} selectedTxt={selectedTxt} open={open} onClick={() => setOpen(value => !value)} />
      {open && <FileMenu txts={txts} selectedTxt={selectedTxt} onSelect={select} />}
    </div>
  );
}
