import WebSocket from 'ws';

import type { LoggerService } from '@camera.ui/sdk';
import type { HaEventMessage, HaState } from './types.js';

const PING_INTERVAL_MS = 30_000;
const PONG_TIMEOUT_MS = 10_000;
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

export function resolveTarget(options: HaClientOptions): HaConnectionTarget | undefined {
  const supervisorToken = process.env.SUPERVISOR_TOKEN;
  if (supervisorToken) {
    return { apiUrl: 'http://supervisor/core/api', wsUrl: 'ws://supervisor/core/websocket', token: supervisorToken };
  }

  if (!options.host || !options.token) return undefined;

  let host = options.host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(host)) host = `http://${host}`;
  const wsUrl = `${host.replace(/^http/, 'ws')}/api/websocket`;
  return { apiUrl: `${host}/api`, wsUrl, token: options.token };
}

export class HaClient {
  private ws?: WebSocket;
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
    private readonly onStateChanged: (entityId: string, state: HaState | null) => void,
    private readonly onConnected: () => void,
  ) {}

  public async fetchStates(): Promise<HaState[]> {
    const response = await this.request('/states');
    return (await response.json()) as HaState[];
  }

  public async renderTemplate(template: string): Promise<string> {
    const response = await this.request('/template', { template });
    return response.text();
  }

  public async callService(domain: string, service: string, data: Record<string, unknown>): Promise<void> {
    await this.request(`/services/${domain}/${service}`, data);
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
      let message: HaEventMessage;
      try {
        message = JSON.parse(raw.toString()) as HaEventMessage;
      } catch {
        return;
      }

      if (message.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: this.target.token }));
        return;
      }
      if (message.type === 'auth_invalid') {
        this.logger.error('Home Assistant rejected the access token');
        this.stop();
        return;
      }
      if (message.type === 'auth_ok') {
        this.reconnectDelay = RECONNECT_MIN_MS;
        this.failureLogged = false;
        this.logger.log(`Connected to Home Assistant (${this.target.apiUrl.replace(/\/api$/, '')})`);
        ws.send(JSON.stringify({ id: this.messageId++, type: 'subscribe_events', event_type: 'state_changed' }));
        this.startPing(ws);
        this.onConnected();
        return;
      }
      if (message.type === 'pong') {
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = undefined;
        }
        return;
      }
      if (message.type === 'event' && message.event?.event_type === 'state_changed') {
        this.onStateChanged(message.event.data.entity_id, message.event.data.new_state);
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
      this.clearTimers();
      if (this.ws === ws) this.ws = undefined;
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
