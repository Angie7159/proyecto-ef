from datetime import datetime
import json
from threading import BoundedSemaphore, Lock, Thread
from time import monotonic
import traceback
from typing import Any
from urllib.parse import parse_qs, unquote, urlparse
from uuid import UUID
from zoneinfo import ZoneInfo
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from app.services.analyze import analizar_transcripcion
from app.services.documents.excel import generar_excel
from app.services.documents.word import generar_word_mapa_mental, generar_word_resumen
from app.services.meeting_bot import LOG_DIR, TeamsBot, _bots_activos, _bots_activos_lock
from app.supabase_client import get_supabase

router = APIRouter(prefix="/bot", tags=["Bot de Teams"])
_BOT_SLOTS = BoundedSemaphore(3)
_RUNS: dict[str, dict[str, Any]] = {}
_RUNS_LOCK = Lock()
_LIMA = ZoneInfo("America/Lima")


class AgregarReunionLink(BaseModel):
    meeting_url: str = Field(min_length=1)
    titulo: str = Field(min_length=1, max_length=300)
    comite_id: UUID | None = None
    duracion_min: int = Field(default=30, ge=1, le=120)


def _meeting_id(meeting_url: str) -> str | None:
    parsed = urlparse(meeting_url)
    query = parse_qs(parsed.query)
    for key in ("meetingId", "meetingid", "threadId"):
        if query.get(key):
            return unquote(query[key][0])[:255]
    parts = [unquote(part) for part in parsed.path.split("/") if part]
    if "meetup-join" in parts:
        index = parts.index("meetup-join")
        return parts[index + 1][:255] if len(parts) > index + 1 else None
    return None


def _set_run(reunion_id: str, **values: Any) -> None:
    with _RUNS_LOCK:
        _RUNS.setdefault(reunion_id, {}).update(values)


def _update_meeting(reunion_id: str, fields: dict[str, Any]) -> None:
    get_supabase().table("reuniones").update(fields).eq("id", reunion_id).execute()


def _process_bot_transcript(reunion_id: str, transcript: str, partial: bool = False) -> None:
    """Aplica análisis y documentos existentes sobre subtítulos (sin requerir audio)."""
    supabase = get_supabase()
    meeting_result = (
        supabase.table("reuniones").select("*, comites(nombre, color)")
        .eq("id", reunion_id).maybe_single().execute()
    )
    meeting = meeting_result.data
    if not meeting:
        raise RuntimeError("No se encontró la reunión para procesar.")
    committee = meeting.get("comites")
    if isinstance(committee, list):
        committee = committee[0] if committee else None
    committee_name = committee.get("nombre", "") if isinstance(committee, dict) else ""
    analysis = analizar_transcripcion(transcript, committee_name)
    committee_id = meeting.get("comite_id")
    agreements = analysis["acuerdos_alcanzados"]
    if agreements and not committee_id:
        raise RuntimeError("Asigna un comité a la reunión antes de guardar los acuerdos detectados.")

    previous = supabase.table("acuerdos").select("*").eq("reunion_id", reunion_id).execute().data or []
    new_agreements = [
        {
            "reunion_id": reunion_id,
            "comite_id": committee_id,
            "descripcion": item["descripcion"],
            "responsable": item["responsable"] or None,
            "fecha_limite": item["fecha_limite"],
            "categoria": item["categoria"],
            "estado": "pendiente",
            "es_nuevo": True,
        }
        for item in agreements
    ]
    supabase.table("reuniones").update({
        "resumen_ejecutivo": analysis["resumen_ejecutivo"],
        "problemas_identificados": analysis["problemas_identificados"],
        "puntos_clave": analysis["puntos_clave"],
        "progreso": "bot_generando_documentos",
    }).eq("id", reunion_id).execute()
    if new_agreements:
        supabase.table("acuerdos").insert(new_agreements).execute()
    meeting.update({
        "resumen_ejecutivo": analysis["resumen_ejecutivo"],
        "problemas_identificados": analysis["problemas_identificados"],
        "puntos_clave": analysis["puntos_clave"],
    })
    files = {
        "archivo_excel_url": ("resumen.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", generar_excel(meeting, new_agreements, previous)),
        "archivo_word_resumen_url": ("resumen.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", generar_word_resumen(meeting, previous + new_agreements)),
        "archivo_word_smartart_url": ("mapa_mental.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", generar_word_mapa_mental(meeting)),
    }
    updates: dict[str, Any] = {}
    for field, (filename, media_type, content) in files.items():
        path = f"{reunion_id}/{filename}"
        supabase.storage.from_("documentos").upload(
            path, content, file_options={"content-type": media_type, "upsert": "true"}
        )
        updates[field] = supabase.storage.from_("documentos").get_public_url(path)
    updates.update({
        "estado": "procesada",
        "error_mensaje": None,
        "progreso": "bot_procesada_parcial" if partial else "¡Listo!",
    })
    supabase.table("reuniones").update(updates).eq("id", reunion_id).execute()


