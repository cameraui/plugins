package main

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	sdk "github.com/cameraui/sdk/go"

	"github.com/shareed2k/reolinkproxy/pkg/baichuan"
	"github.com/shareed2k/reolinkproxy/pkg/bridge"
)

const (
	discoveryPrefix    = "reolink:"
	defaultRTSPPort    = 8556
	defaultWebhookPort = 8557
	discoveryTimeout   = 5 * time.Second
	adoptProbeTimeout  = 20 * time.Second
)

type ReolinkPlugin struct {
	sdk.BasePlugin

	mu              sync.Mutex
	bridge          *bridge.Bridge
	cameras         map[string]*reolinkCamera            // camera ID → controller
	existing        map[string]*sdk.CameraDevice         // camera ID → device
	discovered      map[string]baichuan.DiscoveredDevice // discovery ID → device
	pendingSettings map[string]cameraSettings
}

type cameraSettings struct {
	Host          string
	UID           string
	Username      string
	Password      string
	Streams       []string
	BatteryCamera bool
	HasSiren      bool
	HasSpotlight  bool
	HasPTZ        bool
	PTZPan        bool
	PTZTilt       bool
	PTZZoom       bool
	HasDoorbell   bool
	HasAI         bool
}

var _ sdk.DiscoveryProvider = (*ReolinkPlugin)(nil)
var _ sdk.StorageSchemaProvider = (*ReolinkPlugin)(nil)

func NewPlugin(logger *sdk.Logger, api *sdk.PluginAPI, storage *sdk.DeviceStorage) sdk.Plugin {
	p := &ReolinkPlugin{
		BasePlugin:      sdk.NewBasePlugin(logger, api, storage),
		cameras:         make(map[string]*reolinkCamera),
		existing:        make(map[string]*sdk.CameraDevice),
		discovered:      make(map[string]baichuan.DiscoveredDevice),
		pendingSettings: make(map[string]cameraSettings),
	}

	api.On(string(sdk.APIEventFinishLaunching), func(...any) { p.start() })
	api.On(string(sdk.APIEventShutdown), func(...any) { p.stop() })

	return p
}

func (p *ReolinkPlugin) StorageSchema() []sdk.JsonSchema {
	storeTrue := true
	storeFalse := false
	return []sdk.JsonSchema{
		{
			Type:         sdk.JsonSchemaTypeNumber,
			Key:          "rtspPort",
			Title:        "Bridge RTSP Port",
			Description:  "Local port the embedded RTSP bridge listens on (loopback only). Restart the plugin after changing it.",
			DefaultValue: defaultRTSPPort,
			Minimum:      sdk.Float64(1024),
			Maximum:      sdk.Float64(65535),
			Store:        &storeTrue,
			Required:     true,
		},
		{
			Type:         sdk.JsonSchemaTypeNumber,
			Key:          "webhookPort",
			Title:        "Event Webhook Port",
			Description:  "Port battery cameras push their events to (must be reachable from the camera network). Restart the plugin after changing it.",
			DefaultValue: defaultWebhookPort,
			Minimum:      sdk.Float64(1024),
			Maximum:      sdk.Float64(65535),
			Store:        &storeTrue,
			Required:     true,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         "manualName",
			Title:       "Camera Name",
			Description: "Add a camera manually when LAN discovery cannot reach it (different subnet, or battery camera by UID).",
			Store:       &storeFalse,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         "manualHost",
			Title:       "IP Address",
			Description: "Camera IP for a direct connection (Baichuan TCP, port 9000).",
			Store:       &storeFalse,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         "manualUID",
			Title:       "UID",
			Description: "Reolink UID for local broadcast connection (same network segment only). Used when no IP is set.",
			Store:       &storeFalse,
		},
		{
			Type:        sdk.JsonSchemaTypeSubmit,
			Key:         "onAddManual",
			Title:       "Add Camera",
			Description: "Adds the camera to the discovered list; adopt it from there with its credentials.",
			OnClick:     p.onAddManual,
		},
	}
}

