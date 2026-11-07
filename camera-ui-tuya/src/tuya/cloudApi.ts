import { createHash } from 'node:crypto';

import { CAMERA_CATEGORIES } from './types.js';

import type { Device } from './types.js';

interface BaseResponse {
  t: number;
  success: boolean;
  msg?: string;
}

interface TokenResponse extends BaseResponse {
  result: Token;
}

interface Token {
  uid: string;
  access_token: string;
  refresh_token: string;
  expire_time: number;
}

interface DeviceListResponse extends BaseResponse {
  result: CloudDevice[];
}

interface DeviceStatus {
  code: string;
  value: any;
}

interface CloudDevice {
  active_time: number;
  biz_type: number;
  category: string;
  create_time: number;
  icon: string;
  id: string;
  ip: string;
  lat: string;
  local_key: string;
  lon: string;
  model: string;
  name: string;
  online: boolean;
  owner_id: string;
  product_id: string;
  product_name: string;
  status: DeviceStatus[];
  sub: boolean;
  time_zone: string;
  uid: string;
  update_time: number;
  uuid: string;
}

export class TuyaCloudApiClient {
  private baseUrl: string;
  private uid: string;
  private clientId: string;
  private clientSecret: string;
  private accessToken: string;
  private refreshToken: string;
  private refreshingToken: boolean;
  private expireTime = 0;

  constructor(baseUrl: string, uid: string, clientId: string, clientSecret: string) {
    this.baseUrl = baseUrl;
    this.uid = uid;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.accessToken = '';
    this.refreshToken = '';
    this.refreshingToken = false;
  }

  public async login(): Promise<void> {
    if (this.refreshingToken) {
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    if (this.expireTime - 60 > now) {
      return;
    }

    this.refreshingToken = true;

    const url = `https://${this.baseUrl}/v1.0/token?grant_type=1`;

    this.accessToken = '';
    this.refreshToken = '';

    try {
      const response = await this.request<TokenResponse>('GET', url, null);

      if (!response.success) {
        throw new Error(response.msg ?? 'Failed to get token');
      }

      this.accessToken = response.result.access_token;
      this.refreshToken = response.result.refresh_token;
      this.expireTime = response.t + response.result.expire_time; // seconds since epoch
    } finally {
      this.refreshingToken = false;
    }
  }

  public async getDevices(): Promise<Device[]> {
    const url = `https://${this.baseUrl}/v1.0/users/${this.uid}/devices`;
    const response = await this.request<DeviceListResponse>('GET', url, null);

    if (!response.success) {
      throw new Error(response.msg ?? 'Failed to get devices');
    }

    return response.result
      .filter((device) => CAMERA_CATEGORIES.has(device.category))
      .map((device) => ({
        category: device.category,
        deviceId: device.id,
        deviceName: device.name,
        p2pType: 4,
        productId: device.product_id,
        supportCloudStorage: false,
        uuid: device.uuid,
        type: 'cloud',
      }));
  }

  private async request<T = any>(method: string, url: string, body: any): Promise<T> {
    const ts = Date.now();
    const sign = this.calBusinessSign(ts);

    const headers: Record<string, string> = {
      Accept: '*/*',
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      mode: 'no-cors',
      client_id: this.clientId,
      access_token: this.accessToken,
      sign: sign,
      t: ts.toString(),
    };

    const requestInit: RequestInit = {
      method,
      headers,
    };

    if (body !== null) {
      requestInit.body = JSON.stringify(body);
    }

    const response = await fetch(url, requestInit);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return (await response.json()) as Promise<T>;
  }

  private calBusinessSign(ts: number): string {
    const data = `${this.clientId}${this.accessToken}${this.clientSecret}${ts}`;
    const hash = createHash('md5').update(data).digest('hex');
    return hash.toUpperCase();
  }
}
