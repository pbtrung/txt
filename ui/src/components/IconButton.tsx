import {
  Button,
  Tooltip,
  TooltipTrigger,
  type ButtonProps,
} from "react-aria-components";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Copy,
  Info,
  List,
  LockKeyhole,
  Share2,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { classNames } from "../util/classNames";

const ICONS = {
  "book-half": BookOpen,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  copy: Copy,
  "info-circle": Info,
  list: List,
  lock: LockKeyhole,
  share: Share2,
  trash: Trash2,
  "x-lg": X,
} satisfies Record<string, LucideIcon>;

interface IconButtonProps extends Omit<ButtonProps, "children" | "className"> {
  label: string;
  icon: keyof typeof ICONS;
  className?: string;
}

export function IconButton({
  label,
  icon,
  className,
  type = "button",
  ...props
}: IconButtonProps) {
  const Icon = ICONS[icon];
  return (
    <TooltipTrigger delay={500} closeDelay={100}>
      <Button
        {...props}
        type={type}
        className={classNames("btn btn-sm btn-outline btn-secondary", className)}
        aria-label={label}
      >
        <Icon className="size-4" aria-hidden="true" />
      </Button>
      <Tooltip placement="top" offset={6} className="aria-tooltip">
        {label}
      </Tooltip>
    </TooltipTrigger>
  );
}
