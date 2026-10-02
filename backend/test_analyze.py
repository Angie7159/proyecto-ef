import truststore

truststore.inject_into_ssl()

import json
import sys
from pathlib import Path

from app.services.analyze import GROQ_MODEL, analizar_transcripcion


def main() -> int:
    if len(sys.argv) != 2:
        print("Uso: py -3.12 test_analyze.py <archivo_transcripcion>", file=sys.stderr)
        return 2

    transcript_path = Path(sys.argv[1])
    if not transcript_path.is_file():
        print(f"No existe el archivo: {transcript_path}", file=sys.stderr)
        return 2

    try:
        transcript = transcript_path.read_text(encoding="utf-8")
        analysis = analizar_transcripcion(transcript, model=GROQ_MODEL)
        formatted = json.dumps(analysis, ensure_ascii=False, indent=2)
        print(formatted)

        output_path = Path("test_analysis_output.json")
        output_path.write_text(formatted + "\n", encoding="utf-8")
        print(f"\nResultado guardado en: {output_path.resolve()}")
        return 0
    except Exception as exc:
        print(f"Error al analizar la transcripción: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
