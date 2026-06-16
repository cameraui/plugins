import { API_EVENT, BasePlugin } from '@camera.ui/sdk';
import { simpleParser } from 'mailparser';
import * as smtp from 'smtp-server';

import { SMTPMotionSensor } from './sensor.js';

import type { CameraDevice, DeviceStorage, JsonSchema, LoggerService, PluginAPI } from '@camera.ui/sdk';
import type { ParsedMail } from 'mailparser';
import type { SMTPServer } from 'smtp-server';
import type { StorageValues } from './types.js';

interface CameraEntry {
  camera: CameraDevice;
  sensor: SMTPMotionSensor;
}

export default class SMTPPlugin extends BasePlugin<StorageValues> {
  private cameras = new Map<string, CameraEntry>();
  private server?: SMTPServer;

  constructor(logger: LoggerService, api: PluginAPI, storage: DeviceStorage<StorageValues>) {
    super(logger, api, storage);

    // this.api.on(API_EVENT.FINISH_LAUNCHING, this.start.bind(this));
    this.api.on(API_EVENT.SHUTDOWN, this.stop.bind(this));

    this.createSMTPServer();
  }

  get storageSchema(): JsonSchema[] {
    return [
      {
        type: 'number',
        key: 'port',
        title: 'Port',
        description: 'SMTP server port',
        defaultValue: 25,
        required: true,
        store: true,
        onSet: async () => {
          this.logger.log('SMTP port updated, restarting server...');
          this.createSMTPServer();
        },
      },
      {
        type: 'boolean',
        key: 'tls',
        title: 'Disable TLS',
        description: "Disable STARTTLS (use for cameras that don't support TLS)",
        required: true,
        store: true,
        defaultValue: false,
        onSet: async () => {
          this.logger.log('SMTP TLS setting updated, restarting server...');
          this.createSMTPServer();
        },
      },
    ];
  }

  public async configureCameras(cameras: CameraDevice[]): Promise<void> {
    for (const camera of cameras) {
      await this.initializeCamera(camera);
    }
  }

  public async onCameraAdded(camera: CameraDevice): Promise<void> {
    await this.initializeCamera(camera);
  }

  public async onCameraReleased(cameraId: string): Promise<void> {
    const entry = this.cameras.get(cameraId);
    if (entry) {
      this.cameras.delete(cameraId);
    }
  }

  private stop(): void {
    this.server?.close();
    this.cameras.clear();
  }

  private async initializeCamera(camera: CameraDevice): Promise<void> {
    // Create and register the motion sensor
    const sensor = new SMTPMotionSensor();
    await camera.addSensor(sensor);

    this.cameras.set(camera.id, { camera, sensor });

    if (sensor.email) {
      camera.logger.log('SMTP motion sensor ready, listening for:', sensor.email);
    } else {
      camera.logger.attention('Please configure the SMTP email address in sensor settings');
    }
  }

  private createSMTPServer() {
    this.logger.log('Creating SMTP server...');

    this.server?.close();
    this.server = new smtp.SMTPServer({
      allowInsecureAuth: true,
      authOptional: true,
      logger: false,
      disabledCommands: this.storage.values.tls ? ['STARTTLS'] : undefined,
      onConnect: (_session, callback) => {
        callback();
      },
      onAuth: (_auth, _session, callback) => {
        callback(null, { user: 'camera.ui' });
      },
      onMailFrom: (_address, _session, callback) => {
        callback();
      },
      onRcptTo: (_address, _session, callback) => {
        callback();
      },
      onData: async (stream, _session, callback) => {
        try {
          const parsed = await simpleParser(stream);
          this.handleMail(parsed);
        } catch (error) {
          this.logger.error('Error parsing mail', error);
        }
        callback();
      },
    });

    this.server.on('error', (e) => this.logger.error('SMTP Error', e));
    const port = this.storage.values.port;
    this.server.listen(port, '0.0.0.0');
    this.logger.log(`SMTP server listening on port ${port}`);
  }

  private handleMail(parsed: ParsedMail): void {
    const toAddresses = parsed.to instanceof Array ? parsed.to : [parsed.to];

    for (const addresses of toAddresses) {
      if (!addresses) continue;

      for (const address of addresses.value) {
        // Find all cameras with sensors configured for this email
        const matchingEntries = Array.from(this.cameras.values()).filter((entry) => entry.sensor.email === address.address);

        if (matchingEntries.length === 0) {
          this.logger.debug('No camera configured for email:', address.address);
          continue;
        }

        for (const { sensor } of matchingEntries) {
          const { onText, offText } = sensor;

          // Check for motion on pattern (or trigger if no pattern specified)
          if (!onText || parsed.text?.includes(onText)) {
            sensor.reportDetections(true);
          }

          // Check for motion off pattern
          if (offText && parsed.text?.includes(offText)) {
            sensor.reportDetections(false);
          }
        }
      }
    }
  }
}
