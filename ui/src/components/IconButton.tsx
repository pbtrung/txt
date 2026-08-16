import type { ButtonHTMLAttributes } from "react";
import { classNames } from "../util/classNames";

interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children"
> {
  label: string;
  icon: string;
}

export function IconButton({
  label,
  icon,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={classNames("btn btn-sm btn-outline-secondary", className)}
      aria-label={label}
    >
      <i className={`bi bi-${icon}`} aria-hidden="true" />
    </button>
  );
}
