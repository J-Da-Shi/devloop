import { Button, Tooltip, type ButtonProps } from "antd";

interface IconButtonProps extends Omit<ButtonProps, "children" | "icon" | "shape" | "type"> {
  label: string;
  children: React.ReactNode;
}

export function IconButton({ label, children, className = "", ...props }: IconButtonProps) {
  return (
    <Tooltip title={label} mouseEnterDelay={0.35}>
      <Button
        type="text"
        shape="circle"
        className={`icon-button ${className}`.trim()}
        aria-label={label}
        icon={children}
        {...props}
      />
    </Tooltip>
  );
}
