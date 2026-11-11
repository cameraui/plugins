import type { SmartDevice } from './smartApi.js';

export interface Region {
  name: string;
  host: string;
  cloudHost: string;
  description: string;
  continent: string;
}

export const AVAILABLE_REGIONS: Region[] = [
  { name: 'eu-central', host: 'protect-eu.ismartlife.me', cloudHost: 'openapi.tuyaeu.com', description: 'Central Europe', continent: 'EU' },
  { name: 'eu-west', host: 'protect-we.ismartlife.me', cloudHost: 'openapi-weaz.tuyaeu.com', description: 'Western Europe', continent: 'EU' },
  { name: 'us-west', host: 'protect-us.ismartlife.me', cloudHost: 'openapi.tuyaus.com', description: 'West America', continent: 'AZ' },
  { name: 'us-east', host: 'protect-ue.ismartlife.me', cloudHost: 'openapi-ueaz.tuyaus.com', description: 'East America', continent: 'AZ' },
  { name: 'china', host: 'protect.ismartlife.me', cloudHost: 'openapi.tuyacn.com', description: 'China', continent: 'AY' },
  { name: 'india', host: 'protect-in.ismartlife.me', cloudHost: 'openapi.tuyain.com', description: 'India', continent: 'IN' },
  { name: 'singapore', host: 'protect-sg.ismartlife.me', cloudHost: 'openapi-sg.iotbing.com', description: 'Singapore', continent: 'SG' },
];

export const CAMERA_CATEGORIES = new Set(['sp', 'dghsxj', 'cdsxj']);

export interface Device extends SmartDevice {
  type: 'smart' | 'cloud';
}