func (p *ReolinkPlugin) start() {
	port := defaultRTSPPort
	if v, ok := toInt(p.Storage.GetValue("rtspPort", defaultRTSPPort)); ok && v > 0 {
		port = v
	}

	webhookPort := defaultWebhookPort
	if v, ok := toInt(p.Storage.GetValue("webhookPort", defaultWebhookPort)); ok && v > 0 {
		webhookPort = v
	}

	b := bridge.New(bridge.Options{
		RTSPAddress:    fmt.Sprintf("127.0.0.1:%d", port),
		WebhookAddress: fmt.Sprintf(":%d", webhookPort),
		Logger:         bridgeLogger{p.Logger},
	})
	if err := b.Start(); err != nil {
		p.Logger.Error("Failed to start RTSP bridge:", err)
		return
	}

	p.mu.Lock()
	p.bridge = b
	devices := make([]*sdk.CameraDevice, 0, len(p.existing))
	for _, dev := range p.existing {
		devices = append(devices, dev)
	}
	p.mu.Unlock()

	for _, dev := range devices {
		p.initializeCamera(dev)
	}
}

func (p *ReolinkPlugin) stop() {
	p.mu.Lock()
	b := p.bridge
	p.bridge = nil
	p.cameras = make(map[string]*reolinkCamera)
	p.mu.Unlock()

	if b != nil {
		b.Close()
	}
}

func (p *ReolinkPlugin) ConfigureCameras(cameras []*sdk.CameraDevice) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, dev := range cameras {
		p.existing[dev.ID()] = dev
	}
	return nil
}

func (p *ReolinkPlugin) OnCameraAdded(dev *sdk.CameraDevice) error {
	p.mu.Lock()
	p.existing[dev.ID()] = dev
	settings, hasPending := p.pendingSettings[dev.NativeID()]
	if hasPending {
		delete(p.pendingSettings, dev.NativeID())
	}
	ready := p.bridge != nil
	p.mu.Unlock()

	if hasPending {
		if err := persistSettings(dev.Storage(), settings); err != nil {
			p.Logger.Error("Failed to persist settings for", dev.Name(), ":", err)
			return err
		}
	}
	if ready {
		p.initializeCamera(dev)
	}
	return nil
}

func (p *ReolinkPlugin) OnCameraReleased(cameraID string) error {
	p.mu.Lock()
	dev := p.existing[cameraID]
	delete(p.existing, cameraID)
	cam := p.cameras[cameraID]
	delete(p.cameras, cameraID)
	b := p.bridge
	p.mu.Unlock()

	if cam != nil && b != nil {
		cam.release(b)
	}

	// Offer the released camera for re-adoption without waiting for a rescan.
	if dev != nil && dev.NativeID() != "" {
		p.mu.Lock()
		device, ok := p.discovered[dev.NativeID()]
		p.mu.Unlock()
		if ok {
			_ = p.API.DeviceManager.PushDiscoveredCameras([]sdk.DiscoveredCamera{discoveredCameraFrom(dev.NativeID(), device)})
		}
	}
	return nil
}

func (p *ReolinkPlugin) OnDiscoverCameras() ([]sdk.DiscoveredCamera, error) {
	ctx, cancel := context.WithTimeout(context.Background(), discoveryTimeout+time.Second)
	defer cancel()

	devices, err := baichuan.Discover(ctx, discoveryTimeout)
	if err != nil {
		p.Logger.Warn("Reolink LAN discovery failed:", err)
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	for _, device := range devices {
		p.discovered[discoveryID(device)] = device
	}

	adopted := make(map[string]struct{}, len(p.existing))
	for _, dev := range p.existing {
		if nativeID := dev.NativeID(); nativeID != "" {
			adopted[nativeID] = struct{}{}
		}
	}

	out := make([]sdk.DiscoveredCamera, 0, len(p.discovered))
	for id, device := range p.discovered {
		if _, ok := adopted[id]; ok {
			continue
		}
		out = append(out, discoveredCameraFrom(id, device))
	}
	return out, nil
}

func (p *ReolinkPlugin) OnGetCameraSettings(_ sdk.DiscoveredCamera) ([]sdk.JsonSchema, error) {
	return []sdk.JsonSchema{
		{
			Type:         sdk.JsonSchemaTypeString,
			Key:          "username",
			Title:        "Username",
			Description:  "Username of the camera's local account.",
			DefaultValue: "admin",
			Required:     true,
		},
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         "password",
			Title:       "Password",
			Description: "Password of the camera's local account (set in the Reolink app).",
			Format:      sdk.StringFormatPassword,
			Required:    true,
		},
	}, nil
}

