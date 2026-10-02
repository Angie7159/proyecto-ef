import os
import tempfile
from pathlib import PurePosixPath
from typing import Any
from urllib.parse import unquote, urlparse
from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.routers._common import raise_database_error
from app.services.transcribe import WhisperService
from app.supabase_client import get_supabase

router = APIRouter(prefix="/transcripcion", tags=["Transcripción"])


def _storage_object_path(audio_url: str) -> str:
    parsed = urlparse(audio_url)
    raw_path = unquote(parsed.path if parsed.scheme else audio_url)
    marker = "/storage/v1/object/"

    if marker in raw_path:
        object_parts = raw_path.split(marker, maxsplit=1)[1].split("/")
        if object_parts and object_parts[0] in {"public", "sign", "authenticated"}:
            object_parts.pop(0)
        if not object_parts or object_parts.pop(0) != "audios":
            raise ValueError("La URL de audio no pertenece al bucket 'audios'.")
        object_path = "/".join(object_parts)
    else:
        object_path = raw_path.lstrip("/")
        if object_path.startswith("audios/"):
            object_path = object_path.removeprefix("audios/")

    if not object_path or ".." in PurePosixPath(object_path).parts:
        raise ValueError("No se pudo extraer una ruta válida del audio.")
    return object_path


@router.post("/procesar/{reunion_id}")
def procesar_transcripcion(reunion_id: UUID) -> dict[str, Any]:
    temporary_path: str | None = None

    try:
        supabase = get_supabase()
        meeting_response = (
            supabase.table("reuniones")
            .select("id, audio_url")
            .eq("id", str(reunion_id))
            .maybe_single()
            .execute()
        )
        meeting = meeting_response.data
        if meeting is None:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")

        audio_url = meeting.get("audio_url")
        if not audio_url:
            raise HTTPException(status_code=400, detail="La reunión no tiene un audio asociado.")

        try:
            storage_path = _storage_object_path(audio_url)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        print(f"Descargando audio desde Supabase Storage: {storage_path}")
        audio_content = supabase.storage.from_("audios").download(storage_path)
        if not audio_content:
            raise HTTPException(status_code=500, detail="Supabase devolvió un archivo de audio vacío.")

        suffix = PurePosixPath(storage_path).suffix or ".audio"
        with tempfile.NamedTemporaryFile(mode="wb", suffix=suffix, delete=False) as temporary_file:
            temporary_file.write(audio_content)
            temporary_path = temporary_file.name

        transcription = WhisperService.get_instance().transcribir(temporary_path)

        print(f"Guardando transcripción de la reunión {reunion_id}...")
        supabase.table("reuniones").update(
            {
                "transcripcion": transcription["texto"],
                "estado": "pendiente_asignacion",
            }
        ).eq("id", str(reunion_id)).execute()
        print("Transcripción guardada.")

        text = transcription["texto"]
        return {
            "reunion_id": str(reunion_id),
            "duracion_seg": transcription["duracion_total_seg"],
            "caracteres_transcritos": len(text),
            "preview": text[:200],
        }
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Error procesando la transcripción de {reunion_id}: {exc}")
        raise HTTPException(
            status_code=500,
            detail="No se pudo descargar, transcribir o guardar el audio.",
        ) from exc
    finally:
        if temporary_path and os.path.exists(temporary_path):
            try:
                os.remove(temporary_path)
                print("Archivo temporal eliminado.")
            except OSError as exc:
                print(f"No se pudo eliminar el archivo temporal: {exc}")
