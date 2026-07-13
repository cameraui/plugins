package main

import (
	"context"
	"fmt"
	"sync"
	"time"

	sdk "github.com/cameraui/sdk/go"

	"github.com/shareed2k/reolinkproxy/pkg/bridge"
)

const snapshotTimeout = 15 * time.Second

type reolinkCamera struct {
	dev      *sdk.CameraDevice
	settings cameraSettings
	logger   *sdk.Logger

	bridgeCam *bridge.Camera

	motionSensor  *sdk.MotionSensor
	objectSensor  *sdk.ObjectSensor
	batterySensor *sdk.BatteryInfo

	doorbellOnce   sync.Once
	doorbellSensor *sdk.DoorbellTrigger

	connMu          sync.Mutex
	connReported    bool
	connEverSet     bool
	sleeping        bool
	disconnectTimer *time.Timer
}

func (p *ReolinkPlugin) initializeCamera(dev *sdk.CameraDevice) {
	p.mu.Lock()
	if _, exists := p.cameras[dev.ID()]; exists {
		p.mu.Unlock()
		return
	}
	b := p.bridge
	p.mu.Unlock()

	if b == nil {
		return
	}

	settings := loadSettings(dev.Storage())
	if settings.Host == "" && settings.UID == "" {
		p.Logger.Warn("Camera", dev.Name(), "has no stored connection settings, skipping")
		return
	}

	cam := &reolinkCamera{dev: dev, settings: settings, logger: dev.Logger()}
	if err := cam.initialize(b); err != nil {
		p.Logger.Error("Failed to initialize camera", dev.Name(), ":", err)
		return
	}

	p.mu.Lock()
	p.cameras[dev.ID()] = cam
	p.mu.Unlock()
}

func (c *reolinkCamera) initialize(b *bridge.Bridge) error {
	bridgeCam, err := b.AddCamera(bridge.CameraConfig{
		Name:           c.dev.ID(),
		Host:           c.settings.Host,
		UID:            c.settings.UID,
		Username:       c.settings.Username,
		Password:       c.settings.Password,
		Streams:        c.settings.Streams,
		IdleDisconnect: c.settings.BatteryCamera,
		BatteryCamera:  c.settings.BatteryCamera,
	})
	if err != nil {
		return err
	}
	c.bridgeCam = bridgeCam

	if err := c.dev.Implement(&cameraImplementation{cam: c}); err != nil {
		return err
	}
	if err := c.setupSensors(); err != nil {
		return err
	}
	c.subscribeEvents()
	return nil
}

func (c *reolinkCamera) release(b *bridge.Bridge) {
	if err := b.RemoveCamera(c.dev.ID()); err != nil {
		c.logger.Warn("Failed to remove bridge camera:", err)
	}
}

func (c *reolinkCamera) setupSensors() error {
	c.motionSensor = sdk.NewMotionSensor("Reolink Motion")
	if err := c.dev.AddSensor(c.motionSensor); err != nil {
		return err
	}

	if c.settings.HasAI {
		c.objectSensor = sdk.NewObjectSensor("Reolink AI Detection")
		if err := c.dev.AddSensor(c.objectSensor); err != nil {
			return err
		}
	}

	if c.settings.HasDoorbell {
		c.doorbellSensor = sdk.NewDoorbellTrigger("Reolink Doorbell")
		if err := c.dev.AddSensor(c.doorbellSensor); err != nil {
			return err
		}
		c.doorbellOnce.Do(func() {})
	}

	if c.settings.BatteryCamera {
		c.batterySensor = sdk.NewBatteryInfo("Reolink Battery")
		c.batterySensor.SetCapabilities([]string{sdk.BatteryCapabilityLowBattery, sdk.BatteryCapabilityCharging})
		if err := c.dev.AddSensor(c.batterySensor); err != nil {
			return err
		}
	}

	if c.settings.HasSiren {
		if err := c.dev.AddSensor(newReolinkSiren(c)); err != nil {
			return err
		}
	}
	if c.settings.HasSpotlight {
		if err := c.dev.AddSensor(newReolinkSpotlight(c)); err != nil {
			return err
		}
	}
	if c.settings.HasPTZ {
		if err := c.dev.AddSensor(newReolinkPTZ(c)); err != nil {
			return err
		}
	}
	return nil
}

