import { collectAllPages } from "./instaqlPagination";

const PAGE_SIZE = 500;

interface LinkedId {
  id: string;
}

interface ShareRow {
  id: string;
  txt?: LinkedId[];
  fromUser?: LinkedId[];
  toUser?: LinkedId[];
}

export interface ShareEntry {
  id: string;
  txtId: string;
  fromUserId: string;
  toUserId: string;
}

export async function listShares(db: any): Promise<ShareEntry[]> {
  const rows = await collectAllPages<ShareRow>(async (after) => {
    const offset = (after as number | undefined) ?? 0;
    const result = await db.queryOnce({
      txtShares: {
        $: {
          order: { shareKey: "asc" },
          limit: PAGE_SIZE,
          offset,
        },
        txt: {},
        fromUser: {},
        toUser: {},
      },
    });
    const page = result.data.txtShares ?? [];
    return {
      rows: page,
      hasNextPage: page.length === PAGE_SIZE,
      endCursor: offset + page.length,
    };
  });

  return rows.flatMap((row) => {
    const txtId = row.txt?.[0]?.id;
    const fromUserId = row.fromUser?.[0]?.id;
    const toUserId = row.toUser?.[0]?.id;
    if (!txtId || !fromUserId || !toUserId) return [];
    return [{ id: row.id, txtId, fromUserId, toUserId }];
  });
}
