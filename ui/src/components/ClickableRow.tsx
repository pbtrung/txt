// A list row that's clickable as a whole (Library's book/bookmark rows,
// Reader's bookmark list) but also nests its own delete button -- a real
// <button> can't contain another button, so this plays the button role on a
// div instead, wiring up Enter/Space the same way a real button would.

import type { KeyboardEvent, ReactNode } from "react";

interface ClickableRowProps {
  onClick: () => void;
  className: string;
  children: ReactNode;
}

export function ClickableRow({ onClick, className, children }: ClickableRowProps) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onClick();
    }
  }

  return (
    <div role="button" tabIndex={0} className={className} onClick={onClick} onKeyDown={handleKeyDown}>
      {children}
    </div>
  );
}
