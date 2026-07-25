package main

import (
	"context"
	"encoding/json"
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
	discoveryTimeout   = 10 * time.Second
	adoptProbeTimeout  = 20 * time.Second
	storageKeyNVRs     = "nvrs"
	presenceGrace      = 5 * time.Minute
)

type ReolinkPlugin struct {
	sdk.BasePlugin

	mu              sync.Mutex
	bridge          *bridge.Bridge
	cameras         map[string]*reolinkCamera    // camera ID → controller
	existing        map[string]*sdk.CameraDevice // camera ID → device
	discovered      map[string]discoveredEntry   // discovery ID → device (+ NVR channel)
	lastSeen        map[string]time.Time         // discovery ID → last discovery reply
	nvrs            map[string]storedNVR         // base discovery ID → connected NVR
	pendingSettings map[string]cameraSettings
}

type discoveredEntry struct {
	device baichuan.DiscoveredDevice
	// channel is -1 for standalone devices and the NVR entry itself;
	// >= 0 for the per-channel entries an adopted NVR expands into.
	channel int
	// manual entries are user-asserted (different subnet, UID-only) and stay
	// listed without a presence check.
	manual bool
}

// storedNVR is a connected NVR persisted in the plugin storage, so channel
// entries and their shared credentials survive plugin restarts.
type storedNVR struct {
	Username string `json:"username"`
	Password string `json:"password"`
	IP       string `json:"ip,omitempty"`
	UID      string `json:"uid,omitempty"`
	Name     string `json:"name,omitempty"`
	Manual   bool   `json:"manual,omitempty"`
	Channels []int  `json:"channels"`
}

type cameraSettings struct {
	Host          string
	UID           string
	Username      string
	Password      string
	Channel       int
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
		discovered:      make(map[string]discoveredEntry),
		lastSeen:        make(map[string]time.Time),
		nvrs:            make(map[string]storedNVR),
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
		{
			Type:        sdk.JsonSchemaTypeString,
			Key:         "forgetNVRHost",
			Title:       "NVR IP / UID",
			Description: "Remove a connected NVR: deletes its stored credentials and channel entries from the discovered list. Already adopted channel cameras are not touched.",
			Store:       &storeFalse,
		},
		{
			Type:        sdk.JsonSchemaTypeSubmit,
			Key:         "onForgetNVR",
			Title:       "Forget NVR",
			Description: "Removes the NVR entered above.",
			OnClick:     p.onForgetNVR,
		},
		{
			Type:   sdk.JsonSchemaTypeString,
			Key:    storageKeyNVRs,
			Title:  "Connected NVRs",
			Hidden: true,
			Store:  &storeTrue,
		},
	}
}

func (p *ReolinkPlugin) onForgetNVR(value any) *sdk.FormSubmitResponse {
	values, _ := value.(map[string]any)
	target, _ := values["forgetNVRHost"].(string)
	target = strings.TrimSpace(target)
	if target == "" {
		return &sdk.FormSubmitResponse{Toast: &sdk.ToastMessage{Type: "error", Message: "Enter the NVR's IP or UID."}}
	}

	p.mu.Lock()
	baseID := ""
	for id, nvr := range p.nvrs {
		if nvr.IP == target || nvr.UID == target || strings.EqualFold(nvr.Name, target) {
			baseID = id
			break
		}
	}
	if baseID == "" {
		p.mu.Unlock()
		return &sdk.FormSubmitResponse{Toast: &sdk.ToastMessage{Type: "error", Message: "No connected NVR matches " + target + "."}}
	}

	delete(p.nvrs, baseID)
	p.persistNVRs()

	prefix := baseID + ":ch"
	removed := 0
	for id, e := range p.discovered {
		if e.channel >= 0 && strings.HasPrefix(id, prefix) {
			delete(p.discovered, id)
			removed++
		}
	}
	p.mu.Unlock()

	p.Logger.Log(fmt.Sprintf("Forgot NVR %s (%d channel entries removed)", target, removed))
	return &sdk.FormSubmitResponse{Toast: &sdk.ToastMessage{Type: "success", Message: fmt.Sprintf("NVR removed (%d channel entries). Adopted cameras are unaffected.", removed)}}
}

