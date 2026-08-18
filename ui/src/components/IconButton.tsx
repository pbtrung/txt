import {
  Button,
  Tooltip,
  TooltipTrigger,
  type ButtonProps,
} from "react-aria-components";
import { classNames } from "../util/classNames";

interface IconButtonProps extends Omit<ButtonProps, "children" | "className"> {
  label: string;
  icon: string;
  className?: string;
}

export function IconButton({
  label,
  icon,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  return (
    <TooltipTrigger delay={500} closeDelay={100}>
      <Button
        {...props}
        type={type}
        className={classNames("btn btn-sm btn-outline-secondary", className)}
        aria-label={label}
      >
        <i className={`bi bi-${icon}`} aria-hidden="true" />
      </Button>
      <Tooltip placement="top" offset={6} className="aria-tooltip">
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}
