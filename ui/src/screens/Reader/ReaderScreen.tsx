// Placeholder -- Screen 3 (Reader) is built out in full in a later step
// (docs/ui.md).

import { useParams } from "react-router-dom";

export function ReaderScreen() {
  const { txtId } = useParams();
  return (
    <div className="container py-4">
      <p>Reader for txt_id={txtId} (not yet implemented).</p>
    </div>
  );
}