def _save_interrupted_capture(reunion_id: str, result: dict, reason: str, requested_duration_min: int) -> None:
    transcript = str(result.get("transcripcion_completa", "")).strip()
    captured_seconds = int(result.get("duracion_seg", 0))
    has_pipeline_text = len(transcript) >= 50
    progress = "bot_detenido_manual" if reason == "manual" else "bot_detenido"
    message = (
        "bot_detenido_manual: El bot fue detenido manualmente. Se guardó lo capturado hasta el momento."
        if reason == "manual"
        else "navegador fue cerrado: El navegador fue cerrado antes de terminar. Se guardó lo capturado hasta el momento."
    )
    _update_meeting(reunion_id, {
        "transcripcion": transcript or None,
        "hora_fin": datetime.now(_LIMA).time().replace(tzinfo=None).isoformat(timespec="seconds"),
        "duracion_min": max(1, round(captured_seconds / 60)) if captured_seconds else 0,
        "estado": "en_proceso" if has_pipeline_text else "error",
        "progreso": progress,
        "error_mensaje": message,
    })
    _set_run(reunion_id, progreso=progress, estado="en_proceso" if has_pipeline_text else "error", subtitulos_capturados=len(result.get("segmentos", [])))
    if has_pipeline_text:
        _process_bot_transcript(
            reunion_id,
            transcript,
            partial=captured_seconds < requested_duration_min * 60,
        )
        _set_run(reunion_id, progreso="bot_procesada_parcial", estado="procesada")


def _run_bot(reunion_id: str, meeting_url: str, duration_min: int) -> None:
    bot: TeamsBot | None = None
    try:
        _set_run(reunion_id, started=monotonic(), captured=0)
        bot = TeamsBot(meeting_url, headless=False, timeout_seconds=duration_min * 60, reunion_id=reunion_id)
        with _bots_activos_lock:
            _bots_activos[reunion_id] = bot

        def on_bot_status(status: str) -> None:
            progress_label = "bot_en_espera" if status == "waiting_room" else "bot_unido"
            _update_meeting(reunion_id, {"progreso": progress_label})
            _set_run(reunion_id, progreso=progress_label, estado="en_proceso")

        bot.status_callback = on_bot_status
        result = bot.join()
        if bot._stop_requested or bot._browser_closed or result.get("status") == "browser_closed":
            stopped_result = bot.stop()
            _save_interrupted_capture(
                reunion_id,
                stopped_result,
                "manual" if bot._stop_requested else "browser_closed",
                duration_min,
            )
            return
        progress = "bot_unido" if result["status"] == "joined" else (
            "bot_en_espera" if result["status"] == "waiting_room" else "bot_error"
        )
        updates: dict[str, Any] = {"progreso": progress}
        if not result["success"]:
            updates["error_mensaje"] = result["message"]
        _update_meeting(reunion_id, updates)
        _set_run(reunion_id, progreso=progress, estado="en_proceso")
        if not result["success"]:
            failure_message = (
                "El bot quedó en la sala de espera. Admítelo manualmente."
                if result["status"] == "waiting_room" else result["message"]
            )
            _update_meeting(reunion_id, {"estado": "error", "error_mensaje": failure_message})
            _set_run(reunion_id, estado="error")
            return

        def save_caption(_: str) -> None:
            with _RUNS_LOCK:
                _RUNS.setdefault(reunion_id, {})["captured"] = len(bot._segments) if bot else 0

        # Mantener el contexto de Playwright en este hilo durante la captura.
        bot.start_capturing_subtitles(save_caption)
        captured = bot.stop()
        if bot._stop_requested or bot._browser_closed:
            _save_interrupted_capture(
                reunion_id,
                captured,
                "manual" if bot._stop_requested else "browser_closed",
                duration_min,
            )
            return
        transcript = captured["transcripcion_completa"].strip()
        lima_now = datetime.now(_LIMA)
        fields = {
            "transcripcion": transcript or None,
            "hora_fin": lima_now.time().replace(tzinfo=None).isoformat(timespec="seconds"),
            "duracion_min": max(1, round(captured["duracion_seg"] / 60)) if captured["duracion_seg"] else duration_min,
            "progreso": "bot_subtitulos_capturados",
        }
        _update_meeting(reunion_id, fields)
        _set_run(reunion_id, progreso="bot_subtitulos_capturados", subtitulos_capturados=len(captured["segmentos"]))
        if not transcript:
            message = (
                "El bot no capturó subtítulos. Verifica que los subtítulos estén activados "
                "en la reunión de Teams y que la UI de Teams no haya cambiado."
            )
            _update_meeting(reunion_id, {
                "estado": "error",
                "progreso": "bot_sin_captura",
                "error_mensaje": message,
            })
            _set_run(reunion_id, estado="error", progreso="bot_sin_captura")
            return

        _update_meeting(reunion_id, {"progreso": "bot_procesando_pipeline"})
        _set_run(reunion_id, progreso="bot_procesando_pipeline")
        _process_bot_transcript(reunion_id, transcript)
        _set_run(reunion_id, progreso="procesada", estado="procesada")
    except Exception as exc:
        traceback.print_exc()
        prefix = "bot_detenido_manual: " if bot and bot._stop_requested else (
            "navegador fue cerrado: " if bot and bot._browser_closed else ""
        )
        message = f"{prefix}Error en el bot: {type(exc).__name__}: {exc}"
        print(f"[{datetime.now().strftime('%H:%M:%S')}] ❌ [{reunion_id}] {message}", flush=True)
        try:
            _update_meeting(reunion_id, {"estado": "error", "error_mensaje": message, "progreso": "bot_error"})
        except Exception as update_exc:
            print(f"No se pudo actualizar el estado de {reunion_id}: {update_exc}", flush=True)
        _set_run(reunion_id, progreso="bot_error", estado="error")
    finally:
        if bot:
            try:
                bot.stop()
            except Exception as exc:
                print(f"[{datetime.now().strftime('%H:%M:%S')}] ⚠️ Error cerrando bot {reunion_id}: {exc}", flush=True)
        with _bots_activos_lock:
            _bots_activos.pop(reunion_id, None)
        _BOT_SLOTS.release()


