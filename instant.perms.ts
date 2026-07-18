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
  txtParts: {
    bind: ['isOwner', "auth.id in data.ref('txt.umk.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
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
    bind: ['isOwner', "auth.id in data.ref('txt.umk.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
    },
  },
  txtAccess: {
    bind: ['isOwner', "auth.id in data.ref('txt.umk.owner.id')"],
    allow: {
      view: 'isOwner',
      create: 'isOwner',
      delete: 'isOwner',
      update: "isOwner && !('txt' in request.modifiedFields)",
    },
  },
} satisfies InstantRules<AppSchema>;

export default rules;