func (p *ReolinkPlugin) loadNVRs() {
	raw, _ := p.Storage.GetValue(storageKeyNVRs).(string)
	if raw == "" {
		return
	}

	var nvrs map[string]storedNVR
	if err := json.Unmarshal([]byte(raw), &nvrs); err != nil {
		p.Logger.Warn("Failed to parse stored NVRs:", err)
		return
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	p.nvrs = nvrs
	for baseID, nvr := range nvrs {
		device := baichuan.DiscoveredDevice{IP: nvr.IP, UID: nvr.UID, Name: nvr.Name}
		for _, ch := range nvr.Channels {
			p.discovered[fmt.Sprintf("%s:ch%d", baseID, ch)] = discoveredEntry{device: device, channel: ch, manual: nvr.Manual}
		}
	}
}

func (p *ReolinkPlugin) persistNVRs() {
	raw, err := json.Marshal(p.nvrs)
	if err != nil {
		return
	}
	if err := p.Storage.SetValue(storageKeyNVRs, string(raw)); err != nil {
		p.Logger.Warn("Failed to persist NVRs:", err)
	}
}

func (p *ReolinkPlugin) start() {
	p.loadNVRs()

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
		entry, ok := p.discovered[dev.NativeID()]
		p.mu.Unlock()
		if ok {
			_ = p.API.DeviceManager.PushDiscoveredCameras([]sdk.DiscoveredCamera{discoveredCameraFrom(dev.NativeID(), entry)})
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

	now := time.Now()

	p.mu.Lock()
	for _, device := range devices {
		id := discoveryID(device)
		p.lastSeen[id] = now
		if existing, ok := p.discovered[id]; ok {
			p.discovered[id] = discoveredEntry{device: device, channel: existing.channel, manual: existing.manual}
			continue
		}
		p.discovered[id] = discoveredEntry{device: device, channel: -1}
	}
	adopted := make(map[string]struct{}, len(p.existing))
	for _, dev := range p.existing {
		if nativeID := dev.NativeID(); nativeID != "" {
			adopted[nativeID] = struct{}{}
		}
	}

	out := make([]sdk.DiscoveredCamera, 0, len(p.discovered))
	for id, entry := range p.discovered {
		if _, ok := adopted[id]; ok {
			continue
		}
		if !entry.manual {
			presenceID := id
			if entry.channel >= 0 {
				presenceID = baseDiscoveryID(id)
			}
			if seenAt, ok := p.lastSeen[presenceID]; !ok || now.Sub(seenAt) > presenceGrace {
				continue
			}
		}
		out = append(out, discoveredCameraFrom(id, entry))
	}
	p.mu.Unlock()
	return out, nil
}

func (p *ReolinkPlugin) OnGetCameraSettings(camera sdk.DiscoveredCamera) ([]sdk.JsonSchema, error) {
	username := "admin"
	password := ""

	p.mu.Lock()
	if entry, ok := p.discovered[camera.ID]; ok && entry.channel >= 0 {
		if nvr, ok := p.nvrs[baseDiscoveryID(camera.ID)]; ok {
			username = nvr.Username
			password = nvr.Password
		}
	}
	p.mu.Unlock()

	return []sdk.JsonSchema{
		{
			Type:         sdk.JsonSchemaTypeString,
			Key:          "username",
			Title:        "Username",
			Description:  "Username of the camera's local account.",
			DefaultValue: username,
			Required:     true,
		},
		{
			Type:         sdk.JsonSchemaTypeString,
			Key:          "password",
			Title:        "Password",
			Description:  "Password of the camera's local account (set in the Reolink app).",
			Format:       sdk.StringFormatPassword,
			DefaultValue: password,
			Required:     true,
		},
	}, nil
}

func baseDiscoveryID(id string) string {
	if idx := strings.LastIndex(id, ":ch"); idx >= 0 {
		return id[:idx]
	}
	return id
}

func (p *ReolinkPlugin) OnAdoptCamera(camera sdk.DiscoveredCamera, settings map[string]any) (map[string]any, error) {
	p.mu.Lock()
	entry, ok := p.discovered[camera.ID]
	p.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("unknown discovered camera %q", camera.ID)
	}
	device := entry.device

	username, _ := settings["username"].(string)
	password, _ := settings["password"].(string)
	if username == "" || password == "" {
		return nil, fmt.Errorf("username and password are required")
	}

	channel := entry.channel
	if channel < 0 {
		channel = 0
	}

	ctx, cancel := context.WithTimeout(context.Background(), adoptProbeTimeout)
	defer cancel()

	probe, err := probeCamera(ctx, device, username, password, uint8(channel)) //#nosec G115
	if err != nil {
		return nil, fmt.Errorf("failed to connect to %s: %w", camera.Name, err)
	}

	if entry.channel < 0 && probe.loginInfo.IsNVR() {
		return nil, p.expandNVR(camera, entry, username, password, probe.channels)
	}

	camSettings := cameraSettings{
		Host:          device.IP,
		UID:           device.UID,
		Username:      username,
		Password:      password,
		Channel:       channel,
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

	keepConnected := !probe.caps.Battery

	sources := make([]map[string]any, 0, len(probe.streams))
	for _, profile := range probe.streams {
		sources = append(sources, map[string]any{
			"name":           profile,
			"role":           roleForProfile(profile),
			"useForSnapshot": false,
			"hotMode":        keepConnected && (profile == "main" || profile == "sub"),
			"preload":        true,
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

func (p *ReolinkPlugin) expandNVR(camera sdk.DiscoveredCamera, nvrEntry discoveredEntry, username string, password string, channels []int) error {
	if len(channels) == 0 {
		return fmt.Errorf("NVR %s reports no connected cameras", camera.Name)
	}
	device := nvrEntry.device

	p.mu.Lock()
	p.nvrs[camera.ID] = storedNVR{
		Username: username,
		Password: password,
		IP:       device.IP,
		UID:      device.UID,
		Name:     device.Name,
		Manual:   nvrEntry.manual,
		Channels: channels,
	}
	p.persistNVRs()

	adopted := make(map[string]struct{}, len(p.existing))
	for _, dev := range p.existing {
		if nativeID := dev.NativeID(); nativeID != "" {
			adopted[nativeID] = struct{}{}
		}
	}

	entries := make([]sdk.DiscoveredCamera, 0, len(channels))
	valid := make(map[string]struct{}, len(channels))
	for _, ch := range channels {
		chID := fmt.Sprintf("%s:ch%d", camera.ID, ch)
		valid[chID] = struct{}{}
		chEntry := discoveredEntry{device: device, channel: ch, manual: nvrEntry.manual}
		p.discovered[chID] = chEntry
		if _, ok := adopted[chID]; ok {
			continue
		}
		entries = append(entries, discoveredCameraFrom(chID, chEntry))
	}

	prefix := camera.ID + ":ch"
	for id, e := range p.discovered {
		if e.channel >= 0 && strings.HasPrefix(id, prefix) {
			if _, ok := valid[id]; !ok {
				delete(p.discovered, id)
			}
		}
	}
	p.mu.Unlock()

	if len(entries) > 0 {
		if err := p.API.DeviceManager.PushDiscoveredCameras(entries); err != nil {
			return fmt.Errorf("push NVR channels: %w", err)
		}
	}

	p.Logger.Log(fmt.Sprintf("NVR %s expanded into %d channel camera(s)", camera.Name, len(entries)))
	return fmt.Errorf("NVR detected: %d channel camera(s) were added to the discovered list — adopt each channel individually (credentials are prefilled)", len(entries))
}

type probeResult struct {
	info      *baichuan.DevInfo
	caps      baichuan.ChannelCapabilities
	streams   []string
	loginInfo baichuan.LoginDeviceInfo
	channels  []int
}

func probeCamera(ctx context.Context, device baichuan.DiscoveredDevice, username string, password string, channel uint8) (probeResult, error) {
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
	result.loginInfo = client.LoginDeviceInfo()

	if result.loginInfo.IsNVR() {
		if channels, err := client.OccupiedChannels(ctx); err == nil {
			result.channels = channels
		}
	}

	if info, err := client.GetDevInfo(ctx); err == nil {
		result.info = info
	}

	if support, err := client.GetSupport(ctx); err == nil {
		if caps, ok := support.CapabilitiesFor(channel); ok {
			result.caps = caps
		}
	}

	if profiles, err := client.StreamProfiles(ctx, channel); err == nil && len(profiles) > 0 {
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
	entry := discoveredEntry{device: device, channel: -1, manual: true}

	p.mu.Lock()
	p.discovered[id] = entry
	p.mu.Unlock()

	if err := p.API.DeviceManager.PushDiscoveredCameras([]sdk.DiscoveredCamera{discoveredCameraFrom(id, entry)}); err != nil {
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

func discoveredCameraFrom(id string, entry discoveredEntry) sdk.DiscoveredCamera {
	name := entry.device.Name
	if name == "" {
		name = "Reolink " + entry.device.IP
	}
	if entry.channel >= 0 {
		name = fmt.Sprintf("%s CH%d", name, entry.channel+1)
	}
	return sdk.DiscoveredCamera{
		ID:           id,
		Name:         name,
		Manufacturer: "Reolink",
		Address:      entry.device.IP,
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
