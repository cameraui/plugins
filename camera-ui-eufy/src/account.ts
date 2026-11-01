import { EufyMega, FileFcmStore, FileSessionStore, MODEL_REGISTRY } from '@mega-yfue/eufy-sdk';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessage, getCountryCode } from './utils.js';

import type { DeviceStorage, LoggerService } from '@camera.ui/sdk';
import type { Device, EufyDevice, Logger, LoginResult, PersistedSession, SessionStore } from '@mega-yfue/eufy-sdk';
import type { StorageValues, StoredSession } from './types.js';

export interface AccountCredentials {
  email: string;
  password: string;
  country?: string;
}

export class EufyAccount {
  public readonly client: EufyMega;

  private readonly devices = new Map<string, Device>();
  private readonly loading = new Map<string, Promise<Device>>();
  private readonly sessionStore: ConfigSessionStore;
  private readonly fcmStore: FileFcmStore;

  constructor(
    public readonly credentials: AccountCredentials,
    storagePath: string,
    storage: DeviceStorage<StorageValues>,
    logger: LoggerService,
    debug: boolean,
    ffmpegPath?: string,
  ) {
    const id = hash(credentials.email.toLowerCase()).slice(0, 12);
    const dir = join(storagePath, 'eufy', id);
    mkdirSync(dir, { recursive: true });

    this.sessionStore = new ConfigSessionStore(storage, id, new FileSessionStore(join(dir, 'session.json')), logger);
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

class ConfigSessionStore implements SessionStore {
  constructor(
    private storage: DeviceStorage<StorageValues>,
    private account: string,
    private legacy: FileSessionStore,
    private logger: LoggerService,
  ) {}

  public load(): PersistedSession | null {
    const saved = this.storage.values.session;
    if (saved?.account === this.account) return saved.session;

    const legacy = this.legacy.load();
    if (legacy) {
      this.save(legacy);
      this.legacy.clear();
    }
    return legacy;
  }

  public save(session: PersistedSession): void {
    this.write({ account: this.account, session });
  }

  public clear(): void {
    this.write(undefined);
  }

  private write(value: StoredSession | undefined): void {
    this.storage.setInternalValue('session', value).catch((error) => this.logger.warn(`Eufy: could not save the session: ${errorMessage(error)}`));
  }
}

export function accountKey(credentials: AccountCredentials): string {
  return [credentials.email.toLowerCase(), credentials.password, getCountryCode(credentials.country)].join('\0');
}

export function isCameraRecord(record: EufyDevice): boolean {
  // a video lock keeps its lock class and streams through its camera capability
  return record.deviceClass === 'camera' || MODEL_REGISTRY[record.model.trim().toUpperCase()]?.caps?.includes('camera') === true;
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
