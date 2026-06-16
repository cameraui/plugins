export interface RingHome {
  name: string;
  email: string;
  password: string;
  polling?: boolean;
  token?: string;
  locationIds?: string[];
  systemId: string;
  controlCenterDisplayName: string;
}

export interface StorageValues extends RingHome {}
