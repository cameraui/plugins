import {
  categorizeEvent,
  extractTopicPaths,
  getAllSupportedDetectionTypes,
  getSupportedDetectionTypes,
  Onvif,
  parseAudioEvent,
  parseDetectionEvent,
  parseMotionEvent,
} from '@seydx/onvif';
import { OnvifAudioSensor, OnvifFaceSensor, OnvifMotionSensor, OnvifObjectSensor, OnvifPTZSensor } from './sensors/index.js';

import type { CameraDevice, DeviceStorage, LoggerService } from '@camera.ui/sdk';
import type { EventCategory, EventProperties, NotificationMessage } from '@seydx/onvif';

export interface OnvifStorageValues {
  username: string;
  password: string;
  url: string;
}

interface OnvifCapabilities {
  hasPTZ: boolean;
  hasEvents: boolean;
  eventProperties?: EventProperties;
  advertisedTypes: EventCategory[];
}

export class OnvifCamera {
  public readonly camera: CameraDevice;
  public readonly storage: DeviceStorage<OnvifStorageValues>;

  private device?: Onvif;
  private ptzSensor?: OnvifPTZSensor;
  private motionSensor?: OnvifMotionSensor;
  private objectSensor?: OnvifObjectSensor;
  private faceSensor?: OnvifFaceSensor;
  private audioSensor?: OnvifAudioSensor;
  private dynamicCapabilities = new Set<EventCategory>();
  private eventLoopRunning = false;
  private capabilities?: OnvifCapabilities;
  private lastEventErrorMessage?: string;

  private reconnectInFlight?: Promise<void>;
  private suppressReconnect = false;

  private readonly logger: LoggerService;

  constructor(camera: CameraDevice, logger: LoggerService) {
    this.camera = camera;
    this.logger = logger;
    this.storage = this.createStorage();
  }

  async initialize(initialCredentials?: { username: string; password: string; url: string }): Promise<void> {
    if (initialCredentials) {
      this.suppressReconnect = true;
      try {
        this.storage.values.username = initialCredentials.username;
        this.storage.values.password = initialCredentials.password;
        this.storage.values.url = initialCredentials.url;
        await this.storage.save();
      } finally {
        this.suppressReconnect = false;
      }
    }

    const values = this.storage.values;
    if (!values?.username || !values?.password || !values?.url) {
      this.camera.logger.attention('Please configure the ONVIF settings');
      return;
    }

    await this.connect(values.url, values.username, values.password);
  }

  private async connect(url: string, username: string, password: string): Promise<void> {
    try {
      this.device = await this.connectToDevice(url, username, password);
      this.camera.logger.log('Connected to ONVIF device');

      this.camera.connect();

      this.capabilities = await this.detectCapabilities();
      this.camera.logger.debug(
        'ONVIF capabilities:',
        JSON.stringify({ hasPTZ: this.capabilities.hasPTZ, hasEvents: this.capabilities.hasEvents, advertisedTypes: this.capabilities.advertisedTypes }),
      );
      // if (this.capabilities.eventProperties) {
      //   this.camera.logger.trace('ONVIF event properties', JSON.stringify(this.capabilities.eventProperties, null, 2));
      // }

      if (this.capabilities.hasPTZ) {
        await this.setupPTZSensor(this.device);
      }

      if (this.capabilities.hasEvents && this.capabilities.advertisedTypes.length > 0) {
        await this.setupEventSensors();
        this.updateEventLoop();
      }
    } catch (error) {
      this.camera.logger.error('Failed to connect to ONVIF device:', error);
    }
  }

  private async setupPTZSensor(device: Onvif): Promise<void> {
    this.ptzSensor = new OnvifPTZSensor(this.camera, device);
    await this.camera.addSensor(this.ptzSensor);

    this.ptzSensor.onAssignmentChanged.subscribe((assigned) => {
      if (assigned) {
        this.ptzSensor!.initialize();
        this.camera.logger.log('PTZ sensor initialized (assignment changed)');
      }
    });

    if (this.ptzSensor.isAssigned) {
      await this.ptzSensor.initialize();
    }
  }

