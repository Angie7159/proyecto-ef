import truststore

truststore.inject_into_ssl()

import argparse
import json
import sys
from pathlib import Path

from app.services.transcribe import WhisperService


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe un audio con faster-whisper.")
    parser.add_argument("audio_path", help="Ruta al archivo de audio o video")
    args = parser.parse_args()

    audio_path = Path(args.audio_path)
    if not audio_path.is_file():
        parser.error(f"No existe el archivo: {audio_path}")

    try:
        result = WhisperService.get_instance().transcribir(str(audio_path))
        print(json.dumps(result, ensure_ascii=False, indent=2))

        output_path = Path("test_transcription_output.txt")
        output_path.write_text(result["texto"], encoding="utf-8")
        print(f"\nTranscripción completa guardada en: {output_path.resolve()}")
        return 0
    except Exception as exc:
        print(f"Error al transcribir: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
