import { useId, type CSSProperties, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, Dialog, Heading, Modal, ModalOverlay } from "react-aria-components";
import { classNames } from "../util/classNames";

export function OffcanvasPanel({
  open,
  onClose,
  title,
  placement = "end",
  className,
  overlayClassName,
  portalContainer,
  style,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  placement?: "start" | "end";
  className?: string;
  overlayClassName?: string;
  portalContainer?: Element;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelClassName = classNames(
    "aria-drawer-panel",
    `aria-drawer-${placement}`,
    className,
  );

  return (
    <ModalOverlay
      isOpen={open}
      onOpenChange={(isOpen) => !isOpen && onClose()}
      isDismissable
      className={classNames("aria-offcanvas-overlay", overlayClassName)}
      UNSTABLE_portalContainer={portalContainer}
    >
      <Modal className="aria-offcanvas-modal">
        <Dialog
          aria-labelledby={titleId}
          className={classNames(panelClassName, "flex flex-col")}
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
      <div className="aria-drawer-header">
        <Heading slot="title" level={2} className="aria-drawer-title" id={titleId}>
          {title}
        </Heading>
        <Button
          className="btn btn-ghost btn-sm btn-square"
          aria-label="Close"
          onPress={onClose}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </div>
      <div className="aria-drawer-body">{children}</div>
    </>
  );
}
