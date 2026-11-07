import { constants, createHash, publicEncrypt } from 'node:crypto';

import { AVAILABLE_REGIONS, CAMERA_CATEGORIES } from './types.js';

import type { Device } from './types.js';

interface BaseResponse {
  t: number;
  success: boolean;
  errorMsg?: string;
}

export interface LoginTokenRequest {
  countryCode: string;
  username: string;
  isUid: boolean;
}

export interface LoginTokenResponse extends BaseResponse {
  result: LoginToken;
}

export interface LoginToken {
  token: string;
  exponent: string;
  publicKey: string;
  pbKey: string;
}

export interface PasswordLoginRequest {
  countryCode: string;
  email?: string;
  mobile?: string;
  passwd: string;
  token: string;
  ifencrypt: number;
  options: string;
}

export interface PasswordLoginResponse extends BaseResponse {
  result: LoginResult;
}

export interface LoginResult {
  attribute: number;
  clientId: string;
  dataVersion: number;
  domain: Domain;
  ecode: string;
  email: string;
  extras: Extras;
  headPic: string;
  improveCompanyInfo: boolean;
  nickname: string;
  partnerIdentity: string;
  phoneCode: string;
  receiver: string;
  regFrom: number;
  sid: string;
  snsNickname: string;
  tempUnit: number;
  timezone: string;
  timezoneId: string;
  uid: string;
  userType: number;
  username: string;
}

export interface Domain {
  aispeechHttpsUrl: string;
  aispeechQuicUrl: string;
  deviceHttpUrl: string;
  deviceHttpsPskUrl: string;
  deviceHttpsUrl: string;
  deviceMediaMqttUrl: string;
  deviceMediaMqttsUrl: string;
  deviceMqttsPskUrl: string;
  deviceMqttsUrl: string;
  gwApiUrl: string;
  gwMqttUrl: string;
  httpPort: number;
  httpsPort: number;
  httpsPskPort: number;
  mobileApiUrl: string;
  mobileMediaMqttUrl: string;
  mobileMqttUrl: string;
  mobileMqttsUrl: string;
  mobileQuicUrl: string;
  mqttPort: number;
  mqttQuicUrl: string;
  mqttsPort: number;
  mqttsPskPort: number;
  regionCode: string;
}

export interface Extras {
  homeId: string;
  sceneType: string;
}

export interface AppInfoResponse extends BaseResponse {
  result: AppInfo;
}

export interface AppInfo {
  appId: number;
  appName: string;
  clientId: string;
  icon: string;
}

export interface HomeListResponse extends BaseResponse {
  result: Home[];
}

export interface SharedHomeListResponse extends BaseResponse {
  result: SharedHome;
}

export interface SharedHome {
  securityWebCShareInfoList: {
    deviceInfoList: SmartDevice[];
    nickname: string;
    username: string;
  }[];
}

export interface Home {
  admin: boolean;
  background: string;
  dealStatus: number;
  displayOrder: number;
  geoName: string;
  gid: number;
  gmtCreate: number;
  gmtModified: number;
  groupId: number;
  groupUserId: number;
  id: number;
  lat: number;
  lon: number;
  managementStatus: boolean;
  name: string;
  ownerId: string;
  role: number;
  status: boolean;
  uid: string;
}

export interface RoomListRequest {
  homeId: string;
}

export interface RoomListResponse extends BaseResponse {
  result: Room[];
}

export interface Room {
  deviceCount: number;
  deviceList: SmartDevice[];
  roomId: string;
  roomName: string;
}

export interface SmartDevice {
  category: string;
  deviceId: string;
  deviceName: string;
  p2pType: number;
  productId: string;
  supportCloudStorage: boolean;
  uuid: string;
}

export class TuyaSmartApiClient {
  private email: string;
  private password: string;
  private countryCode: string;
  private baseUrl: string;
  public sid?: string;
  public cookies = new Map<string, string>();

  constructor(baseUrl: string, email: string, password: string) {
    const region = AVAILABLE_REGIONS.find((r) => r.host === baseUrl);
    if (!region) {
      throw new Error(`Invalid region: ${baseUrl}`);
    }

    this.baseUrl = baseUrl;
    this.email = email;
    this.password = password;
    this.countryCode = region.continent;
  }

  public async login(): Promise<{
    token: LoginToken;
    login: LoginResult;
  }> {
    const tokenReq: LoginTokenRequest = {
      countryCode: this.countryCode,
      username: this.email,
      isUid: false,
    };

    const tokenUrl = `https://${this.baseUrl}/api/login/token`;
    const tokenResp = await this.request<LoginTokenResponse>('POST', tokenUrl, tokenReq);

    if (!tokenResp.success) {
      throw new Error(tokenResp.errorMsg ?? 'Failed to get login token');
    }

    const encryptedPassword = this.encryptPassword(this.password, tokenResp.result.pbKey);

    const loginReq: PasswordLoginRequest = {
      countryCode: this.countryCode,
      email: this.email,
      passwd: encryptedPassword,
      token: tokenResp.result.token,
      ifencrypt: 1,
      options: '{"group":1}',
    };

    const loginUrl = `https://${this.baseUrl}/api/private/email/login`;
    const loginResp = await this.request<PasswordLoginResponse>('POST', loginUrl, loginReq);

    if (!loginResp.success) {
      throw new Error(loginResp.errorMsg ?? 'Login failed');
    }

    this.sid = loginResp.result.sid;

    return {
      token: tokenResp.result,
      login: loginResp.result,
    };
  }

