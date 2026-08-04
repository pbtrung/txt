import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { isMemoryRouterActive } from "../appRouter";

interface InternalLinkProps extends Pick<
  AnchorHTMLAttributes<HTMLElement>,
  "className" | "aria-label" | "title"
> {
  to: string;
  children: ReactNode;
}

function InternalLinkButton({
  to,
  className,
  children,
  ...rest
}: InternalLinkProps) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={`link-reset ${className ?? ""}`}
      onClick={() => navigate(to)}
      {...rest}
    >
      {children}
    </button>
  );
}

export function InternalLink({ to, children, ...rest }: InternalLinkProps) {
  return isMemoryRouterActive() ? (
    <InternalLinkButton to={to} {...rest}>
      {children}
    </InternalLinkButton>
  ) : (
    <Link to={to} {...rest}>
      {children}
    </Link>
  );
}
