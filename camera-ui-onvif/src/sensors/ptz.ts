import { PTZCapability, PTZControl } from '@camera.ui/sdk';

import type { CameraDevice, JsonSchema, PTZDirection, PTZPosition, PTZRelativeMove } from '@camera.ui/sdk';
import type { Onvif, PTZStatus } from '@seydx/onvif';

const POLL_INTERVAL_MS = 200;
const POSITION_EPSILON = 0.001;
const IDLE_POLLS_TO_STOP = 3;
const FAST_PATH_GRACE_MS = 1500;

// ONVIF FOV translation space: x/y in [-1, 1] where 1.0 shifts the view by
// HALF the frame (SDK deltas are full frame fractions, hence the ×2 mapping)
const FOV_TRANSLATION_SPACE = 'http://www.onvif.org/ver10/tptz/PanTiltSpaces/TranslationSpaceFov';

export class OnvifPTZSensor extends PTZControl {
  private device: Onvif;
  private cameraDevice: CameraDevice;

  private pollingTimer?: NodeJS.Timeout;
  private lastPolledPosition?: { pan?: number; tilt?: number; zoom?: number };
  private idleStreak = 0;
  private lastPollErrorMessage?: string;
  private fastPathUntilTs = 0;
  private supportsFovRelativeMove = false;

  constructor(cameraDevice: CameraDevice, device: Onvif, name = 'ONVIF PTZ') {
    super(name);
    this.cameraDevice = cameraDevice;
    this.device = device;
  }

  // live values via onGet: capabilities are only known after initialize()
  override get storageSchema(): JsonSchema[] {
    const has = (cap: PTZCapability) => this.capabilities.includes(cap);
    return [
      {
        type: 'string',
        key: 'infoAxes',
        title: 'Axes',
        description: 'Movement axes reported by the camera.',
        readonly: true,
        onGet: async () => [has(PTZCapability.Pan) && 'Pan', has(PTZCapability.Tilt) && 'Tilt', has(PTZCapability.Zoom) && 'Zoom'].filter(Boolean).join(', ') || 'None',
      },
      {
        type: 'string',
        key: 'infoMoveSupport',
        title: 'Move Support',
        description: 'Move commands the camera accepts.',
        readonly: true,
        onGet: async () =>
          [
            has(PTZCapability.RelativeMove) && 'Displacement (FOV)',
            has(PTZCapability.AbsolutePosition) && 'Absolute position',
            has(PTZCapability.VelocityControl) && 'Velocity',
            has(PTZCapability.Home) && 'Home',
          ]
            .filter(Boolean)
            .join(', ') || 'None',
      },
      {
        type: 'string',
        key: 'infoPresets',
        title: 'Presets',
        description: 'Presets discovered on the camera.',
        readonly: true,
        onGet: async () => (this.presets.length ? this.presets.join(', ') : 'None'),
      },
    ];
  }

  protected override onAssigned(): void {
    if (this.pollingTimer) return;
    this.cameraDevice.logger.debug('PTZ sensor assigned — starting motion-state polling');
    this.pollingTimer = setInterval(() => {
      this.pollStatus();
    }, POLL_INTERVAL_MS);
  }

