import type { StoredNotifierDevice } from './notifier.js';

export interface StorageValues {
  debug?: boolean;
  notifierDevices?: StoredNotifierDevice[];
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
