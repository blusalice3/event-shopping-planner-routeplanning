import type { SmartInsertMode } from '../features/app-shell/types';

export const normalizeSmartInsertMode = (value: string | null): SmartInsertMode => {
  return value === 'preview' ? 'preview' : 'map';
};