  protected override onDeassigned(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = undefined;
    }
    this.lastPolledPosition = undefined;
    this.idleStreak = 0;
    this.lastPollErrorMessage = undefined;
    this.fastPathUntilTs = 0;
    this.cameraDevice.logger.debug('PTZ sensor deassigned — stopped motion-state polling');
  }

  getDevice(): Onvif | undefined {
    return this.device;
  }

  async initialize(): Promise<void> {
    if (this.device) {
      await this.detectCapabilities();
    }
  }

  override async setPosition(position: PTZPosition): Promise<void> {
    try {
      await this.device.ptz.absoluteMove({
        position: {
          pan: position.pan,
          tilt: position.tilt,
          zoom: position.zoom,
        },
      });

      await super.setPosition(position);
    } catch (error) {
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ absoluteMove failed:', error);
      }
    }
  }

  override async setVelocity(velocity: PTZDirection | undefined): Promise<void> {
    if (!velocity) {
      return;
    }

    const isStop = velocity.panSpeed === 0 && velocity.tiltSpeed === 0 && velocity.zoomSpeed === 0;

    this.setMoving(!isStop);
    this.fastPathUntilTs = Date.now() + FAST_PATH_GRACE_MS;
    this.lastPolledPosition = undefined;
    this.idleStreak = 0;

    try {
      if (isStop) {
        await this.device.ptz.stop();
      } else {
        await this.device.ptz.continuousMove({
          velocity: {
            x: velocity.panSpeed ?? 0,
            y: velocity.tiltSpeed ?? 0,
            zoom: velocity.zoomSpeed ?? 0,
          },
          timeout: 1000,
        });
      }

      await super.setVelocity(velocity);
    } catch (error) {
      this.fastPathUntilTs = 0;
      this.setMoving(false);
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error(`PTZ ${isStop ? 'stop' : 'continuousMove'} failed:`, error);
      }
    }
  }

  override async setRelativeMove(move: PTZRelativeMove): Promise<void> {
    if (!this.supportsFovRelativeMove) {
      this.cameraDevice.logger.warn('PTZ relativeMove requested but camera has no FOV translation space');
      return;
    }

    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    const x = clamp((move.panDelta ?? 0) * 2);
    const y = clamp((move.tiltDelta ?? 0) * 2);
    const zoom = clamp(move.zoomDelta ?? 0);

    this.setMoving(true);
    this.fastPathUntilTs = Date.now() + FAST_PATH_GRACE_MS;
    this.lastPolledPosition = undefined;
    this.idleStreak = 0;

    try {
      await this.device.ptz.relativeMove({
        translation: {
          panTilt: { x, y, space: FOV_TRANSLATION_SPACE },
          ...(zoom !== 0 ? { zoom: { x: zoom } } : {}),
        },
      });

      await super.setRelativeMove(move);
    } catch (error) {
      this.fastPathUntilTs = 0;
      this.setMoving(false);
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ relativeMove failed:', error);
      }
    }
  }

  override async setTargetPreset(preset: string | undefined): Promise<void> {
    if (!preset) {
      return;
    }

    try {
      await this.device.ptz.gotoPreset({
        presetToken: preset,
      });

      await super.setTargetPreset(preset);
    } catch (error) {
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ gotoPreset failed:', error);
      }
    }
  }

  override async goHome(): Promise<void> {
    const hasHomeCapability = this.capabilities.includes(PTZCapability.Home);

    try {
      if (hasHomeCapability) {
        await this.device.ptz.gotoHomePosition({});
        await super.setPosition({ pan: 0, tilt: 0, zoom: 0 });
      } else {
        await this.setPosition({ pan: 0, tilt: 0, zoom: 0 });
      }
    } catch (error) {
      if (!this.ignoreError(error)) {
        this.cameraDevice.logger.error('PTZ goHome failed:', error);
      }
    }
  }

  private async detectCapabilities(): Promise<void> {
    const hasPTZ = this.device.defaultProfile?.PTZConfiguration !== undefined;
    const canPanTilt =
      this.device.defaultProfile?.PTZConfiguration?.defaultAbsolutePantTiltPositionSpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultContinuousPanTiltVelocitySpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultRelativePanTiltTranslationSpace !== undefined;
    const canZoom =
      this.device.defaultProfile?.PTZConfiguration?.defaultAbsoluteZoomPositionSpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultContinuousZoomVelocitySpace !== undefined ||
      this.device.defaultProfile?.PTZConfiguration?.defaultRelativeZoomTranslationSpace !== undefined;

    const minPan = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.XRange?.min ?? 0;
    const maxPan = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.XRange?.max ?? 0;
    const minTilt = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.YRange?.min ?? 0;
    const maxTilt = this.device.defaultProfile?.PTZConfiguration?.panTiltLimits?.range?.YRange?.max ?? 0;
    const minZoom = this.device.defaultProfile?.PTZConfiguration?.zoomLimits?.range?.XRange?.min ?? 0;
    const maxZoom = this.device.defaultProfile?.PTZConfiguration?.zoomLimits?.range?.XRange?.max ?? 0;

    // a non-empty range is the signal; the generic zoom space is 0..1 per
    // spec, so testing min !== 0 wrongly rejected every conforming camera
    const hasPan = hasPTZ && canPanTilt && maxPan > minPan;
    const hasTilt = hasPTZ && canPanTilt && maxTilt > minTilt;
    const hasZoom = hasPTZ && canZoom && maxZoom > minZoom;

    const caps: PTZCapability[] = [];
    if (hasPan) caps.push(PTZCapability.Pan);
    if (hasTilt) caps.push(PTZCapability.Tilt);
    if (hasZoom) caps.push(PTZCapability.Zoom);

    const hasAbsolute = this.device.defaultProfile?.PTZConfiguration?.defaultAbsolutePantTiltPositionSpace !== undefined;
    const hasVelocity = this.device.defaultProfile?.PTZConfiguration?.defaultContinuousPanTiltVelocitySpace !== undefined;
    if ((hasPan || hasTilt) && hasAbsolute) caps.push(PTZCapability.AbsolutePosition);
    if ((hasPan || hasTilt) && hasVelocity) caps.push(PTZCapability.VelocityControl);

    let hasHome = false;
    let maxPresets = 0;
    try {
      const nodes = await this.device.ptz.getNodes();
      const nodeValues = nodes ? Object.values(nodes) : [];
      hasHome = nodeValues.some((node) => node.homeSupported);
      if (hasHome) {
        caps.push(PTZCapability.Home);
      }
      maxPresets = nodeValues.reduce((max, node) => Math.max(max, node.maximumNumberOfPresets ?? 0), 0);

      // RelativeMove only with the FOV translation space: deltas there are
      // view fractions; the generic space is fractions of the mechanical
      // range and useless without per-camera calibration
      this.supportsFovRelativeMove =
        (hasPan || hasTilt) &&
        nodeValues.some((node) => (node.supportedPTZSpaces?.relativePanTiltTranslationSpace ?? []).some((space) => space.URI === FOV_TRANSLATION_SPACE));
      if (this.supportsFovRelativeMove) {
        caps.push(PTZCapability.RelativeMove);
      }

      for (const node of nodeValues) {
        const byType: Record<string, string[]> = {};
        for (const [key, descs] of Object.entries(node.supportedPTZSpaces ?? {})) {
          if (!Array.isArray(descs)) continue;
          for (const desc of descs) {
            const uri = (desc as { URI?: string } | undefined)?.URI;
            if (!uri) continue;
            (byType[key] ??= []).push(uri.split('/').pop() ?? uri);
          }
        }
        this.cameraDevice.logger.trace(`PTZ node "${node.token ?? '?'}" supported spaces:`, byType);
      }
    } catch {
      // ignore
    }

    let presetsCount = 0;
    try {
      const presetsResponse = await this.device.ptz.getPresets();
      if (presetsResponse && Object.keys(presetsResponse).length > 0) {
        caps.push(PTZCapability.Presets);
        const presetsList = Object.values(presetsResponse);
        const presetNames = presetsList.map((p: { name?: string; token?: string }) => p.name ?? p.token ?? '').filter(Boolean);
        this.setPresets(presetNames);
        presetsCount = presetNames.length;
      }
    } catch {
      // ignore
    }

    const cfg = this.device.defaultProfile?.PTZConfiguration;
    const spaceName = (uri: string | undefined) => uri?.split('/').pop();
    this.cameraDevice.logger.debug('PTZ default spaces:', {
      absolutePanTilt: spaceName(cfg?.defaultAbsolutePantTiltPositionSpace),
      relativePanTilt: spaceName(cfg?.defaultRelativePanTiltTranslationSpace),
      continuousPanTilt: spaceName(cfg?.defaultContinuousPanTiltVelocitySpace),
      absoluteZoom: spaceName(cfg?.defaultAbsoluteZoomPositionSpace),
      relativeZoom: spaceName(cfg?.defaultRelativeZoomTranslationSpace),
      continuousZoom: spaceName(cfg?.defaultContinuousZoomVelocitySpace),
    });

    this.cameraDevice.logger.debug('PTZ capabilities:', {
      pan: hasPan,
      tilt: hasTilt,
      zoom: hasZoom,
      home: hasHome,
      presets: presetsCount > 0 ? `${presetsCount}/${maxPresets || '?'}` : false,
      relativeMoveFov: this.supportsFovRelativeMove,
      absolutePosition: hasAbsolute,
      velocityControl: hasVelocity,
    });

    if (!hasPan && !hasTilt && !hasZoom) {
      this.cameraDevice.logger.warn('Camera does not support PTZ');
    }

    // Triggers broadcast to consumers.
    this.capabilities = caps;
  }

  private async pollStatus(): Promise<void> {
    // Fast-path grace window: suppress polling so it can't second-guess a just-committed setVelocity.
    if (Date.now() < this.fastPathUntilTs) return;

    let status: PTZStatus;
    try {
      status = await this.device.ptz.getStatus();
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (message !== this.lastPollErrorMessage) {
        this.cameraDevice.logger.trace('PTZ getStatus poll failed:', message);
        this.lastPollErrorMessage = message;
      }
      return;
    }

    this.lastPollErrorMessage = undefined;

    const pt = status.moveStatus?.panTilt;
    const z = status.moveStatus?.zoom;
    const pos = {
      pan: status.position?.panTilt?.x,
      tilt: status.position?.panTilt?.y,
      zoom: status.position?.zoom?.x,
    };

    // Publish position changes for the autotracker; super.setPosition only writes SDK state, no hardware action.
    const current = this.position;
    const posDelta = Math.max(
      Math.abs((pos.pan ?? 0) - (current?.pan ?? 0)),
      Math.abs((pos.tilt ?? 0) - (current?.tilt ?? 0)),
      Math.abs((pos.zoom ?? 0) - (current?.zoom ?? 0)),
    );
    if (posDelta > POSITION_EPSILON) {
      await super.setPosition({
        pan: pos.pan ?? current?.pan ?? 0,
        tilt: pos.tilt ?? current?.tilt ?? 0,
        zoom: pos.zoom ?? current?.zoom ?? 0,
      });
    }

    // Primary signal: ONVIF MoveStatus (IDLE/MOVING, not UNKNOWN); some PTZs report only panTilt or only zoom.
    const ptUsable = pt === 'IDLE' || pt === 'MOVING';
    const zUsable = z === 'IDLE' || z === 'MOVING';
    if (ptUsable || zUsable) {
      const moving = pt === 'MOVING' || z === 'MOVING';
      this.setMoving(moving);
      this.lastPolledPosition = pos;
      this.idleStreak = moving ? 0 : this.idleStreak + 1;
      return;
    }

    // Fallback: position-delta. Needs at least one prior sample.
    if (!this.lastPolledPosition) {
      this.lastPolledPosition = pos;
      return;
    }
    const delta = Math.max(
      Math.abs((pos.pan ?? 0) - (this.lastPolledPosition.pan ?? 0)),
      Math.abs((pos.tilt ?? 0) - (this.lastPolledPosition.tilt ?? 0)),
      Math.abs((pos.zoom ?? 0) - (this.lastPolledPosition.zoom ?? 0)),
    );
    this.lastPolledPosition = pos;

    if (delta > POSITION_EPSILON) {
      this.setMoving(true);
      this.idleStreak = 0;
    } else {
      this.idleStreak++;
      // Flip to IDLE only after N consecutive no-delta polls to ride out jitter.
      if (this.idleStreak >= IDLE_POLLS_TO_STOP) {
        this.setMoving(false);
      }
    }
  }

  private ignoreError(error: unknown): boolean {
    if (error instanceof Error && error.message.includes('Response does not match the HTTP/1.1 protocol')) {
      return true;
    }
    return false;
  }
}
