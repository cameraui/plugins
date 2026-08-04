export const IMPORT_ORIGIN = 'homeassistant';

export function importOptions(nativeId: string): { nativeId: string; origin: string; exposed: boolean } {
  return { nativeId, origin: IMPORT_ORIGIN, exposed: false };
}

export interface StorageValues {
  debug?: boolean;
  mutedNotifyServices?: string[];
  notifyServiceNames?: Record<string, string>;
  host?: string;
  token?: string;
  excludeEntities?: string;
}

export interface HaStateAttributes {
  device_class?: string;
  state_class?: string;
  friendly_name?: string;
  [key: string]: unknown;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: HaStateAttributes;
  last_changed: string;
}

export interface HaEventMessage {
  type: string;
  id?: number;
  event?: {
    event_type: string;
    data: {
      entity_id: string;
      new_state: HaState | null;
    };
  };
}
