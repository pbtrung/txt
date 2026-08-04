import { AccountFooter } from "../../components/AccountFooter";
import { NavItem } from "../../components/NavItem";

export type Section = "users" | "books" | "shares";

export function ManageNavContent({
  section,
  selectSection,
  usersCount,
  booksCount,
  sharesCount,
  displayName,
  onLock,
  onRefresh,
  refreshing,
}: {
  section: Section;
  selectSection: (next: Section) => void;
  usersCount: number;
  booksCount: number;
  sharesCount: number;
  displayName: string | undefined;
  onLock: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <>
      <div className="flex-grow-1 overflow-auto">
        <div className="list-group list-group-flush">
          <NavItem
            active={section === "users"}
            label="Users"
            count={usersCount}
            onClick={() => selectSection("users")}
          />
          <NavItem
            active={section === "books"}
            label="Books"
            count={booksCount}
            onClick={() => selectSection("books")}
          />
          <NavItem
            active={section === "shares"}
            label="Shares"
            count={sharesCount}
            onClick={() => selectSection("shares")}
          />
        </div>
      </div>

      <AccountFooter
        displayName={displayName}
        onRefresh={onRefresh}
        onLock={onLock}
        refreshing={refreshing}
        refreshAriaLabel="Refresh"
      />
    </>
  );
}
