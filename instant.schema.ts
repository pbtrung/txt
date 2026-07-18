import { i } from '@instantdb/react';

const _schema = i.schema({
  entities: {
    $users: i.entity({
      type: i.string(),
    }),
    txt: i.entity({
      txtKeyBlob: i.string(),
    }),
    txtParts: i.entity({
      path: i.string().unique().indexed(),
      partNum: i.number().indexed(),
    }),
    txtAccess: i.entity({
      path: i.string().unique().indexed(),
    }),
    umkStore: i.entity({
      umkBlob: i.string(),
    }),
    metadataStore: i.entity({
      metadataKeyBlob: i.string(),
      path: i.string().unique().indexed(),
    }),
    bookmarks: i.entity({
      path: i.string().unique().indexed(),
    }),
  },
  links: {
    $usersLinkedPrimaryUser: {
      forward: {
        on: '$users',
        has: 'one',
        label: 'linkedPrimaryUser',
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'many',
        label: 'linkedGuestUsers',
      },
    },
    txtUmkStore: {
      forward: {
        on: 'txt',
        has: 'one',
        label: 'umk',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: 'umkStore',
        has: 'many',
        label: 'txt',
      },
    },
    txtTxtParts: {
      forward: {
        on: 'txtParts',
        has: 'one',
        label: 'txt',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: 'txt',
        has: 'many',
        label: 'txtParts',
      },
    },
    umkStoreOwner: {
      forward: {
        on: 'umkStore',
        has: 'one',
        label: 'owner',
        onDelete: 'cascade',
      },
      reverse: {
        on: '$users',
        has: 'one',
        label: 'umkStore',
      },
    },
    umkStoreMetadata: {
      forward: {
        on: 'metadataStore',
        has: 'one',
        label: 'owner',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: 'umkStore',
        has: 'one',
        label: 'metadata',
      },
    },
    txtBookmarks: {
      forward: {
        on: 'bookmarks',
        has: 'one',
        label: 'txt',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: 'txt',
        has: 'many',
        label: 'bookmarks',
      },
    },
    txtAccessTxt: {
      forward: {
        on: 'txtAccess',
        has: 'one',
        label: 'txt',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'txt',
        has: 'one',
        label: 'txtAccess',
      },
    },
  },
  rooms: {},
});

type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
