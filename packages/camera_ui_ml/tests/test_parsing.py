from __future__ import annotations

import numpy as np

from camera_ui_ml.parsing import decode_ocr

ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_"
SLOTS = 10


def distribution(text: str, winner: float = 0.999) -> np.ndarray:
    """A cct-style output: one softmaxed distribution per slot, padded to the end."""
    rest = (1.0 - winner) / (len(ALPHABET) - 1)
    logits = np.full((SLOTS, len(ALPHABET)), rest, dtype=np.float32)
    for slot in range(SLOTS):
        char = text[slot] if slot < len(text) else "_"
        logits[slot, ALPHABET.index(char)] = winner
    return logits


def test_reads_a_confident_plate():
    text, confidence = decode_ocr(distribution("NEWB811"), ALPHABET)
    assert text == "NEWB811"
    assert confidence > 0.99


def test_keeps_an_unsure_read_low():
    text, confidence = decode_ocr(distribution("NEWB811", winner=0.4), ALPHABET)
    assert text == "NEWB811"
    assert 0.3 < confidence < 0.5


def test_accepts_raw_logits():
    logits = np.full((SLOTS, len(ALPHABET)), -10.0, dtype=np.float32)
    for slot in range(SLOTS):
        char = "AB12"[slot] if slot < 4 else "_"
        logits[slot, ALPHABET.index(char)] = 10.0

    text, confidence = decode_ocr(logits, ALPHABET)
    assert text == "AB12"
    assert confidence > 0.99