@router.post("/agregar-reunion-link")
def agregar_reunion_link(payload: AgregarReunionLink) -> dict:
    parsed = urlparse(payload.meeting_url)
    hostname = (parsed.hostname or "").casefold()
    if parsed.scheme != "https" or not (hostname == "teams.microsoft.com" or hostname.endswith(".teams.microsoft.com")):
        raise HTTPException(status_code=422, detail="La URL debe ser HTTPS y pertenecer a teams.microsoft.com.")
    if not _BOT_SLOTS.acquire(blocking=False):
        raise HTTPException(status_code=429, detail="Ya hay 3 bots activos. Intenta más tarde.")

    now = datetime.now(_LIMA)
    row = {
        "titulo_final": payload.titulo,
        "fecha": now.date().isoformat(),
        "hora_inicio": now.time().replace(tzinfo=None).isoformat(timespec="seconds"),
        "duracion_min": payload.duracion_min,
        "fuente": "bot_auto",
        "estado": "en_proceso",
        "progreso": "bot_enviado",
        "comite_id": str(payload.comite_id) if payload.comite_id else None,
        "teams_meeting_id": _meeting_id(payload.meeting_url),
    }
    try:
        response = get_supabase().table("reuniones").insert(row).execute()
        meeting = response.data[0] if response.data else None
        if not meeting or not meeting.get("id"):
            raise RuntimeError("Supabase no devolvió el registro de reunión insertado.")
    except Exception as exc:
        _BOT_SLOTS.release()
        raise HTTPException(status_code=500, detail=f"No se pudo crear la reunión: {exc}") from exc

    reunion_id = str(meeting["id"])
    _set_run(reunion_id, progreso="bot_enviado", estado="en_proceso", started=monotonic(), captured=0)
    worker = Thread(
        target=_run_bot,
        args=(reunion_id, payload.meeting_url, payload.duracion_min),
        name=f"teams-bot-{reunion_id}",
        daemon=True,
    )
    worker.start()
    return meeting


@router.get("/estado/{reunion_id}")
def estado_bot(reunion_id: UUID) -> dict:
    id_text = str(reunion_id)
    try:
        response = (
            get_supabase().table("reuniones").select("id, progreso, estado, error_mensaje")
            .eq("id", id_text).maybe_single().execute()
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"No se pudo consultar el estado: {exc}") from exc
    if not response.data:
        raise HTTPException(status_code=404, detail="Reunión no encontrada.")
    with _RUNS_LOCK:
        run = dict(_RUNS.get(id_text, {}))
    elapsed = int(monotonic() - run["started"]) if run.get("started") else 0
    return {
        "reunion_id": id_text,
        "progreso": response.data.get("progreso"),
        "estado": response.data.get("estado"),
        "tiempo_transcurrido_seg": elapsed,
        "subtitulos_capturados": run.get("captured", 0),
        "error_mensaje": response.data.get("error_mensaje"),
    }


