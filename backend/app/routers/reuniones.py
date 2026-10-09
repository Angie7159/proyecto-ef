import os
import tempfile
from datetime import date, datetime
from pathlib import PurePosixPath
from time import perf_counter
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException, Response, status

from app.routers._common import raise_database_error
from app.schemas.reunion import (
    AsignarComiteRequest,
    EstadoReunion,
    ReunionListItem,
    ReunionResponse,
)
from app.routers.transcripcion import _storage_object_path
from app.services.analyze import analizar_transcripcion
from app.services.documents.excel import generar_excel
from app.services.documents.word import generar_word_mapa_mental, generar_word_resumen
from app.services.transcribe import WhisperService
from app.supabase_client import get_supabase

router = APIRouter(prefix="/reuniones", tags=["Reuniones"])


@router.get("/", response_model=list[ReunionListItem])
def listar_reuniones(
    comite_id: str | None = None,
    estado: EstadoReunion | None = None,
    buscar: str | None = None,
    fecha_desde: date | None = None,
    fecha_hasta: date | None = None,
) -> list[dict]:
    try:
        query = get_supabase().table("vista_dashboard_reuniones").select("*")
        if comite_id:
            query = query.eq("comite_id", comite_id)
        if estado:
            query = query.eq("estado", estado)
        if buscar and buscar.strip():
            query = query.ilike("titulo", f"%{buscar.strip()}%")
        if fecha_desde:
            query = query.gte("fecha", fecha_desde.isoformat())
        if fecha_hasta:
            query = query.lte("fecha", fecha_hasta.isoformat())
        response = query.order("fecha", desc=True).execute()
        return response.data or []
    except Exception as exc:
        raise_database_error(exc, "listar las reuniones")


@router.get("/{reunion_id}", response_model=ReunionResponse)
def obtener_reunion(reunion_id: str) -> dict:
    try:
        response = (
            get_supabase()
            .table("reuniones")
            .select("*, comites(nombre, color)")
            .eq("id", reunion_id)
            .maybe_single()
            .execute()
        )
        if response.data is None:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")
        return response.data
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "obtener la reunión")


@router.patch("/{reunion_id}/asignar-comite", response_model=ReunionResponse)
def asignar_comite(reunion_id: str, payload: AsignarComiteRequest) -> dict:
    try:
        response = (
            get_supabase()
            .table("reuniones")
            .update({"comite_id": payload.comite_id, "estado": "procesada"})
            .eq("id", reunion_id)
            .select("*, comites(nombre, color)")
            .maybe_single()
            .execute()
        )
        if response.data is None:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")
        return response.data
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "asignar el comité a la reunión")


@router.delete("/{reunion_id}", status_code=status.HTTP_204_NO_CONTENT)
def eliminar_reunion(reunion_id: str) -> Response:
    try:
        response = (
            get_supabase()
            .table("reuniones")
            .delete()
            .eq("id", reunion_id)
            .select("id")
            .execute()
        )
        if not response.data:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")
        return Response(status_code=status.HTTP_204_NO_CONTENT)
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "eliminar la reunión")