func (p *ReolinkPlugin) OnAdoptCamera(camera sdk.DiscoveredCamera, settings map[string]any) (map[string]any, error) {
	p.mu.Lock()
	device, ok := p.discovered[camera.ID]
	p.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("unknown discovered camera %q", camera.ID)
	}

	username, _ := settings["username"].(string)
	password, _ := settings["password"].(string)
	if username == "" || password == "" {
		return nil, fmt.Errorf("username and password are required")
	}

	ctx, cancel := context.WithTimeout(context.Background(), adoptProbeTimeout)
	defer cancel()

	probe, err := probeCamera(ctx, device, username, password)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s: %w", camera.Name, err)
	}

	camSettings := cameraSettings{
		Host:          device.IP,
		UID:           device.UID,
		Username:      username,
		Password:      password,
		Streams:       probe.streams,
		BatteryCamera: probe.caps.Battery,
		HasSiren:      probe.caps.Siren,
		HasSpotlight:  probe.caps.Floodlight,
		HasPTZ:        probe.caps.PTZ,
		PTZPan:        probe.caps.Pan,
		PTZTilt:       probe.caps.Tilt,
		PTZZoom:       probe.caps.Zoom,
		HasDoorbell:   probe.caps.Doorbell,
		HasAI:         len(probe.caps.AITypes) > 0,
	}
	p.Logger.Log(fmt.Sprintf("Detected capabilities for %s: streams=%v battery=%t siren=%t spotlight=%t ptz=%t doorbell=%t ai=%v",
		camera.Name, probe.streams, probe.caps.Battery, probe.caps.Siren, probe.caps.Floodlight, probe.caps.PTZ, probe.caps.Doorbell, probe.caps.AITypes))

	p.mu.Lock()
	p.pendingSettings[camera.ID] = camSettings
	p.mu.Unlock()

	name := camera.Name
	if name == "" {
		name = "Reolink " + device.IP
	}

	sources := make([]map[string]any, 0, len(probe.streams))
	for _, profile := range probe.streams {
		sources = append(sources, map[string]any{
			"name":           profile,
			"role":           roleForProfile(profile),
			"useForSnapshot": false,
			"hotMode":        profile == "main" && !probe.caps.Battery,
			"preload":        profile == "main" && !probe.caps.Battery,
		})
	}

	info := map[string]any{
		"manufacturer": "Reolink",
	}
	if probe.info != nil {
		if probe.info.Type != "" {
			info["model"] = probe.info.Type
		}
		if probe.info.SerialNumber != "" {
			info["serialNumber"] = probe.info.SerialNumber
		}
		if probe.info.FirmwareVersion != "" {
			info["firmwareVersion"] = probe.info.FirmwareVersion
		}
	}

	p.Logger.Log("Adopted camera:", name)

	return map[string]any{
		"name":     name,
		"nativeId": camera.ID,
		"info":     info,
		"sources":  sources,
	}, nil
}

type probeResult struct {
	info    *baichuan.DevInfo
	caps    baichuan.ChannelCapabilities
	streams []string
}

