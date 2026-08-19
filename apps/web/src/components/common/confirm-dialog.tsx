import { Modal } from "antd";
import { AlertTriangle } from "lucide-react";

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
  return (
    <Modal
      open={open}
      width={440}
      title={
        <span className={`confirm-dialog-title${danger ? " danger" : ""}`}>
          <span className="dialog-symbol">
            <AlertTriangle size={19} aria-hidden="true" />
          </span>
          <span>{title}</span>
        </span>
      }
      okText={confirmLabel}
      cancelText="返回"
      confirmLoading={pending}
      closable={!pending}
      keyboard={!pending}
      mask={{ closable: !pending }}
      cancelButtonProps={{ disabled: pending, autoFocus: true }}
      okButtonProps={{ danger }}
      onCancel={() => !pending && onOpenChange(false)}
      onOk={onConfirm}
      className="confirm-dialog"
    >
      <p className="confirm-dialog-description">{description}</p>
    </Modal>
  );
}
