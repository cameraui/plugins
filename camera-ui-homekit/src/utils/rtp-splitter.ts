import { createSocket } from 'node:dgram';
import { fromEvent, merge, ReplaySubject } from 'rxjs';
import { map, share, takeUntil } from 'rxjs/operators';

import { bindToPort } from './ports.js';
import { getPayloadType, isRtpMessagePayloadType } from './rtp.js';

import type { RemoteInfo, Socket } from 'node:dgram';
import type { Observable } from 'rxjs';

export interface SocketTarget {
  port: number;
  address?: string;
}

export interface RtpMessageDescription {
  isRtpMessage: boolean;
  payloadType: number;
  info: RemoteInfo;
  message: Buffer;
}

export type RtpMessageHandler = (description: RtpMessageDescription) => SocketTarget | null;

export type RtpMessageAsyncHandler = (description: RtpMessageDescription) => Promise<SocketTarget | null>;

export class RtpSplitter {
  public socket?: Socket;
  public address?: string;
  public port?: number;
  public type?: 'udp4' | 'udp6';

  public onMessage?: Observable<{
    message: Buffer;
    info: RemoteInfo;
    isRtpMessage: boolean;
    payloadType: number;
  }>;

  private closed = false;
  private cleanedUp = false;

  private onClose = new ReplaySubject<any>();

  constructor() {}

  public async prepare(type: 'udp4' | 'udp6', address = '127.0.0.1', messageHandler?: RtpMessageHandler): Promise<void> {
    this.type = type;

    const socket = createSocket(type);
    const port = await bindToPort(socket, address);

    socket.setRecvBufferSize(1024 * 1024);
    socket.setSendBufferSize(1024 * 1024);

    this.socket = socket;
    this.address = address;
    this.port = port;

    this.onMessage = fromEvent<[Buffer, RemoteInfo]>(this.socket, 'message').pipe(
      map(([message, info]) => {
        const payloadType = getPayloadType(message);

        return {
          message,
          info,
          isRtpMessage: isRtpMessagePayloadType(payloadType),
          payloadType,
        };
      }),
      takeUntil(this.onClose),
      share(),
    );

    if (messageHandler) {
      this.addMessageHandler(messageHandler);
    }

    merge(fromEvent(this.socket, 'close'), fromEvent(this.socket, 'error'))
      .pipe(takeUntil(this.onClose))
      .subscribe(() => {
        this.cleanUp();
      });
  }

  public addMessageHandler(handler: RtpMessageHandler): void {
    this.onMessage?.subscribe((description) => {
      const forwardingTarget = handler(description);

      if (forwardingTarget) {
        this.send(description.message, forwardingTarget);
      }
    });
  }

  public addAsyncMessageHandler(handler: RtpMessageAsyncHandler): void {
    this.onMessage?.subscribe(async (description) => {
      const forwardingTarget = await handler(description);

      if (forwardingTarget) {
        await this.send(description.message, forwardingTarget);
      }
    });
  }

  public addOneTimeMessageHandler(handler: RtpMessageHandler): void {
    const subscription = this.onMessage?.subscribe((description) => {
      const forwardingTarget = handler(description);

      if (forwardingTarget) {
        this.send(description.message, forwardingTarget);
      }

      // Unsubscribe nach der ersten Ausführung
      subscription?.unsubscribe();
    });
  }

  public addOneTimeAsyncMessageHandler(handler: RtpMessageAsyncHandler): void {
    const subscription = this.onMessage?.subscribe(async (description) => {
      const forwardingTarget = await handler(description);

      if (forwardingTarget) {
        await this.send(description.message, forwardingTarget);
      }

      // Unsubscribe nach der ersten Ausführung
      subscription?.unsubscribe();
    });
  }

  public async send(message: Buffer, sendTo: SocketTarget): Promise<void> {
    if (this.closed) {
      // If we send a message on a closed socket, it will throw an ERR_SOCKET_DGRAM_NOT_RUNNING error
      return;
    }

    return new Promise<void>((resolve, reject) => {
      this.socket?.send(message, sendTo.port, sendTo.address ?? '127.0.0.1', (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  private cleanUp(): void {
    this.closed = true;

    if (this.cleanedUp) {
      return;
    }

    this.address = undefined;
    this.port = undefined;
    this.type = undefined;
    this.cleanedUp = true;
    this.onClose.next(null);
  }

  public close(): void {
    if (this.closed) {
      return;
    }

    this.socket?.close();
    this.cleanUp();
  }
}
