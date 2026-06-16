from __future__ import annotations

import struct
from typing import Any

import numpy as np

# WAV format codes
_FMT_PCM = 1
_FMT_IEEE_FLOAT = 3
_FMT_ALAW = 6
_FMT_MULAW = 7


def _build_alaw_table() -> np.ndarray[Any, Any]:
    """Build ITU-T G.711 A-law to linear PCM16 lookup table."""
    table = np.empty(256, dtype=np.int16)
    for i in range(256):
        val = i ^ 0x55
        seg = (val >> 4) & 0x07
        quant = val & 0x0F
        t = quant << 4
        if seg == 0:
            t += 8
        elif seg == 1:
            t += 0x108
        else:
            t = (t + 0x108) << (seg - 1)
        table[i] = t if (val & 0x80) else -t
    return table


def _build_ulaw_table() -> np.ndarray[Any, Any]:
    """Build ITU-T G.711 mu-law to linear PCM16 lookup table."""
    table = np.empty(256, dtype=np.int16)
    for i in range(256):
        val = ~i & 0xFF
        seg = (val >> 4) & 0x07
        quant = val & 0x0F
        t = ((quant << 3) + 0x84) << seg
        table[i] = (0x84 - t) if (val & 0x80) else (t - 0x84)
    return table


_ALAW_TABLE = _build_alaw_table()
_ULAW_TABLE = _build_ulaw_table()


def _decode_pcm(data: bytes, bits_per_sample: int) -> np.ndarray[Any, Any]:
    """Decode linear PCM audio data to float32."""
    if bits_per_sample == 8:
        return (np.frombuffer(data, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    elif bits_per_sample == 16:
        return np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0
    elif bits_per_sample == 24:
        n_samples = len(data) // 3
        raw = np.frombuffer(data[: n_samples * 3], dtype=np.uint8).reshape(-1, 3)
        samples = (
            raw[:, 0].astype(np.int32)
            | (raw[:, 1].astype(np.int32) << 8)
            | (raw[:, 2].astype(np.int32) << 16)
        )
        samples[samples >= 0x800000] -= 0x1000000
        return samples.astype(np.float32) / 8388608.0
    elif bits_per_sample == 32:
        return np.frombuffer(data, dtype=np.int32).astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f"Unsupported PCM bit depth: {bits_per_sample}")


def decode_wav(data: bytes) -> tuple[np.ndarray[Any, Any], int]:
    """Decode WAV file bytes to mono float32 waveform and sample rate.

    Supports PCM (8/16/24/32-bit), IEEE float (32/64-bit), A-law, and mu-law.
    """
    if len(data) < 12:
        raise ValueError("Data too short to be a valid WAV file")

    riff, _, wave = struct.unpack_from("<4sI4s", data, 0)
    if riff != b"RIFF" or wave != b"WAVE":
        raise ValueError("Not a valid WAV file")

    fmt_code = 0
    channels = 0
    sample_rate = 0
    bits_per_sample = 0
    audio_data = b""

    offset = 12
    while offset < len(data) - 8:
        chunk_id, chunk_size = struct.unpack_from("<4sI", data, offset)
        offset += 8

        if chunk_id == b"fmt ":
            if chunk_size < 16:
                raise ValueError("Invalid fmt chunk")
            fmt_code, channels, sample_rate, _, _, bits_per_sample = struct.unpack_from(
                "<HHIIHH", data, offset
            )
        elif chunk_id == b"data":
            audio_data = data[offset : offset + chunk_size]

        offset += chunk_size
        if chunk_size % 2:
            offset += 1

    if not audio_data:
        raise ValueError("No audio data found in WAV file")

    if fmt_code == _FMT_PCM:
        waveform = _decode_pcm(audio_data, bits_per_sample)
    elif fmt_code == _FMT_IEEE_FLOAT:
        if bits_per_sample == 32:
            waveform = np.frombuffer(audio_data, dtype=np.float32).copy()
        elif bits_per_sample == 64:
            waveform = np.frombuffer(audio_data, dtype=np.float64).astype(np.float32)
        else:
            raise ValueError(f"Unsupported float bit depth: {bits_per_sample}")
    elif fmt_code == _FMT_ALAW:
        raw = np.frombuffer(audio_data, dtype=np.uint8)
        waveform = _ALAW_TABLE[raw].astype(np.float32) / 32768.0
    elif fmt_code == _FMT_MULAW:
        raw = np.frombuffer(audio_data, dtype=np.uint8)
        waveform = _ULAW_TABLE[raw].astype(np.float32) / 32768.0
    else:
        raise ValueError(f"Unsupported WAV format code: {fmt_code}")

    if channels > 1:
        waveform = waveform.reshape(-1, channels).mean(axis=1)

    return waveform.astype(np.float32), sample_rate
