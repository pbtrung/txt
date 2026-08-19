import { useId, type CSSProperties, type ReactNode } from "react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classNames } from "../util/classNames";

export function OffcanvasPanel({
  open,
  onClose,
  title,
  placement = "end",
  className,
  style,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placement?: "start" | "end";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelClassName = classNames(
    "offcanvas",
    `offcanvas-${placement}`,
    "show",
    className,
  );

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
          className={classNames(panelClassName, "d-flex flex-column")}
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
