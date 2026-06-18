import { PropertyName } from 'eufy-security-client';
import fs from 'fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'os';

import type { Camera } from 'eufy-security-client';
import type { Server, Socket } from 'net';

export class Deferred<T> {
  finished = false;
  resolve!: (value: T | PromiseLike<T>) => this;
  reject!: (error: Error) => this;
  promise = new Promise<T>((resolve, reject) => {
    this.resolve = (v) => {
      this.finished = true;
      resolve(v);
      return this;
    };
    this.reject = (e) => {
      this.finished = true;
      reject(e);
      return this;
    };
  });
}

export class UniversalStream {
  public url: string;
  private static socks = new Set<number>();
  private server: Server;
  private sock_id: number;
  private isWin32 = false;
  private readonly startTime = Date.now();

  private constructor(namespace: string, onSocket: ((socket: Socket) => void) | undefined) {
    this.isWin32 = process.platform === 'win32'; // Cache platform check

    const unique_sock_id = Math.min(...Array.from({ length: 100 }, (_, i) => i + 1).filter((i) => !UniversalStream.socks.has(i)));
    UniversalStream.socks.add(unique_sock_id);
    this.sock_id = unique_sock_id;

    const sockpath = this.generateSockPath(namespace, unique_sock_id);
    this.url = this.generateUrl(sockpath);

    this.server = createServer(onSocket)
      .on('error', () => {
        this.close();
      })
      .listen(sockpath);
  }

  private generateSockPath(namespace: string, unique_sock_id: number): string {
    let sockpath = '';
    const pipeName = `${namespace}.${unique_sock_id}.sock`; // Use template literals

    if (this.isWin32) {
      const pipePrefix = '\\\\.\\pipe\\';
      sockpath = join(pipePrefix, pipeName);
    } else {
      sockpath = join(tmpdir(), pipeName);

      // Use async file operations
      if (fs.existsSync(sockpath)) {
        fs.unlinkSync(sockpath);
      }
    }

    return sockpath;
  }

  private generateUrl(sockpath: string): string {
    return this.isWin32 ? sockpath : `unix:${sockpath}`; // Use template literals
  }

  public close(): void {
    try {
      if (this.server) {
        this.server.close();
      }
    } catch {
      //
    } finally {
      if (!this.isWin32 && this.url) {
        try {
          fs.unlinkSync(this.url.replace('unix:', ''));
        } catch {
          //
        }
      }
      UniversalStream.socks.delete(this.sock_id);
    }
  }

  public static StreamInput(namespace: string, stream: NodeJS.ReadableStream): UniversalStream {
    return new UniversalStream(namespace, (socket: Socket) => stream.pipe(socket, { end: true }));
  }

  public static StreamOutput(namespace: string, stream: NodeJS.WritableStream): UniversalStream {
    return new UniversalStream(namespace, (socket: Socket) => socket.pipe(stream, { end: true }));
  }
}

export const is_rtsp_ready = function (device: Camera): boolean {
  if (!device.hasProperty('rtspStream')) {
    return false;
  }

  if (!device.getPropertyValue(PropertyName.DeviceRTSPStream)) {
    return false;
  }

  if (device.getPropertyValue(PropertyName.DeviceRTSPStreamUrl) === '') {
    return false;
  }

  return true;
};