@router.post("/{reunion_id}/reanalizar")
def reanalizar_reunion(reunion_id: str) -> dict[str, Any]:
    """Re-ejecuta análisis y documentos desde la transcripción almacenada."""
    supabase = get_supabase()
    try:
        result = (
            supabase.table("reuniones").select("*")
            .eq("id", reunion_id).maybe_single().execute()
        )
        reunion = result.data
        if reunion is None:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")
        transcript = reunion.get("transcripcion")
        if not isinstance(transcript, str) or not transcript.strip():
            raise HTTPException(
                status_code=400,
                detail="La reunión no tiene transcripción. No se puede re-analizar.",
            )
        if reunion.get("fuente") != "bot_auto":
            raise HTTPException(status_code=400, detail="El reanálisis está disponible para reuniones del bot.")

        committee_name = ""
        committee_id = reunion.get("comite_id")
        if committee_id:
            committee_result = (
                supabase.table("comites").select("nombre")
                .eq("id", committee_id).maybe_single().execute()
            )
            if committee_result.data:
                committee_name = committee_result.data.get("nombre", "")

        print(f"[{datetime.now().strftime('%H:%M:%S')}] 🔁 Re-analizando reunión {reunion_id}...", flush=True)
        analysis = analizar_transcripcion(transcript, committee_name)
        detected_agreements = analysis.get("acuerdos_alcanzados", [])
        if detected_agreements and not committee_id:
            raise HTTPException(
                status_code=400,
                detail="Asigna un comité antes de guardar los acuerdos detectados.",
            )

        supabase.table("reuniones").update({
            "estado": "en_proceso",
            "progreso": "reanalizando",
            "error_mensaje": None,
            "resumen_ejecutivo": analysis.get("resumen_ejecutivo", ""),
            "problemas_identificados": analysis.get("problemas_identificados", []),
            "puntos_clave": analysis.get("puntos_clave", []),
            "progreso": "guardando_acuerdos",
        }).eq("id", reunion_id).execute()

        agreement_rows = [
            {
                "reunion_id": reunion_id,
                "comite_id": committee_id,
                "descripcion": item.get("descripcion", ""),
                "responsable": item.get("responsable") or None,
                "fecha_limite": item.get("fecha_limite"),
                "categoria": item.get("categoria"),
                "estado": "pendiente",
                "es_nuevo": True,
            }
            for item in detected_agreements
        ]
        # Reemplaza los acuerdos generados anteriormente para esta reunión.
        supabase.table("acuerdos").delete().eq("reunion_id", reunion_id).execute()
        if agreement_rows:
            supabase.table("acuerdos").insert(agreement_rows).execute()
        saved_agreements = (
            supabase.table("acuerdos").select("*")
            .eq("reunion_id", reunion_id).execute().data or []
        )

        reunion.update({
            "resumen_ejecutivo": analysis.get("resumen_ejecutivo", ""),
            "problemas_identificados": analysis.get("problemas_identificados", []),
            "puntos_clave": analysis.get("puntos_clave", []),
        })
        documents = {
            "archivo_excel_url": (
                "resumen.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                generar_excel(reunion, saved_agreements, []),
            ),
            "archivo_word_resumen_url": (
                "resumen.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                generar_word_resumen(reunion, saved_agreements),
            ),
            "archivo_word_smartart_url": (
                "mapa_mental.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                generar_word_mapa_mental(reunion),
            ),
        }
        urls: dict[str, str] = {}
        for field, (filename, media_type, content) in documents.items():
            storage_path = f"{reunion_id}/{filename}"
            supabase.storage.from_("documentos").upload(
                storage_path,
                content,
                file_options={"content-type": media_type, "upsert": "true"},
            )
            urls[field] = supabase.storage.from_("documentos").get_public_url(storage_path)

        supabase.table("reuniones").update({
            **urls,
            "estado": "procesada",
            "error_mensaje": None,
            "progreso": "reanalizado",
        }).eq("id", reunion_id).execute()
        return {
            "success": True,
            "reunion_id": reunion_id,
            "acuerdos_generados": len(saved_agreements),
            "mensaje": "Análisis completado exitosamente",
        }
    except HTTPException:
        raise
    except Exception as exc:
        message = str(exc) or exc.__class__.__name__
        try:
            supabase.table("reuniones").update({
                "estado": "error",
                "progreso": "reanalisis_error",
                "error_mensaje": message,
            }).eq("id", reunion_id).execute()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=message) from exc