  async reconnect(): Promise<void> {
    if (this.suppressReconnect) return;
    if (this.reconnectInFlight) return this.reconnectInFlight;

    this.reconnectInFlight = this.doReconnect().finally(() => {
      this.reconnectInFlight = undefined;
    });
    return this.reconnectInFlight;
  }

  private async doReconnect(): Promise<void> {
    const values = this.storage.values;

    if (!values?.username || !values?.password || !values?.url) {
      this.camera.logger.warn('Cannot reconnect: missing credentials');
      return;
    }

    if (this.device) {
      this.device.events.stopEventLoop();
    }

    this.camera.logger.log('Reconnecting to ONVIF device...');
    await this.connect(values.url, values.username, values.password);
  }

  destroy(): void {
    this.stopEventLoop();
    this.logger.log('Camera removed, cleaning up:', this.camera.name);
  }

  private async setupEventSensors(): Promise<void> {
    const types = this.capabilities?.advertisedTypes ?? [];

    if (types.includes('motion')) {
      this.motionSensor = new OnvifMotionSensor(this.camera, this.topicsForTypes(['motion']));
      await this.camera.addSensor(this.motionSensor);
      this.motionSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }

    if (types.includes('person') || types.includes('vehicle') || types.includes('animal')) {
      this.objectSensor = new OnvifObjectSensor(this.camera, this.topicsForTypes(['person', 'vehicle', 'animal']));
      await this.camera.addSensor(this.objectSensor);
      this.objectSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }

    if (types.includes('face')) {
      this.faceSensor = new OnvifFaceSensor(this.camera, this.topicsForTypes(['face']));
      await this.camera.addSensor(this.faceSensor);
      this.faceSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }

    if (types.includes('audio')) {
      this.audioSensor = new OnvifAudioSensor(this.camera, this.topicsForTypes(['audio']));
      await this.camera.addSensor(this.audioSensor);
      this.audioSensor.onAssignmentChanged.subscribe(() => this.updateEventLoop());
    }
  }

  private topicsForTypes(types: EventCategory[]): string[] {
    const topicSet = this.capabilities?.eventProperties?.topicSet;
    if (!topicSet) return [];
    return extractTopicPaths(topicSet).filter((topic) => types.includes(categorizeEvent(topic)));
  }

  private updateEventLoop(): void {
    const anyAssigned = [this.motionSensor, this.objectSensor, this.faceSensor, this.audioSensor].some((s) => s?.isAssigned);

    if (anyAssigned && !this.eventLoopRunning) {
      this.startEventLoop();
    } else if (!anyAssigned && this.eventLoopRunning) {
      this.stopEventLoop();
    }
  }

  private startEventLoop(): void {
    if (!this.device || !this.capabilities || this.eventLoopRunning) return;

    this.device.events.on('event', (message: NotificationMessage) => {
      this.handleEvent(message, this.capabilities!);
    });

    this.device.events.on('error', (error: Error) => {
      if (error.message !== this.lastEventErrorMessage) {
        this.camera.logger.warn('ONVIF event error:', error.message);
        this.lastEventErrorMessage = error.message;
      } else {
        this.camera.logger.trace('ONVIF event error (repeated):', error.message);
      }
    });

    this.device.events.on('pull', () => {
      if (this.lastEventErrorMessage) {
        this.camera.logger.log('ONVIF event polling recovered');
        this.lastEventErrorMessage = undefined;
      }
    });

    this.device.events.on('resubscribed', () => {
      this.camera.logger.trace('ONVIF pullpoint (re)subscribed');
    });

    this.device.events.on('renewfailed', (error: Error) => {
      this.camera.logger.debug('ONVIF subscription renew failed:', error.message ?? error);
    });

    this.device.events.startEventLoop({ messageLimit: 10 });
    this.eventLoopRunning = true;
    this.camera.logger.log('Started ONVIF event listening (detection sensors assigned)');
  }

  private stopEventLoop(): void {
    if (!this.device || !this.eventLoopRunning) return;

    this.device.events.stopEventLoop();
    this.eventLoopRunning = false;
    this.camera.logger.log('Stopped ONVIF event listening (no detection sensors assigned)');
  }

