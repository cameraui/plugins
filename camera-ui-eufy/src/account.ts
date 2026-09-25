import { EufyMega, FileFcmStore, FileSessionStore } from '@mega-yfue/eufy-sdk';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { getCountryCode } from './utils.js';

import type { LoggerService } from '@camera.ui/sdk';
import type { Device, EufyDevice, Logger, LoginResult } from '@mega-yfue/eufy-sdk';

export interface AccountCredentials {
  email: string;
  password: string;
  country?: string;
}

export class EufyAccount {
  public readonly client: EufyMega;

  private readonly devices = new Map<string, Device>();
  private readonly loading = new Map<string, Promise<Device>>();
  private readonly sessionStore: FileSessionStore;
  private readonly fcmStore: FileFcmStore;

  constructor(
    public readonly credentials: AccountCredentials,
    storagePath: string,
    logger: LoggerService,
    debug: boolean,
    ffmpegPath?: string,
  ) {
    const dir = join(storagePath, 'eufy', hash(credentials.email.toLowerCase()).slice(0, 12));
    mkdirSync(dir, { recursive: true });

    this.sessionStore = new FileSessionStore(join(dir, 'session.json'));
    this.fcmStore = new FileFcmStore(join(dir, 'push.json'));

    this.client = new EufyMega({
      email: credentials.email,
      password: credentials.password,
      countryCode: getCountryCode(credentials.country),
      // the sdk default derives the id from the email alone, a second integration on the account would evict this one
      openudid: hash(`camera.ui:${credentials.email.toLowerCase()}`).slice(0, 16),
      store: this.sessionStore,
      pushStore: this.fcmStore,
      logger: createLogger(logger, debug),
      ffmpegPath,
    });

    this.client.on('error', (error) => logger.warn(`Eufy: ${error.message}`));
  }

  public get key(): string {
    return accountKey(this.credentials);
  }

  public login(): Promise<LoginResult> {
    return this.client.login();
  }

  public solveCaptcha(answer: string): Promise<LoginResult> {
    return this.client.solveCaptcha(answer);
  }

  public submitVerifyCode(code: string): Promise<LoginResult> {
    return this.client.submitVerifyCode(code);
  }

  public listDevices(): Promise<EufyDevice[]> {
    return this.client.getDevices();
  }

  public cachedDevice(sn: string): Device | undefined {
    return this.devices.get(sn);
  }

  public async getDevice(sn: string): Promise<Device> {
    const cached = this.devices.get(sn);
    if (cached) return cached;

    let loading = this.loading.get(sn);
    if (!loading) {
      loading = this.client.getDevice(sn).then((device) => {
        this.devices.set(sn, device);
        return device;
      });
      loading.finally(() => this.loading.delete(sn)).catch(() => undefined);
      this.loading.set(sn, loading);
    }
    return loading;
  }

  public forgetDevice(sn: string): void {
    this.devices.delete(sn);
  }

  public async dispose(): Promise<void> {
    this.devices.clear();
    await this.client.disconnect();
  }

  public async logout(): Promise<void> {
    this.devices.clear();
    try {
      await this.client.logout();
    } finally {
      this.sessionStore.clear();
      this.fcmStore.clear();
    }
  }
}

export function accountKey(credentials: AccountCredentials): string {
  return [credentials.email.toLowerCase(), credentials.password, getCountryCode(credentials.country)].join('\0');
}

export function isCameraRecord(record: EufyDevice): boolean {
  return record.deviceClass === 'camera';
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function createLogger(logger: LoggerService, debug: boolean): Logger {
  return {
    debug: (message, ...args) => {
      if (debug) logger.debug(message, ...args);
    },
    info: (message, ...args) => {
      if (debug) logger.log(message, ...args);
    },
    warn: (message, ...args) => logger.warn(message, ...args),
    error: (message, ...args) => logger.error(message, ...args),
  };
}
