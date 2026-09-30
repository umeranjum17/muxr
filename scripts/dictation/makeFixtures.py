#!/usr/bin/env python3
"""Rebuild the dictation fixtures from fixtures/fixtures.json.

Speech is Piper TTS with the en_US-ljspeech-high voice (trained from scratch on
the public-domain LJ Speech set). A lower-pitched speaker is the same voice
pitch-shifted. Hiss is seeded pink noise; babble is three other LJ Speech voice
sentences at different pitches, mixed. Nothing is recorded from a microphone.

Needs `piper` (pip install piper-tts), ffmpeg and numpy, and the voice:
  https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ljspeech/high/en_US-ljspeech-high.onnx
  (and its .onnx.json next to it)

usage: makeFixtures.py <en_US-ljspeech-high.onnx> [manifest.json]
The WAVs are written next to the manifest (default fixtures/fixtures.json).
"""
import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent / 'fixtures'
RATE = 16_000
LEAD_S = 0.4
TAIL_S = 0.6
BABBLE = [
    'The weather was warm and the market stayed open late into the evening.',
    'He carried the boxes upstairs and left them by the door of the office.',
    'Most of the letters arrived on time, though a few were lost on the way.',
]


def speak(voice: str, text: str, length_scale: float = 1.0, pitch: float = 1.0, pause: float = 0.3) -> np.ndarray:
    raw = subprocess.run(
        ['piper', '-m', voice, '--output-raw', '--length-scale', str(length_scale), '--sentence-silence', str(pause)],
        input=text.encode(), capture_output=True, check=True,
    ).stdout
    # Piper speaks at 22.05 kHz; resample (and shift pitch, keeping tempo) to 16 kHz.
    shift = f'asetrate={22050 * pitch:.0f},aresample=22050,atempo={1 / pitch:.4f},' if pitch != 1.0 else ''
    pcm = subprocess.run(
        ['ffmpeg', '-v', 'error', '-f', 's16le', '-ar', '22050', '-ac', '1', '-i', '-',
         '-af', f'{shift}aresample={RATE}', '-f', 's16le', '-ac', '1', '-'],
        input=raw, capture_output=True, check=True,
    ).stdout
    return np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768


def pink(samples: int, seed: int) -> np.ndarray:
    white = np.fft.rfft(np.random.default_rng(seed).standard_normal(samples))
    white[1:] /= np.sqrt(np.arange(1, len(white)))
    return np.fft.irfft(white, samples).astype(np.float32)


def rms(signal: np.ndarray) -> float:
    return float(np.sqrt(np.mean(signal ** 2)))


def reverb(signal: np.ndarray, rt60: float) -> np.ndarray:
    # A synthetic room: exponentially decaying noise as the impulse response.
    t = np.arange(int(rt60 * RATE)) / RATE
    response = np.random.default_rng(11).standard_normal(len(t)) * np.exp(-6.9 * t / rt60)
    response[0] = 1.0
    wet = np.convolve(signal, response)[: len(signal)]
    return (wet * rms(signal) / rms(wet)).astype(np.float32)


def main(voice: str, manifest_path: Path) -> None:
    manifest = json.loads(manifest_path.read_text())
    for fixture in manifest['fixtures']:
        speech = speak(voice, fixture.get('speak', fixture['text']), fixture.get('lengthScale', 1.0), fixture.get('pitch', 1.0), fixture.get('pause', 0.3))
        if 'reverbS' in fixture:
            speech = reverb(speech, fixture['reverbS'])
        audio = np.concatenate([np.zeros(int(LEAD_S * RATE), np.float32), speech, np.zeros(int(TAIL_S * RATE), np.float32)])
        noise = fixture.get('noise')
        if noise:
            if noise['type'] == 'pink':
                background = pink(len(audio), seed=7)
            else:
                voices = [speak(voice, line, 1.0, pitch) for line, pitch in zip(BABBLE, [0.8, 1.0, 1.15])]
                background = np.zeros(len(audio), np.float32)
                for other in voices:
                    background += np.resize(other, len(audio))
            speech_rms = rms(speech[np.abs(speech) > 0.01])
            background *= speech_rms / (rms(background) * 10 ** (noise['snrDb'] / 20))
            audio = audio + background
        audio /= max(1.0, float(np.max(np.abs(audio))) / 0.9)
        if 'speechRmsDb' in fixture:
            # A quiet phone microphone: scale so the speech sits at this level (dBFS RMS).
            audio *= 10 ** (fixture['speechRmsDb'] / 20) / rms(audio[np.abs(audio) > 0.01 * np.max(np.abs(audio))])
        with wave.open(str(manifest_path.parent / f"{fixture['id']}.wav"), 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(RATE)
            out.writeframes((audio * 32767).astype('<i2').tobytes())
        print(f"{fixture['id']}: {len(audio) / RATE:.1f} s")


if __name__ == '__main__':
    main(sys.argv[1], Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / 'fixtures.json')
