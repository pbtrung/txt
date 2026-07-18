import type { InstantRules } from '@instantdb/react';
import type { AppSchema } from './instant.schema';

const rules = {
  umkStore: {
    bind: ['isOwner', "auth.id in data.ref('owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('owner' in request.modifiedFields)",
    },
  },
  txt: {
    bind: ['isOwner', "auth.id in data.ref('umk.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('umk' in request.modifiedFields)",
    },
  },
  $files: {
    bind: ['isOwnPath', "data.path.startsWith(auth.id + '/')"],
    allow: {
      view: 'isOwnPath',
      create: 'isOwnPath',
      delete: 'isOwnPath',
      update: 'false',
    },
  },
  metadataStore: {
    bind: ['isOwner', "auth.id in data.ref('owner.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('owner' in request.modifiedFields)",
    },
  },
  bookmarks: {
    bind: ['isOwner', "auth.id in data.ref('entry.umk.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
    },
  },
} satisfies InstantRules<AppSchema>;

export default rules;
