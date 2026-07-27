// A same-screen navigation link that's safe to use under either router
// appRouter.ts's pickRouterComponent() might have picked. Under BrowserRouter
// (a normal http(s) deployment) this is just react-router-dom's own <Link>.
// Under MemoryRouter (local_index.html's opaque-origin case, or Android's
// content:// equivalent -- see appRouter.ts's isMemoryRouterActive) a real
// <a href> would resolve against the <base> render.ts points at
// asset_base_url (needed there for asset loading), so hovering it would
// preview, and a new-tab/middle-click would actually perform, a live
// unverified fetch straight to the CDN -- exactly the gap local_index.html
// exists to close. This renders a hrefless, link-styled <button> instead in
// that case, so there's nothing to hover-preview, copy, or middle-click open;
// a plain left-click (or Enter/Space, since it's a real <button>) still
// navigates, purely in-memory, the same as it would through a <Link>.
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";

import { isMemoryRouterActive } from "../appRouter";

interface InternalLinkProps extends Pick<AnchorHTMLAttributes<HTMLElement>, "className" | "aria-label" | "title"> {
  to: string;
  children: ReactNode;
}

function InternalLinkButton({ to, className, children, ...rest }: InternalLinkProps) {
  const navigate = useNavigate();
  return (
    <button type="button" className={`link-reset ${className ?? ""}`} onClick={() => navigate(to)} {...rest}>
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
