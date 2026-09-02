import WebSocket from 'ws';

import type { LoggerService } from '@camera.ui/sdk';
import type { HaArea, HaDevice, HaMessage, HaPanel, HaRegistryEntry, HaRegistryEvent, HaState } from './types.js';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 15_000;
const RECONNECT_MIN_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

export interface HaClientOptions {
  host?: string;
  token?: string;
}

export interface HaConnectionTarget {
  apiUrl: string;
  wsUrl: string;
  token: string;
}

export interface HaClientEvents {
  onStateChanged: (entityId: string, state: HaState | null) => void;
  onRegistryUpdated: (event: HaRegistryEvent) => void;
  onConnected: () => void;
  onDisconnected: () => void;
}

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export function resolveTarget(options: HaClientOptions): HaConnectionTarget | undefined {
  if (options.host && options.token) {
    let host = options.host.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//.test(host)) host = `http://${host}`;
    const wsUrl = `${host.replace(/^http/, 'ws')}/api/websocket`;
    return { apiUrl: `${host}/api`, wsUrl, token: options.token };
  }

  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  if (supervisorToken) {
    return { apiUrl: 'http://supervisor/core/api', wsUrl: 'ws://supervisor/core/websocket', token: supervisorToken };
  }

  return undefined;
}

export class HaClient {
  private ws?: WebSocket;
  private authenticated = false;
  private pending = new Map<number, PendingCommand>();
  private pingTimer?: NodeJS.Timeout;
  private pongTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelay = RECONNECT_MIN_MS;
  private messageId = 1;
  private stopped = false;
  private failureLogged = false;

  constructor(
    private readonly target: HaConnectionTarget,
    private readonly logger: LoggerService,
    private readonly events: HaClientEvents,
  ) {}

  get connected(): boolean {
    return this.authenticated && this.ws?.readyState === WebSocket.OPEN;
  }

  public async fetchStates(): Promise<HaState[]> {
    const response = await this.request('/states');
    return (await response.json()) as HaState[];
  }

  public async fetchEntityRegistry(): Promise<HaRegistryEntry[]> {
    return this.command<HaRegistryEntry[]>('config/entity_registry/list');
  }

  public async fetchAreaRegistry(): Promise<HaArea[]> {
    return this.command<HaArea[]>('config/area_registry/list');
  }

  public async fetchDeviceRegistry(): Promise<HaDevice[]> {
    return this.command<HaDevice[]>('config/device_registry/list');
  }

  public async fetchPanels(): Promise<Record<string, HaPanel>> {
    return this.command<Record<string, HaPanel>>('get_panels');
  }

  public async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    await this.request(`/services/${domain}/${service}`, data);
  }

  public async fetchNotifyServices(): Promise<string[]> {
    const response = await this.request('/services');
    const domains = (await response.json()) as { domain: string; services: Record<string, unknown> }[];
    return Object.keys(domains.find((entry) => entry.domain === 'notify')?.services ?? {})
      .filter((service) => service !== 'send_message') // entity service, needs an entity_id to be callable
      .sort();
  }

  public connect(): void {
    this.stopped = false;
    this.openSocket();
  }

  public stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.ws?.close();
    this.ws = undefined;
    this.authenticated = false;
    this.rejectPending(new Error('Home Assistant client stopped'));
  }

  private command<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    const ws = this.ws;
    if (!ws || !this.connected) {
      return Promise.reject(new Error('Home Assistant websocket not connected'));
    }

    const id = this.messageId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Home Assistant ${type} timed out`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
      ws.send(JSON.stringify({ id, type, ...payload }));
    });
  }

  private settleCommand(message: HaMessage): void {
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.success) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(`Home Assistant command failed: ${message.error?.message ?? message.error?.code ?? 'unknown error'}`));
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async request(path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.target.apiUrl}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.target.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Home Assistant ${path} failed: ${response.status} ${response.statusText}`);
    }
    return response;
  }

  private openSocket(): void {
    if (this.stopped) return;

    const ws = new WebSocket(this.target.wsUrl);
    this.ws = ws;

    ws.on('message', (raw: Buffer) => {
      let message: HaMessage;
      try {
        message = JSON.parse(raw.toString()) as HaMessage;
      } catch {
        return;
      }

      if (message.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.target.token }));
        return;
      }
      if (message.type === 'auth_invalid') {
        if (this.target.apiUrl.startsWith('http://supervisor')) {
          this.logger.error('Home Assistant rejected the supervisor token. Update the camera.ui add-on, older versions lack the Home Assistant API permission.');
        } else {
          this.logger.error('Home Assistant rejected the access token');
        }
        this.stop();
        return;
      }
      if (message.type === 'auth_ok') {
        this.authenticated = true;
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.failureLogged = false;
        this.logger.log(`Connected to Home Assistant (${this.target.apiUrl.replace(/\/api$/, '')})`);
        ws.send(JSON.stringify({ id: this.messageId++, type: 'subscribe_events', event_type: 'state_changed' }));
        ws.send(JSON.stringify({ id: this.messageId++, type: 'subscribe_events', event_type: 'entity_registry_updated' }));
        this.startPing(ws);
        this.events.onConnected();
        return;
      }
      if (message.type === 'pong') {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = undefined;
        }
        return;
      }
      if (message.type === 'result') {
        this.settleCommand(message);
        return;
      }
      if (message.type === 'event' && message.event) {
        if (message.event.event_type === 'state_changed') {
          this.events.onStateChanged(message.event.data.entity_id, message.event.data.new_state);
        } else if (message.event.event_type === 'entity_registry_updated') {
          this.events.onRegistryUpdated(message.event.data);
        }
      }
    });

    ws.on('error', (error: Error) => {
      // one visible line per down-phase, the reconnect loop stays on debug
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.logger.warn(`Home Assistant not reachable at ${this.target.wsUrl}: ${error.message}`);
      } else {
        this.logger.debug(`Home Assistant websocket error: ${error.message}`);
      }
    });

    ws.on('close', () => {
      const wasConnected = this.authenticated;
      this.authenticated = false;
      this.clearTimers();
      this.rejectPending(new Error('Home Assistant websocket closed'));
      if (this.ws === ws) this.ws = undefined;
      if (wasConnected) this.events.onDisconnected();
      this.scheduleReconnect();
    });
  }

  private startPing(ws: WebSocket): void {
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ id: this.messageId++, type: 'ping' }));
      this.pongTimer ??= setTimeout(() => {
        this.logger.debug('Home Assistant websocket stale, reconnecting');
        ws.close();
      }, PONG_TIMEOUT_MS);
    }, PING_INTERVAL_MS);
  }

  private clearTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = undefined;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.logger.debug(`Home Assistant disconnected, reconnecting in ${Math.round(this.reconnectDelay / 1000)}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.openSocket();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }
}