  public async getAppInfo(): Promise<AppInfoResponse> {
    const url = `https://${this.baseUrl}/api/customized/web/app/info`;
    const response = await this.request<AppInfoResponse>('POST', url);

    if (!response.success) {
      throw new Error(response.errorMsg ?? 'Failed to get app info');
    }

    return response;
  }

  public async getHomeList(): Promise<HomeListResponse> {
    const url = `https://${this.baseUrl}/api/new/common/homeList`;
    const response = await this.request<HomeListResponse>('POST', url);

    if (!response.success) {
      throw new Error(response.errorMsg ?? 'Failed to get home list');
    }

    return response;
  }

  public async getSharedHomeList(): Promise<SharedHomeListResponse> {
    const url = `https://${this.baseUrl}/api/new/playback/shareList`;
    const response = await this.request<SharedHomeListResponse>('POST', url);

    if (!response.success) {
      throw new Error(response.errorMsg ?? 'Failed to get shared home list');
    }

    return response;
  }

  public async getRoomList(homeId: string): Promise<RoomListResponse> {
    const url = `https://${this.baseUrl}/api/new/common/roomList`;
    const data: RoomListRequest = { homeId };
    const response = await this.request<RoomListResponse>('POST', url, data);

    if (!response.success) {
      throw new Error(response.errorMsg ?? 'Failed to get room list');
    }

    return response;
  }

  public async getDeviceList(): Promise<Device[]> {
    const devices: SmartDevice[] = [];

    const homes = await this.getHomeList();
    for (const home of homes.result) {
      const rooms = await this.getRoomList(home.gid.toString());
      for (const room of rooms.result) {
        for (const device of room.deviceList) {
          if (CAMERA_CATEGORIES.has(device.category) && !this.containsDevice(devices, device.deviceId)) {
            devices.push(device);
          }
        }
      }
    }

    const sharedHomes = await this.getSharedHomeList();
    if (Array.isArray(sharedHomes.result.securityWebCShareInfoList)) {
      for (const sharedHome of sharedHomes.result.securityWebCShareInfoList) {
        for (const device of sharedHome.deviceInfoList) {
          if (CAMERA_CATEGORIES.has(device.category) && !this.containsDevice(devices, device.deviceId)) {
            devices.push(device);
          }
        }
      }
    }

    return devices.map((device) => ({
      ...device,
      type: 'smart',
    }));
  }

  private async request<T>(method: string, url: string, body?: any, customHeaders?: Record<string, string>): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...customHeaders,
    };

    if (this.cookies.size > 0) {
      const cookieString = Array.from(this.cookies.entries())
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
      headers.Cookie = cookieString;
    }

    const options: RequestInit = {
      method,
      headers,
    };

    if (body && (method === 'POST' || method === 'PUT')) {
      options.body = JSON.stringify(body);
    } else {
      const urlObj = new URL(url);
      if (body) {
        Object.entries(body).forEach(([key, value]) => {
          urlObj.searchParams.append(key, (value as any).toString());
        });
      }
      url = urlObj.toString();
    }

    const response = await fetch(url, options);

    const setCookieHeader = response.headers.get('set-cookie');
    if (setCookieHeader) {
      this.parseCookies(setCookieHeader);
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    const data = await response.json();
    return data as T;
  }

  private parseCookies(setCookieHeader: string): void {
    const cookies = setCookieHeader.split(',').map((cookie) => cookie.trim());

    for (const cookie of cookies) {
      const parts = cookie.split(';')[0].split('=');
      if (parts.length === 2) {
        const name = parts[0].trim();
        const value = parts[1].trim();
        this.cookies.set(name, value);
      }
    }
  }

  private encryptPassword(password: string, pbKey: string): string {
    const hashedPassword = createHash('md5').update(password).digest('hex');
    const pemKey = `-----BEGIN PUBLIC KEY-----\n${pbKey}\n-----END PUBLIC KEY-----`;

    const encrypted = publicEncrypt(
      {
        key: pemKey,
        padding: constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(hashedPassword),
    );

    return encrypted.toString('hex');
  }

  private containsDevice(devices: SmartDevice[], deviceID: string): boolean {
    for (const device of devices) {
      if (device.deviceId === deviceID) {
        return true;
      }
    }
    return false;
  }
}
