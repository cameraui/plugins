from __future__ import annotations

from typing import Literal

YAMNET_MODEL_URL = "https://models.cameraui.com/v1/audio-yamnet/yamnet.tflite"
YAMNET_LABELS_URL = "https://models.cameraui.com/v1/audio-yamnet/yamnet_class_map.csv"

YAMNET_SAMPLE_RATE = 16000
YAMNET_CHANNELS = 1
YAMNET_FORMAT: Literal["pcm16", "float32"] = "float32"
YAMNET_SAMPLES_PER_FRAME = 15600  # 0.975s at 16kHz — YAMNet's fixed input window

DEFAULT_LISTEN_LABELS: list[str] = [
    "Bark",
    "Fire alarm",
    "Screaming",
    "Speech",
    "Yell",
    "Glass",
    "Gunshot, gunfire",
    "Siren",
    "Smoke detector, smoke alarm",
    "Crying, sobbing",
    "Baby cry, infant cry",
    "Dog",
    "Cat",
    "Alarm",
    "Car alarm",
    "Door",
    "Knock",
    "Breaking",
]

DEFAULT_THRESHOLD: float = 0.7

LISTEN_SET = set(DEFAULT_LISTEN_LABELS)

YAMNET_TO_LABEL: dict[str, str] = {
    "Speech": "speaking",
    "Bark": "dog_bark",
    "Dog": "dog_bark",
    "Cat": "cat",
    "Siren": "siren",
    "Fire alarm": "alarm",
    "Alarm": "alarm",
    "Car alarm": "car_alarm",
    "Glass": "glass_break",
    "Breaking": "glass_break",
    "Gunshot, gunfire": "gunshot",
    "Screaming": "scream",
    "Yell": "scream",
    "Crying, sobbing": "baby_cry",
    "Baby cry, infant cry": "baby_cry",
    "Smoke detector, smoke alarm": "smoke_alarm",
    "Door": "doorbell",
    "Knock": "doorbell",
}
