import type { CategoryDef } from './types.js';

export const cacheCategory: CategoryDef = {
  id: 'cache',
  label: 'Cache',
  description: 'Local data directory and cache TTLs',
  fields: [
    {
      key: 'WIGOLO_DATA_DIR',
      settingsPath: 'dataDir',
      label: 'Data directory',
      kind: 'path',
      propagateToAgents: false,
      help: 'Wigolo data + cache directory',
    },
    {
      key: 'CACHE_TTL_SEARCH',
      settingsPath: 'cacheTtlSearch',
      label: 'Search cache TTL (s)',
      kind: 'number',
      default: 86400,
      min: 60,
      max: 604800,
      help: 'Search cache TTL (seconds)',
    },
    {
      key: 'CACHE_TTL_CONTENT',
      settingsPath: 'cacheTtlContent',
      label: 'Content cache TTL (s)',
      kind: 'number',
      default: 604800,
      min: 60,
      max: 2592000,
      help: 'Page-content cache TTL (seconds)',
    },
  ],
};
