#!/usr/bin/env python3
# align.py
#
# Stage 26.9B, Part 7/8 — invoked as a subprocess by
# whisper-alignment-provider.js via execFileSync with an explicit argument
# array (never a shell string). Takes a real audio file and returns REAL,
# MEASURED word-level timestamps via faster-whisper — never word-count/WPM
# estimation. Always prints exactly one line of JSON to stdout and exits 0;
# the caller distinguishes success/failure via the JSON "ok" field, never
# via stderr scraping or exit code alone.
#
# argv: audio_path, model_size, download_root

import sys
import json


def main():
    if len(sys.argv) < 4:
        print(json.dumps({'ok': False, 'error': 'usage: align.py <audio_path> <model_size> <download_root>'}))
        return

    audio_path, model_size, download_root = sys.argv[1], sys.argv[2], sys.argv[3]

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        print(json.dumps({'ok': False, 'error': f'faster_whisper is not installed: {exc}'}))
        return

    try:
        model = WhisperModel(model_size, device='cpu', compute_type='int8', download_root=download_root)
        segments, info = model.transcribe(audio_path, word_timestamps=True)
        words = []
        for segment in segments:
            for w in segment.words:
                words.append({
                    'word': w.word.strip(),
                    'start': round(w.start, 3),
                    'end': round(w.end, 3),
                    'confidence': round(w.probability, 4),
                })
        print(json.dumps({'ok': True, 'language': info.language, 'words': words}))
    except Exception as exc:  # noqa: BLE001 - always report structurally, never let a raw traceback be the only output
        print(json.dumps({'ok': False, 'error': f'{type(exc).__name__}: {exc}'}))


if __name__ == '__main__':
    main()
