import React from 'react';

const MIN_FONT = 8;
const MAX_FONT = 32;

function StepButton({ disabled, onClick, title, children }) {
  return (
    <button className="btn btn-sm btn-outline-secondary px-2 py-0" disabled={disabled} onClick={onClick} title={title}>
      {children}
    </button>
  );
}

function PartInput({ currentPartNum, hasParts, onPartNumChange, onLoadPart }) {
  const submit = () => onLoadPart(currentPartNum);
  const onKeyDown = e => { if (e.key === 'Enter') submit(); };
  return (
    <input
      type="text" inputMode="numeric" pattern="[0-9]*"
      className="form-control form-control-sm text-center"
      style={{ width: '6ch' }} value={currentPartNum} disabled={!hasParts}
      onChange={e => onPartNumChange(Number(e.target.value))}
      onBlur={submit} onKeyDown={onKeyDown}
    />
  );
}

function PartTotal({ hasParts, totalParts }) {
  return (
    <span className="text-muted flex-shrink-0" style={{ fontSize: '0.875rem' }}>
      {'/ '}
      {hasParts ? totalParts : '—'}
    </span>
  );
}

function EmptyPartState() {
  return <span className="text-muted">&mdash;{' / '}&mdash;</span>;
}

function PartControls(props) {
  if (!props.hasTxt) return <EmptyPartState />;
  return (
    <>
      <PartInput {...props} />
      <PartTotal hasParts={props.hasParts} totalParts={props.totalParts} />
    </>
  );
}

function PartStepper(props) {
  const prevDisabled = !props.hasParts || props.currentPartNum <= 1;
  const nextDisabled = !props.hasParts || props.currentPartNum >= props.totalParts;
  return (
    <div className="d-flex align-items-center gap-1">
      <StepButton disabled={prevDisabled} onClick={() => props.onLoadPart(props.currentPartNum - 1)}>−</StepButton>
      <PartControls {...props} />
      <StepButton disabled={nextDisabled} onClick={() => props.onLoadPart(props.currentPartNum + 1)}>+</StepButton>
    </div>
  );
}

function FontStepper({ fontSize, setFontSize }) {
  return (
    <div className="d-flex align-items-center gap-1">
      <StepButton disabled={fontSize <= MIN_FONT} onClick={() => setFontSize(f => Math.max(MIN_FONT, f - 1))} title="Decrease font size">−</StepButton>
      <span className="text-muted" style={{ minWidth: 36, textAlign: 'center', fontSize: '0.875rem' }}>{fontSize}px</span>
      <StepButton disabled={fontSize >= MAX_FONT} onClick={() => setFontSize(f => Math.min(MAX_FONT, f + 1))} title="Increase font size">+</StepButton>
    </div>
  );
}

export default function PartFooter(props) {
  return (
    <div className="card-footer d-flex align-items-center justify-content-between gap-2">
      <PartStepper {...props} />
      <FontStepper fontSize={props.fontSize} setFontSize={props.setFontSize} />
    </div>
  );
}
