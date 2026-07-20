// The Library top bar's "Unlocked" status pill (docs/ui.md).

import type { ReactNode } from "react";

export function StatusPill({ children }: { children: ReactNode }) {
  return <span className="badge text-bg-primary rounded-pill px-3 py-2">{children}</span>;
}