@router.post("/detener/{reunion_id}")
def detener_bot(reunion_id: str) -> dict:
    with _bots_activos_lock:
        bot = _bots_activos.get(reunion_id)
    if bot is None:
        raise HTTPException(status_code=404, detail="No hay bot activo para esta reunión.")
    bot.detener()
    return {"success": True, "mensaje": "Detención solicitada. El bot cerrará en unos segundos."}


@router.get("/logs/{reunion_id}")
def obtener_logs_bot(reunion_id: UUID) -> dict:
    id_text = str(reunion_id)
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    screenshots = sorted({
        path.name
        for pattern in (
            f"{id_text}_frame_*.png",
            f"{id_text}_join_attempt_*.png",
            f"{id_text}_launcher_attempt_*.png",
            f"{id_text}_after_direct_nav_*.png",
            f"{id_text}_launcher_after_cleanup.png",
            f"{id_text}_launcher_no_change.png",
            f"{id_text}_before_direct_navigation.png",
            f"{id_text}_after_direct_navigation.png",
            f"{id_text}_unknown_state.png",
            f"{id_text}_teams_home.png",
            f"{id_text}_after_launcher_retry.png",
            f"{id_text}_stuck_in_launcher.png",
            f"{id_text}_before_launcher.png",
            f"{id_text}_after_launcher.png",
            f"{id_text}_before_join.png",
            f"{id_text}_after_join.png",
        )
        for path in LOG_DIR.glob(pattern)
    })
    pages = sorted({
        path.name
        for pattern in (
            f"{id_text}_page_*.html",
            f"{id_text}_launcher_failed_*.html",
            f"{id_text}_after_launcher.html",
        )
        for path in LOG_DIR.glob(pattern)
    })
    captions_path = LOG_DIR / f"{id_text}_subtitulos.json"
    try:
        captions = json.loads(captions_path.read_text(encoding="utf-8")) if captions_path.exists() else []
    except (OSError, json.JSONDecodeError):
        captions = []
    events_path = LOG_DIR / f"{id_text}_events.log"
    try:
        events = events_path.read_text(encoding="utf-8") if events_path.exists() else ""
    except OSError:
        events = ""
    return {
        "reunion_id": id_text,
        "screenshots": screenshots,
        "pages": pages,
        "subtitulos_capturados": captions,
        "eventos": events,
    }


@router.get("/logs/{reunion_id}/files/{filename}")
def descargar_log_bot(reunion_id: UUID, filename: str) -> FileResponse:
    id_text = str(reunion_id)
    allowed_name = Path(filename).name == filename and (
        (filename.startswith(f"{id_text}_frame_") and filename.endswith(".png"))
        or (filename.startswith(f"{id_text}_join_attempt_") and filename.endswith(".png"))
        or (filename.startswith(f"{id_text}_launcher_attempt_") and filename.endswith(".png"))
        or (filename.startswith(f"{id_text}_after_direct_nav_") and filename.endswith(".png"))
        or filename == f"{id_text}_launcher_after_cleanup.png"
        or filename in (
            f"{id_text}_before_direct_navigation.png",
            f"{id_text}_after_direct_navigation.png",
            f"{id_text}_unknown_state.png",
            f"{id_text}_teams_home.png",
            f"{id_text}_after_launcher_retry.png",
            f"{id_text}_stuck_in_launcher.png",
        )
        or (filename.startswith(f"{id_text}_launcher_failed_") and filename.endswith(".html"))
        or filename in (f"{id_text}_launcher_no_change.png", f"{id_text}_after_launcher.html")
        or filename in (
            f"{id_text}_before_launcher.png", f"{id_text}_after_launcher.png",
            f"{id_text}_before_join.png", f"{id_text}_after_join.png",
        )
        or (filename.startswith(f"{id_text}_page_") and filename.endswith(".html"))
    )
    if not allowed_name:
        raise HTTPException(status_code=404, detail="Archivo de diagnóstico no encontrado.")
    path = LOG_DIR / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Archivo de diagnóstico no encontrado.")
    media_type = "image/png" if filename.endswith(".png") else "text/html"
    return FileResponse(path, media_type=media_type)