  private handleEvent(message: NotificationMessage, capabilities: OnvifCapabilities): void {
    const motionData = parseMotionEvent(message);
    if (motionData) {
      this.trackDynamicCapability('motion', capabilities);
      if (this.motionSensor) {
        this.motionSensor.handleMotion(motionData);
      }

      return;
    }

    const detectionData = parseDetectionEvent(message);
    if (detectionData) {
      this.trackDynamicCapability(detectionData.category, capabilities);

      if (detectionData.category === 'face' && this.faceSensor) {
        this.faceSensor.handleDetection(detectionData);
      } else if ((detectionData.category === 'person' || detectionData.category === 'vehicle' || detectionData.category === 'animal') && this.objectSensor) {
        this.objectSensor.handleDetection({
          category: detectionData.category,
          isDetected: detectionData.isDetected,
          rule: detectionData.rule,
        });
      }
      return;
    }

    const audioData = parseAudioEvent(message);
    if (audioData && this.audioSensor) {
      this.audioSensor.handleAudio(audioData);
      this.trackDynamicCapability('audio', capabilities);
    }
  }

  private trackDynamicCapability(category: EventCategory, capabilities: OnvifCapabilities): void {
    if (!this.dynamicCapabilities.has(category) && !capabilities.advertisedTypes.includes(category)) {
      this.dynamicCapabilities.add(category);
      this.camera.logger.debug(`Discovered new capability (not in TopicSet): ${category}`);

      if (capabilities.eventProperties) {
        const allTypes = getAllSupportedDetectionTypes(capabilities.eventProperties, Array.from(this.dynamicCapabilities));
        this.camera.logger.debug('All detection types:', allTypes.join(', '));
      }
    } else {
      this.dynamicCapabilities.add(category);
    }
  }

  private async connectToDevice(url: string, username: string, password: string): Promise<Onvif> {
    const normalizedUrl = String(url ?? '').trim();

    let cameraUrl: URL;
    try {
      cameraUrl = new URL(normalizedUrl.includes('://') ? normalizedUrl : `http://${normalizedUrl}`);
    } catch {
      const redacted = normalizedUrl.replace(/\/\/[^@/]*@/, '//***@');
      throw new Error(`Invalid ONVIF device URL (type ${typeof url}): "${redacted}" — expected e.g. http://192.168.1.100`);
    }

    const hostname = cameraUrl.hostname;
    const port = cameraUrl.port;

    const device = new Onvif({
      hostname,
      username,
      password,
      port: port ? parseInt(port) : 80,
      preserveAddress: true,
    });

    return await device.connect();
  }

  private async detectCapabilities(): Promise<OnvifCapabilities> {
    if (!this.device) {
      return { hasPTZ: false, hasEvents: false, advertisedTypes: [] };
    }

    const hasPTZ = this.device.defaultProfile?.PTZConfiguration !== undefined;
    const hasEvents = this.device.uri.events !== undefined;

    let eventProperties: EventProperties | undefined;
    let advertisedTypes: EventCategory[] = [];

    if (hasEvents) {
      try {
        eventProperties = await this.device.events.getEventProperties();
        advertisedTypes = getSupportedDetectionTypes(eventProperties);
      } catch {
        // ignore
      }
    }

    return { hasPTZ, hasEvents, eventProperties, advertisedTypes };
  }

  private createStorage(): DeviceStorage<OnvifStorageValues> {
    return this.camera.createStorage<OnvifStorageValues>([
      {
        type: 'string',
        key: 'username',
        title: 'Username',
        description: "Username for the camera's ONVIF account.",
        store: true,
        required: true,
        onSet: async () => {
          await this.reconnect();
        },
      },
      {
        type: 'string',
        format: 'password',
        key: 'password',
        title: 'Password',
        description: "Password for the camera's ONVIF account.",
        store: true,
        required: true,
        onSet: async () => {
          await this.reconnect();
        },
      },
      {
        type: 'string',
        key: 'url',
        title: 'URL',
        description: 'Device address, e.g. http://192.168.1.100',
        store: true,
        required: true,
        onSet: async () => {
          await this.reconnect();
        },
      },
      {
        type: 'button',
        title: 'Reconnect',
        key: 'reconnect',
        color: 'success',
        description: 'Reconnect to the camera.',
        onSet: async () => {
          await this.reconnect();
        },
      },
    ]);
  }
}
