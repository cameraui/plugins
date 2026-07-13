package main

import (
	"context"
	"errors"
	"math"
	"sync/atomic"
	"time"

	sdk "github.com/cameraui/sdk/go"

	"github.com/shareed2k/reolinkproxy/pkg/baichuan"
)

const controlTimeout = 10 * time.Second

type reolinkSiren struct {
	*sdk.SirenControl
	cam *reolinkCamera
}

func newReolinkSiren(cam *reolinkCamera) *reolinkSiren {
	return &reolinkSiren{
		SirenControl: sdk.NewSirenControl("Reolink Siren"),
		cam:          cam,
	}
}

func (s *reolinkSiren) SetActive() {
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.cam.bridgeCam.SetSiren(ctx, true); err != nil {
		s.cam.logger.Error("Failed to activate siren:", err)
		return
	}
	s.SirenControl.SetActive()
}

func (s *reolinkSiren) SetInactive() {
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.cam.bridgeCam.SetSiren(ctx, false); err != nil {
		s.cam.logger.Error("Failed to deactivate siren:", err)
		return
	}
	s.SirenControl.SetInactive()
}

func (s *reolinkSiren) UpdateValue(property string, value any) error {
	if property == "active" {
		if truthy(value, false) {
			s.SetActive()
		} else {
			s.SetInactive()
		}
		return nil
	}
	return s.SirenControl.UpdateValue(property, value)
}

type reolinkSpotlight struct {
	*sdk.LightControl
	cam *reolinkCamera
}

func newReolinkSpotlight(cam *reolinkCamera) *reolinkSpotlight {
	return &reolinkSpotlight{
		LightControl: sdk.NewLightControl("Reolink Spotlight"),
		cam:          cam,
	}
}

func (s *reolinkSpotlight) SetOn() {
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.cam.bridgeCam.SetWhiteLed(ctx, true); err != nil {
		s.cam.logger.Error("Failed to turn spotlight on:", err)
		return
	}
	s.LightControl.SetOn()
}

func (s *reolinkSpotlight) SetOff() {
	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.cam.bridgeCam.SetWhiteLed(ctx, false); err != nil {
		s.cam.logger.Error("Failed to turn spotlight off:", err)
		return
	}
	s.LightControl.SetOff()
}

func (s *reolinkSpotlight) UpdateValue(property string, value any) error {
	if property == "on" {
		if truthy(value, false) {
			s.SetOn()
		} else {
			s.SetOff()
		}
		return nil
	}
	return s.LightControl.UpdateValue(property, value)
}

type reolinkPTZ struct {
	*sdk.PTZControl
	cam         *reolinkCamera
	unsupported atomic.Bool
}

func newReolinkPTZ(cam *reolinkCamera) *reolinkPTZ {
	s := &reolinkPTZ{
		PTZControl: sdk.NewPTZControl("Reolink PTZ"),
		cam:        cam,
	}

	// Advertise only the axes the camera's Support report confirmed.
	var caps []string
	if cam.settings.PTZPan {
		caps = append(caps, string(sdk.PTZCapabilityPan))
	}
	if cam.settings.PTZTilt {
		caps = append(caps, string(sdk.PTZCapabilityTilt))
	}
	if cam.settings.PTZZoom {
		caps = append(caps, string(sdk.PTZCapabilityZoom))
	}
	s.SetCapabilities(caps)
	return s
}

func (s *reolinkPTZ) SetVelocity(value sdk.PTZDirection) {
	if s.unsupported.Load() {
		return
	}

	command, speed := ptzCommand(value)

	ctx, cancel := context.WithTimeout(context.Background(), controlTimeout)
	defer cancel()
	if err := s.cam.bridgeCam.PTZ(ctx, command, speed); err != nil {
		var statusErr *baichuan.StatusError
		if errors.As(err, &statusErr) && s.unsupported.CompareAndSwap(false, true) {
			s.cam.logger.Warn("Camera rejected PTZ command (not a PTZ model?) — disabling PTZ control. Re-adopt the camera without PTZ to remove the sensor.")
			return
		}
		if !s.unsupported.Load() {
			s.cam.logger.Error("PTZ command failed:", err)
		}
		return
	}
	s.PTZControl.SetVelocity(value)
	s.SetMoving(command != "Stop")
}

func (s *reolinkPTZ) UpdateValue(property string, value any) error {
	if property == "velocity" {
		if direction, ok := toPTZDirection(value); ok {
			s.SetVelocity(direction)
			return nil
		}
	}
	return s.PTZControl.UpdateValue(property, value)
}

func ptzCommand(direction sdk.PTZDirection) (string, int) {
	pan, tilt, zoom := direction.PanSpeed, direction.TiltSpeed, direction.ZoomSpeed

	magnitude := math.Max(math.Abs(pan), math.Abs(tilt))
	if math.Abs(zoom) > magnitude {
		if zoom > 0 {
			return "ZoomInc", ptzSpeed(zoom)
		}
		return "ZoomDec", ptzSpeed(zoom)
	}
	if magnitude < 0.05 {
		return "Stop", 0
	}

	var command string
	switch {
	case math.Abs(tilt) < 0.3*math.Abs(pan):
		command = pick(pan > 0, "Right", "Left")
	case math.Abs(pan) < 0.3*math.Abs(tilt):
		command = pick(tilt > 0, "Up", "Down")
	default:
		command = pick(pan > 0, "Right", "Left") + pick(tilt > 0, "Up", "Down")
	}
	return command, ptzSpeed(magnitude)
}

func ptzSpeed(v float64) int {
	speed := int(math.Round(math.Abs(v) * 32))
	if speed < 1 {
		speed = 1
	}
	if speed > 32 {
		speed = 32
	}
	return speed
}

func pick(cond bool, a string, b string) string {
	if cond {
		return a
	}
	return b
}

func toPTZDirection(value any) (sdk.PTZDirection, bool) {
	if direction, ok := value.(sdk.PTZDirection); ok {
		return direction, true
	}
	values, ok := value.(map[string]any)
	if !ok {
		return sdk.PTZDirection{}, false
	}
	direction := sdk.PTZDirection{}
	if v, ok := toFloat(values["panSpeed"]); ok {
		direction.PanSpeed = v
	}
	if v, ok := toFloat(values["tiltSpeed"]); ok {
		direction.TiltSpeed = v
	}
	if v, ok := toFloat(values["zoomSpeed"]); ok {
		direction.ZoomSpeed = v
	}
	return direction, true
}

func toFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	default:
		return 0, false
	}
}