@router.post("/{reunion_id}/procesar-completo")
def procesar_completo(reunion_id: UUID) -> dict[str, Any]:
    reunion_id_str = str(reunion_id)
    supabase = get_supabase()
    temporary_path: str | None = None

    try:
        meeting_response = (
            supabase.table("reuniones")
            .select("*, comites(nombre, color)")
            .eq("id", reunion_id_str)
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        raise_database_error(exc, "obtener la reunión")

    reunion = meeting_response.data
    if reunion is None:
        raise HTTPException(status_code=404, detail="Reunión no encontrada.")
    audio_url = reunion.get("audio_url")
    if not audio_url:
        raise HTTPException(status_code=400, detail="La reunión no tiene audio asociado")

    started_at = perf_counter()
    try:
        supabase.table("reuniones").update(
            {"estado": "en_proceso", "error_mensaje": None, "progreso": "Transcribiendo con IA..."}
        ).eq("id", reunion_id_str).execute()

        print(f"🎧 [{reunion_id_str}] Descargando audio...")
        storage_path = _storage_object_path(audio_url)
        audio_content = supabase.storage.from_("audios").download(storage_path)
        if not audio_content:
            raise RuntimeError("Supabase devolvió un archivo de audio vacío.")
        suffix = PurePosixPath(storage_path).suffix or ".audio"
        with tempfile.NamedTemporaryFile(mode="wb", suffix=suffix, delete=False) as audio_file:
            audio_file.write(audio_content)
            temporary_path = audio_file.name

        print(f"📝 [{reunion_id_str}] Transcribiendo audio con Whisper...")
        transcription = WhisperService.get_instance().transcribir(temporary_path)
        transcript = transcription["texto"]
        if not transcript.strip():
            raise RuntimeError("Whisper no encontró voz transcribible en el audio.")
        supabase.table("reuniones").update(
            {"transcripcion": transcript}
        ).eq("id", reunion_id_str).execute()

        print(f"🤖 [{reunion_id_str}] Analizando transcripción con Groq...")
        supabase.table("reuniones").update(
            {"progreso": "Analizando con IA..."}
        ).eq("id", reunion_id_str).execute()
        committee = reunion.get("comites")
        if isinstance(committee, list):
            committee = committee[0] if committee else None
        committee_name = committee.get("nombre", "") if isinstance(committee, dict) else ""
        analysis = analizar_transcripcion(transcript, committee_name)
        agreements = analysis["acuerdos_alcanzados"]
        committee_id = reunion.get("comite_id")
        if agreements and not committee_id:
            raise RuntimeError("Asigna un comité a la reunión antes de guardar los acuerdos detectados.")

        previous_agreements_response = (
            supabase.table("acuerdos")
            .select("*")
            .eq("reunion_id", reunion_id_str)
            .execute()
        )
        acuerdos_anteriores = previous_agreements_response.data or []

        supabase.table("reuniones").update(
            {
                "resumen_ejecutivo": analysis["resumen_ejecutivo"],
                "problemas_identificados": analysis["problemas_identificados"],
                "puntos_clave": analysis["puntos_clave"],
            }
        ).eq("id", reunion_id_str).execute()

        acuerdos_nuevos = [
            {
                "reunion_id": reunion_id_str,
                "comite_id": committee_id,
                "descripcion": agreement["descripcion"],
                "responsable": agreement["responsable"] or None,
                "fecha_limite": agreement["fecha_limite"],
                "categoria": agreement["categoria"],
                "estado": "pendiente",
                "es_nuevo": True,
            }
            for agreement in agreements
        ]
        if acuerdos_nuevos:
            supabase.table("acuerdos").insert(acuerdos_nuevos).execute()

        reunion.update(
            {
                "resumen_ejecutivo": analysis["resumen_ejecutivo"],
                "problemas_identificados": analysis["problemas_identificados"],
                "puntos_clave": analysis["puntos_clave"],
            }
        )
        todos_los_acuerdos = acuerdos_anteriores + acuerdos_nuevos

        print(f"📄 [{reunion_id_str}] Generando Excel y documentos Word...")
        supabase.table("reuniones").update(
            {"progreso": "Generando documentos..."}
        ).eq("id", reunion_id_str).execute()
        generated_files = {
            "excel": (
                "resumen.xlsx",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                generar_excel(reunion, acuerdos_nuevos, acuerdos_anteriores),
            ),
            "word_resumen": (
                "resumen.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                generar_word_resumen(reunion, todos_los_acuerdos),
            ),
            "word_smartart": (
                "mapa_mental.docx",
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                generar_word_mapa_mental(reunion),
            ),
        }

        public_urls: dict[str, str] = {}
        for file_type, (filename, media_type, file_content) in generated_files.items():
            storage_path = f"{reunion_id_str}/{filename}"
            supabase.storage.from_("documentos").upload(
                storage_path,
                file_content,
                file_options={"content-type": media_type, "upsert": "true"},
            )
            public_urls[file_type] = supabase.storage.from_("documentos").get_public_url(storage_path)

        print(f"✅ [{reunion_id_str}] Guardando enlaces y marcando como procesada...")
        supabase.table("reuniones").update(
            {
                "archivo_excel_url": public_urls["excel"],
                "archivo_word_resumen_url": public_urls["word_resumen"],
                "archivo_word_smartart_url": public_urls["word_smartart"],
                "estado": "procesada",
                "error_mensaje": None,
                "progreso": "¡Listo!",
            }
        ).eq("id", reunion_id_str).execute()

        elapsed = perf_counter() - started_at
        print(f"🎉 [{reunion_id_str}] Pipeline completo en {elapsed:.1f} segundos.")
        return {
            "reunion_id": reunion_id_str,
            "estado": "procesada",
            "transcripcion_caracteres": len(transcript),
            "acuerdos_detectados": len(agreements),
            "problemas_detectados": len(analysis["problemas_identificados"]),
            "archivos_generados": public_urls,
            "tiempo_total_seg": round(elapsed, 2),
        }
    except Exception as exc:
        error_message = str(exc) or exc.__class__.__name__
        print(f"❌ [{reunion_id_str}] Falló el pipeline: {error_message}")
        try:
            supabase.table("reuniones").update(
                {"estado": "error", "error_mensaje": error_message, "progreso": "Error"}
            ).eq("id", reunion_id_str).execute()
        except Exception as update_exc:
            print(f"❌ [{reunion_id_str}] No se pudo guardar el estado de error: {update_exc}")
        raise HTTPException(
            status_code=500,
            detail={
                "reunion_id": reunion_id_str,
                "estado": "error",
                "error": error_message,
            },
        ) from exc
    finally:
        if temporary_path and os.path.exists(temporary_path):
            try:
                os.remove(temporary_path)
                print(f"🧹 [{reunion_id_str}] Archivo temporal eliminado.")
            except OSError as exc:
                print(f"⚠️ [{reunion_id_str}] No se pudo eliminar el temporal: {exc}")
