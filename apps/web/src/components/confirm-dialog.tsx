import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, X } from "lucide-react";
import { useRef } from "react";
import { IconButton } from "./icon-button.js";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description: string;
  confirmLabel: string;
  pending?: boolean;
  danger?: boolean;
  onConfirm(): void;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  pending = false,
  danger = false,
  onConfirm,
}: ConfirmDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content
          className="dialog-content dialog-content-small"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelButtonRef.current?.focus();
          }}
        >
          <div className="dialog-heading">
            <span className={`dialog-symbol${danger ? " danger" : ""}`}>
              <AlertTriangle size={19} aria-hidden="true" />
            </span>
            <div>
              <Dialog.Title>{title}</Dialog.Title>
              <Dialog.Description>{description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton label="关闭" disabled={pending}>
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </div>
          <div className="dialog-actions">
            <Dialog.Close asChild>
              <button
                ref={cancelButtonRef}
                type="button"
                className="button button-secondary"
                disabled={pending}
              >
                返回
              </button>
            </Dialog.Close>
            <button
              type="button"
              className={`button ${danger ? "button-danger" : "button-primary"}`}
              disabled={pending}
              onClick={onConfirm}
            >
              {pending ? "正在提交" : confirmLabel}
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
