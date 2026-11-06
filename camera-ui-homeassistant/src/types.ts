export const IMPORT_ORIGIN = 'homeassistant';

export function importOptions(nativeId: string): { nativeId: string; origin: string } {
  return { nativeId, origin: IMPORT_ORIGIN };
}

export interface StorageValues {
  debug?: boolean;
  mutedNotifyServices?: string[];
  notifyServiceNames?: Record<string, string>;
  host?: string;
  token?: string;
  doorbellEntities?: string;
}

export interface HaStateAttributes {
  device_class?: string;
  state_class?: string;
  friendly_name?: unknown;
  supported_features?: number;
  [key: string]: unknown;
}

export interface HaState {
  entity_id: string;
  state: string;
  attributes: HaStateAttributes;
  last_changed: string;
}

export interface HaRegistryEntry {
  id: string;
  entity_id: string;
  unique_id?: string | null;
  platform?: string;
  device_id?: string | null;
  area_id?: string | null;
  name?: string | null;
  original_name?: string | null;
  translation_key?: string | null;
  entity_category?: string | null;
  disabled_by?: string | null;
}

export interface HaArea {
  area_id: string;
  name: string;
}

export interface HaDevice {
  id: string;
  area_id?: string | null;
  name?: string | null;
  name_by_user?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  sw_version?: string | null;
  hw_version?: string | null;
  serial_number?: string | null;
  identifiers?: [string, unknown][];
}

export interface Registry {
  byId: Map<string, HaRegistryEntry>;
  byEntityId: Map<string, HaRegistryEntry>;
  areas: Map<string, string>;
  devices: Map<string, HaDevice>;
  cameraDevices: Set<string>;
}

export interface HaCameraCapabilities {
  frontend_stream_types: string[];
  two_way_audio: boolean;
}

export interface HaPanel {
  component_name: string;
  url_path: string;
  config?: { _panel_custom?: { name?: string } } | null;
}

export interface HaRegistryEvent {
  action: 'create' | 'update' | 'remove';
  entity_id: string;
  old_entity_id?: string;
}

export interface HaStateEvent {
  entity_id: string;
  new_state: HaState | null;
}

export interface HaBusEvent {
  type?: unknown;
  device_id?: unknown;
  [key: string]: unknown;
}

export interface HaMessage {
  type: string;
  id?: number;
  success?: boolean;
  result?: unknown;
  error?: { code: string; message: string };
  event?:
    | { event_type: 'state_changed'; data: HaStateEvent }
    | { event_type: 'entity_registry_updated'; data: HaRegistryEvent }
    | { event_type: `${string}_event`; data: HaBusEvent };
}
