import { i } from '@instantdb/react';

const _schema = i.schema({
  entities: {
    $files: i.entity({
      path: i.string().unique().indexed(),
      url: i.string().optional(),
    }),
    $users: i.entity({
      type: i.string(),
    }),
    txt: i.entity({
      txtKeyBlob: i.string(),
    }),
    txtAccess: i.entity({}),
    umkStore: i.entity({
      umkBlob: i.string(),
    }),
    metadataStore: i.entity({
      metadataKeyBlob: i.string(),
    }),
    bookmarks: i.entity({}),
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
    txtFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'entry',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'txt',
        has: 'one',
        label: 'entryFile',
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
        label: 'entry',
        required: true,
        onDelete: 'cascade',
      },
      reverse: {
        on: 'txt',
        has: 'many',
        label: 'bookmarks',
      },
    },
    bookmarkFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'bookmark',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'bookmarks',
        has: 'one',
        label: 'contentFile',
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
    txtAccessFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'txtAccess',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'txtAccess',
        has: 'one',
        label: 'contentFile',
      },
    },
    metadataFileEntry: {
      forward: {
        on: '$files',
        has: 'one',
        label: 'metadataStore',
        onDelete: 'cascade',
      },
      reverse: {
        on: 'metadataStore',
        has: 'one',
        label: 'contentFile',
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
