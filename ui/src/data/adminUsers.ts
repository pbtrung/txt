import { collectAllPages } from "./instaqlPagination";

const PAGE_SIZE = 500;

interface UserRow {
  id: string;
  email?: string;
  type?: string;
}

export interface UserSummary {
  id: string;
  email?: string;
  displayName?: string;
  isAdmin: boolean;
}

export async function listUsersWithInfo(db: any): Promise<UserSummary[]> {
  const rows = await collectAllPages<UserRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      $users: {
        $: {
          order: { email: "asc" },
          limit: PAGE_SIZE,
          offset,
        },
      },
    });
    const page = result.data.$users ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.email,
    isAdmin: row.type === "admin",
  }));
}