func probeCamera(ctx context.Context, device baichuan.DiscoveredDevice, username string, password string) (probeResult, error) {
	cfg := baichuan.Config{
		Host:     device.IP,
		Port:     9000,
		Username: username,
		Password: password,
		Timeout:  10 * time.Second,
	}
	if cfg.Host == "" {
		cfg.UID = device.UID
	}

	client, err := baichuan.Dial(ctx, cfg)
	if err != nil {
		return probeResult{}, err
	}
	defer func() { _ = client.Close() }()

	if err := client.Login(ctx); err != nil {
		return probeResult{}, err
	}

	result := probeResult{streams: []string{"main", "sub"}}

	if info, err := client.GetDevInfo(ctx, 0); err == nil {
		result.info = info
	}

	if support, err := client.GetSupport(ctx); err == nil {
		if caps, ok := support.CapabilitiesFor(0); ok {
			result.caps = caps
		}
	}

	if profiles, err := client.StreamProfiles(ctx, 0); err == nil && len(profiles) > 0 {
		streams := make([]string, 0, len(profiles))
		for _, profile := range profiles {
			streams = append(streams, profile.Name)
		}
		result.streams = streams
	}

	return result, nil
}

func (p *ReolinkPlugin) onAddManual(value any) *sdk.FormSubmitResponse {
	values, _ := value.(map[string]any)
	name, _ := values["manualName"].(string)
	host, _ := values["manualHost"].(string)
	uid, _ := values["manualUID"].(string)

	name = strings.TrimSpace(name)
	host = strings.TrimSpace(host)
	uid = strings.TrimSpace(uid)

	if host == "" && uid == "" {
		return &sdk.FormSubmitResponse{Toast: &sdk.ToastMessage{Type: "error", Message: "IP address or UID is required."}}
	}
	if name == "" {
		name = "Reolink " + host + uid
	}

	device := baichuan.DiscoveredDevice{IP: host, UID: uid, Name: name}
	id := discoveryID(device)

	p.mu.Lock()
	p.discovered[id] = device
	p.mu.Unlock()

	if err := p.API.DeviceManager.PushDiscoveredCameras([]sdk.DiscoveredCamera{discoveredCameraFrom(id, device)}); err != nil {
		p.Logger.Error("Failed to push manual camera:", err)
		return &sdk.FormSubmitResponse{Toast: &sdk.ToastMessage{Type: "error", Message: "Failed to add camera."}}
	}

	return &sdk.FormSubmitResponse{Toast: &sdk.ToastMessage{Type: "success", Message: name + " added — adopt it from the discovered cameras list."}}
}

func discoveryID(device baichuan.DiscoveredDevice) string {
	switch {
	case device.MAC != "":
		return discoveryPrefix + strings.ToLower(device.MAC)
	case device.UID != "":
		return discoveryPrefix + device.UID
	default:
		return discoveryPrefix + device.IP
	}
}

func discoveredCameraFrom(id string, device baichuan.DiscoveredDevice) sdk.DiscoveredCamera {
	name := device.Name
	if name == "" {
		name = "Reolink " + device.IP
	}
	return sdk.DiscoveredCamera{
		ID:           id,
		Name:         name,
		Manufacturer: "Reolink",
		Address:      device.IP,
	}
}

func roleForProfile(profile string) string {
	switch profile {
	case "sub":
		return "low-resolution"
	case "extern":
		return "mid-resolution"
	default:
		return "high-resolution"
	}
}

func truthy(value any, defaultValue bool) bool {
	if b, ok := value.(bool); ok {
		return b
	}
	return defaultValue
}

func toInt(value any) (int, bool) {
	switch v := value.(type) {
	case int:
		return v, true
	case int64:
		return int(v), true
	case float64:
		return int(v), true
	default:
		return 0, false
	}
}

type bridgeLogger struct {
	logger *sdk.Logger
}

func (l bridgeLogger) Debugf(format string, args ...any) {
	l.logger.Debug(fmt.Sprintf(format, args...))
}
func (l bridgeLogger) Infof(format string, args ...any) { l.logger.Log(fmt.Sprintf(format, args...)) }
func (l bridgeLogger) Warnf(format string, args ...any) { l.logger.Warn(fmt.Sprintf(format, args...)) }
func (l bridgeLogger) Errorf(format string, args ...any) {
	l.logger.Error(fmt.Sprintf(format, args...))
}

func main() {
	sdk.Run(NewPlugin)
}
