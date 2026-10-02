from pathlib import Path
from threading import Lock
from time import perf_counter
from typing import Any

from app.config import get_settings


class WhisperService:
    _instance: "WhisperService | None" = None
    _instance_lock = Lock()

    def __init__(self) -> None:
        if getattr(self, "_initialized", False):
            return

        self.model_name = get_settings().whisper_model
        print(f"Cargando modelo Whisper '{self.model_name}' en CPU (int8)...")
        try:
            from faster_whisper import WhisperModel

            self.model = WhisperModel(
                self.model_name,
                device="cpu",
                compute_type="int8",
            )
        except Exception as exc:
            raise RuntimeError(
                f"No se pudo cargar el modelo Whisper '{self.model_name}'. "
                "Comprueba la instalación de faster-whisper y la conexión para descargar el modelo."
            ) from exc

        self._initialized = True
        print(f"Modelo Whisper '{self.model_name}' cargado.")

    @classmethod
    def get_instance(cls) -> "WhisperService":
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls()
        return cls._instance

    def transcribir(self, audio_path: str) -> dict[str, Any]:
        path = Path(audio_path)
        if not path.is_file():
            raise FileNotFoundError(f"No existe el archivo de audio: {path}")

        print(f"Transcribiendo archivo: {path.name}...")
        started_at = perf_counter()

        try:
            segments_iterator, info = self.model.transcribe(
                str(path),
                language="es",
                beam_size=5,
                vad_filter=True,
                word_timestamps=False,
            )

            segments: list[dict[str, Any]] = []
            text_parts: list[str] = []
            last_segment_end = 0.0
            for segment in segments_iterator:
                segment_text = segment.text.strip()
                segments.append(
                    {
                        "inicio": float(segment.start),
                        "fin": float(segment.end),
                        "texto": segment_text,
                    }
                )
                if segment_text:
                    text_parts.append(segment_text)
                last_segment_end = max(last_segment_end, float(segment.end))

            duration = getattr(info, "duration", None)
            if duration is None:
                duration = last_segment_end

            result = {
                "texto": " ".join(text_parts).strip(),
                "segmentos": segments,
                "duracion_total_seg": float(duration),
                "idioma_detectado": info.language,
                "modelo": self.model_name,
            }
        except Exception as exc:
            raise RuntimeError(f"Falló la transcripción del archivo '{path.name}'.") from exc

        elapsed = perf_counter() - started_at
        print(f"Listo en {elapsed:.1f} segundos.")
        return result