func (c *reolinkCamera) subscribeEvents() {
	c.bridgeCam.OnMotion(func(event bridge.MotionEvent) {
		c.motionSensor.ReportDetections(event.Active, nil)
		c.reportObjects(event)
	})

	c.bridgeCam.OnDoorbell(func() {
		c.doorbellOnce.Do(func() {
			// Fallback for cameras whose Support report missed the doorbell:
			// add the sensor the first time a visitor press actually arrives.
			sensor := sdk.NewDoorbellTrigger("Reolink Doorbell")
			if err := c.dev.AddSensor(sensor); err != nil {
				c.logger.Error("Failed to add doorbell sensor:", err)
				return
			}
			c.doorbellSensor = sensor
		})
		if c.doorbellSensor != nil {
			c.doorbellSensor.Trigger()
		}
	})

	c.bridgeCam.OnBattery(func(state bridge.BatteryState) {
		if c.batterySensor == nil {
			return
		}
		c.batterySensor.SetLevel(state.Percent)
		switch {
		case state.Charging:
			c.batterySensor.SetCharging(sdk.ChargingStateCharging)
		case state.Full:
			c.batterySensor.SetCharging(sdk.ChargingStateFull)
		default:
			c.batterySensor.SetCharging(sdk.ChargingStateNotCharging)
		}
		c.batterySensor.SetLow(state.LowPower)
	})

	c.bridgeCam.OnSleep(func(sleeping bool) {
		c.connMu.Lock()
		c.sleeping = sleeping
		c.connMu.Unlock()
		c.logger.Log("Camera sleep state:", sleeping)
	})

	c.bridgeCam.OnConnection(c.handleConnection)
}

func (c *reolinkCamera) handleConnection(connected bool) {
	const disconnectGrace = 10 * time.Second

	c.connMu.Lock()
	defer c.connMu.Unlock()

	if connected {
		if c.disconnectTimer != nil {
			c.disconnectTimer.Stop()
			c.disconnectTimer = nil
		}
		if !c.connEverSet || !c.connReported {
			c.connEverSet = true
			c.connReported = true
			go func() { _ = c.dev.Connect() }()
		}
		return
	}

	if c.disconnectTimer != nil {
		return
	}
	c.disconnectTimer = time.AfterFunc(disconnectGrace, func() {
		c.connMu.Lock()
		c.disconnectTimer = nil
		// A sleeping battery camera drops the connection by design — it is
		// standby, not offline.
		stillReported := c.connReported && !c.sleeping
		if stillReported {
			c.connReported = false
		}
		c.connMu.Unlock()
		if stillReported {
			_ = c.dev.Disconnect()
		}
	})
}

func (c *reolinkCamera) reportObjects(event bridge.MotionEvent) {
	if c.objectSensor == nil {
		return
	}
	if len(event.AITypes) == 0 {
		c.objectSensor.ReportDetections(false, nil)
		return
	}

	detections := make([]sdk.TrackedDetection, 0, len(event.AITypes))
	for _, aiType := range event.AITypes {
		detections = append(detections, sdk.TrackedDetection{
			Detection: sdk.Detection{
				Label:      objectLabel(aiType),
				Confidence: 1,
			},
		})
	}
	c.objectSensor.ReportDetections(true, detections)
}

func objectLabel(aiType string) string {
	switch aiType {
	case "people":
		return "person"
	case "vehicle":
		return "vehicle"
	case "dog_cat":
		return "animal"
	default:
		return aiType
	}
}

type cameraImplementation struct {
	cam *reolinkCamera
}

var _ sdk.StreamingInterface = (*cameraImplementation)(nil)
var _ sdk.SnapshotInterface = (*cameraImplementation)(nil)

func (i *cameraImplementation) StreamUrl(sourceID string) (string, error) {
	source := i.cam.dev.GetSourceByID(sourceID)
	if source == nil {
		return "", fmt.Errorf("unknown source %q", sourceID)
	}
	return i.cam.bridgeCam.TwoWayURL(source.Name()), nil
}

func (i *cameraImplementation) Snapshot(_ string, _ bool) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), snapshotTimeout)
	defer cancel()
	return i.cam.bridgeCam.Snapshot(ctx)
}

const (
	storageKeyHost          = "host"
	storageKeyUID           = "uid"
	storageKeyUsername      = "username"
	storageKeyPassword      = "password"
	storageKeyStreams       = "streams"
	storageKeyBatteryCamera = "batteryCamera"
	storageKeyHasSiren      = "hasSiren"
	storageKeyHasSpotlight  = "hasSpotlight"
	storageKeyHasPTZ        = "hasPTZ"
	storageKeyPTZPan        = "ptzPan"
	storageKeyPTZTilt       = "ptzTilt"
	storageKeyPTZZoom       = "ptzZoom"
	storageKeyHasDoorbell   = "hasDoorbell"
	storageKeyHasAI         = "hasAI"
)

