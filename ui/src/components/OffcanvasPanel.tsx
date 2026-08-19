import { useEffect, useId, useState, type CSSProperties, type ReactNode } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classNames } from "../util/classNames";

const MD_MEDIA_QUERY = "(min-width: 768px)";

export function OffcanvasPanel({
  open,
  onClose,
  title,
  placement = "end",
  responsive,
  className,
  style,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placement?: "start" | "end";
  responsive?: "md";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const desktop = useMediaQuery(MD_MEDIA_QUERY);
  const titleId = useId();
  const panelClassName = classNames(
    responsive ? `offcanvas-${responsive}` : "offcanvas",
    (!responsive || !desktop) && `offcanvas-${placement}`,
    (!responsive || !desktop) && "show",
    className,
  );

  if (responsive && desktop) {
    return (
      <div
        className={panelClassName}
        style={style}
        role="region"
        aria-labelledby={titleId}
      >
        <PanelContents title={title} titleId={titleId} onClose={onClose}>
          {children}
        </PanelContents>
      </div>
    );
  }

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      isDismissable
      className="aria-offcanvas-overlay"
    >
      <Modal className="aria-offcanvas-modal">
        <Dialog
          aria-labelledby={titleId}
          className={classNames(panelClassName, "d-flex flex-column h-100")}
          style={style}
        >
          <PanelContents title={title} titleId={titleId} onClose={onClose}>
            {children}
          </PanelContents>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

function PanelContents({
  title,
  titleId,
  onClose,
  children,
}: {
  title: string;
  titleId: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <>
      <div className="offcanvas-header">
        <Heading slot="title" level={2} className="h5 offcanvas-title" id={titleId}>
          {title}
        </Heading>
        <Button className="btn-close" aria-label="Close" onPress={onClose} />
      </div>
      <div className="offcanvas-body">{children}</div>
    </>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}