func ensureStorageSchemas(storage *sdk.DeviceStorage) {
	storeTrue := true
	storage.DefineSchemas([]sdk.JsonSchema{
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         storageKeyHost,
			Title:       "IP Address",
			Description: "Camera IP for the Baichuan connection (port 9000). Changes apply after a plugin restart.",
			Store:       &storeTrue,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         storageKeyUID,
			Title:       "UID",
			Description: "Reolink UID, used for broadcast connection when no IP is set. Changes apply after a plugin restart.",
			Store:       &storeTrue,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         storageKeyUsername,
			Title:       "Username",
			Description: "Username of the camera's local account. Changes apply after a plugin restart.",
			Store:       &storeTrue,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         storageKeyPassword,
			Title:       "Password",
			Description: "Password of the camera's local account. Changes apply after a plugin restart.",
			Format:      sdk.StringFormatPassword,
			Store:       &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeArray,
			Key:    storageKeyStreams,
			Title:  "Stream Profiles",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyBatteryCamera,
			Title:  "Battery Camera",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyHasSiren,
			Title:  "Siren",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyHasSpotlight,
			Title:  "Spotlight",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyHasPTZ,
			Title:  "PTZ",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyPTZPan,
			Title:  "PTZ Pan",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyPTZTilt,
			Title:  "PTZ Tilt",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyPTZZoom,
			Title:  "PTZ Zoom",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyHasDoorbell,
			Title:  "Doorbell",
			Hidden: true,
			Store:  &storeTrue,
		},
		{
			Type:   sdk.JsonSchemaTypeBoolean,
			Key:    storageKeyHasAI,
			Title:  "AI Detection",
			Hidden: true,
			Store:  &storeTrue,
		},
	})
}

func persistSettings(storage *sdk.DeviceStorage, settings cameraSettings) error {
	ensureStorageSchemas(storage)
	values := map[string]any{
		storageKeyHost:          settings.Host,
		storageKeyUID:           settings.UID,
		storageKeyUsername:      settings.Username,
		storageKeyPassword:      settings.Password,
		storageKeyStreams:       settings.Streams,
		storageKeyBatteryCamera: settings.BatteryCamera,
		storageKeyHasSiren:      settings.HasSiren,
		storageKeyHasSpotlight:  settings.HasSpotlight,
		storageKeyHasPTZ:        settings.HasPTZ,
		storageKeyPTZPan:        settings.PTZPan,
		storageKeyPTZTilt:       settings.PTZTilt,
		storageKeyPTZZoom:       settings.PTZZoom,
		storageKeyHasDoorbell:   settings.HasDoorbell,
		storageKeyHasAI:         settings.HasAI,
	}
	for key, value := range values {
		if err := storage.SetValue(key, value); err != nil {
			return fmt.Errorf("persist camera setting %s: %w", key, err)
		}
	}
	return nil
}

func loadSettings(storage *sdk.DeviceStorage) cameraSettings {
	ensureStorageSchemas(storage)
	settings := cameraSettings{
		Host:          stringValue(storage, storageKeyHost),
		UID:           stringValue(storage, storageKeyUID),
		Username:      stringValue(storage, storageKeyUsername),
		Password:      stringValue(storage, storageKeyPassword),
		BatteryCamera: boolValue(storage, storageKeyBatteryCamera),
		HasSiren:      boolValue(storage, storageKeyHasSiren),
		HasSpotlight:  boolValue(storage, storageKeyHasSpotlight),
		HasPTZ:        boolValue(storage, storageKeyHasPTZ),
		PTZPan:        boolValue(storage, storageKeyPTZPan),
		PTZTilt:       boolValue(storage, storageKeyPTZTilt),
		PTZZoom:       boolValue(storage, storageKeyPTZZoom),
		HasDoorbell:   boolValue(storage, storageKeyHasDoorbell),
		HasAI:         boolValue(storage, storageKeyHasAI),
	}

	switch v := storage.GetValue(storageKeyStreams).(type) {
	case []string:
		settings.Streams = v
	case []any:
		for _, item := range v {
			if s, ok := item.(string); ok {
				settings.Streams = append(settings.Streams, s)
			}
		}
	}
	return settings
}

func stringValue(storage *sdk.DeviceStorage, key string) string {
	v, _ := storage.GetValue(key).(string)
	return v
}

func boolValue(storage *sdk.DeviceStorage, key string) bool {
	v, _ := storage.GetValue(key).(bool)
	return v
}
