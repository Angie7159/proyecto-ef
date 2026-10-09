from uuid import UUID
import traceback

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.routers._common import raise_database_error
from app.services.documents.word import generar_word_mapa_conceptual, generar_word_resumen
from app.supabase_client import get_supabase

router = APIRouter(prefix="/documentos", tags=["Documentos"])

DOCUMENT_TYPES = {
    "word_resumen": ("resumen.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "word_smartart": ("mapa_conceptual.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "word_mapa_conceptual": ("mapa_conceptual.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
}


@router.post("/generar/{reunion_id}")
def generar_documentos(reunion_id: UUID) -> dict[str, str]:
    supabase = get_supabase()
    try:
        meeting_response = (
            supabase.table("reuniones")
            .select("*, comites(nombre, color)")
            .eq("id", str(reunion_id))
            .maybe_single()
            .execute()
        )
        reunion = meeting_response.data
        if reunion is None:
            raise HTTPException(status_code=404, detail="ReuniÃ³n no encontrada.")

        agreements_response = (
            supabase.table("acuerdos")
            .select("*")
            .eq("reunion_id", str(reunion_id))
            .order("fecha_limite", desc=False)
            .execute()
        )
        acuerdos = agreements_response.data or []
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "obtener la reuniÃ³n y sus acuerdos")

    try:
        files = {
            "word_resumen": generar_word_resumen(reunion, acuerdos),
            "word_smartart": generar_word_mapa_conceptual(reunion, acuerdos),
        }
        urls: dict[str, str] = {}
        for file_type, content in files.items():
            filename = DOCUMENT_TYPES[file_type][0]
            storage_path = f"{reunion_id}/{filename}"
            media_type = DOCUMENT_TYPES[file_type][1]
            supabase.storage.from_("documentos").upload(
                storage_path,
                content,
                file_options={"content-type": media_type, "upsert": "true"},
            )
            urls[file_type] = supabase.storage.from_("documentos").get_public_url(storage_path)

        supabase.table("reuniones").update(
            {
                "archivo_word_resumen_url": urls["word_resumen"],
                "archivo_word_smartart_url": urls["word_smartart"],
            }
        ).eq("id", str(reunion_id)).execute()
    except HTTPException:
        raise
    except Exception as exc:
        print(f"Error generando documentos para {reunion_id}: {exc}")
        raise HTTPException(status_code=500, detail="No se pudieron generar o guardar los documentos.") from exc

    return {
        "reunion_id": str(reunion_id),
        "archivo_word_resumen_url": urls["word_resumen"],
        "archivo_word_smartart_url": urls["word_smartart"],
    }


@router.post("/generar/{reunion_id}/{tipo}")
def generar_documento(reunion_id: UUID, tipo: str) -> dict[str, str]:
    if tipo not in {"word_resumen", "word_mapa_conceptual"}:
        raise HTTPException(
            status_code=400,
            detail="Tipo invÃƒÂ¡lido. Usa word_resumen o word_mapa_conceptual.",
        )
    supabase = get_supabase()
    try:
        response = (
            supabase.table("reuniones")
            .select("*, comites(nombre, color)")
            .eq("id", str(reunion_id))
            .maybe_single()
            .execute()
        )
        reunion = response.data
        if reunion is None:
            raise HTTPException(status_code=404, detail="ReuniÃƒÂ³n no encontrada.")
        acuerdos = (
            supabase.table("acuerdos")
            .select("*")
            .eq("reunion_id", str(reunion_id))
            .order("fecha_limite", desc=False)
            .execute()
            .data or []
        )
        if tipo == "word_resumen":
            content = generar_word_resumen(reunion, acuerdos)
            field = "archivo_word_resumen_url"
        else:
            content = generar_word_mapa_conceptual(reunion, acuerdos)
            field = "archivo_word_smartart_url"
        filename, media_type = DOCUMENT_TYPES[tipo]
        storage_path = f"{reunion_id}/{filename}"
        supabase.storage.from_("documentos").upload(
            storage_path,
            content,
            file_options={"content-type": media_type, "upsert": "true"},
        )
        url = supabase.storage.from_("documentos").get_public_url(storage_path)
        supabase.table("reuniones").update({field: url}).eq("id", str(reunion_id)).execute()
        return {"reunion_id": str(reunion_id), "tipo": tipo, "url": url, field: url}
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "generar y guardar el documento")


@router.post("/regenerar-word/{reunion_id}")
def regenerar_word_resumen(reunion_id: UUID) -> dict[str, str]:
    reunion_id_str = str(reunion_id)
    try:
        supabase = get_supabase()
        response = (
            supabase.table("reuniones")
            .select("*")
            .eq("id", reunion_id_str)
            .maybe_single()
            .execute()
        )
        reunion = response.data
        if reunion is None:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")

        content = generar_word_resumen(reunion, [])
        path = f"{reunion_id_str}/resumen.docx"
        bucket = supabase.storage.from_("documentos")
        bucket.upload(
            path,
            content,
            file_options={
                "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "upsert": "true",
            },
        )
        url = bucket.get_public_url(path)
        supabase.table("reuniones").update(
            {"archivo_word_resumen_url": url}
        ).eq("id", reunion_id_str).execute()
        return {"reunion_id": reunion_id_str, "url": url, "archivo_word_resumen_url": url}
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "regenerar el resumen Word")


@router.post("/regenerar-mapa/{reunion_id}")
def regenerar_mapa_conceptual(reunion_id: UUID) -> dict[str, str]:
    reunion_id_str = str(reunion_id)
    try:
        supabase = get_supabase()
        print(f"ðŸ” [1/5] Obteniendo reuniÃ³n {reunion_id}...", flush=True)
        meeting_response = (
            supabase.table("reuniones")
            .select("*, comites(nombre, color)")
            .eq("id", reunion_id_str)
            .maybe_single()
            .execute()
        )
        reunion = meeting_response.data
        if reunion is None:
            raise HTTPException(status_code=404, detail="ReuniÃ³n no encontrada.")
        print("ðŸ” [2/5] Obteniendo acuerdos...", flush=True)
        acuerdos = (
            supabase.table("acuerdos")
            .select("*")
            .eq("reunion_id", reunion_id_str)
            .order("fecha_limite", desc=False)
            .execute()
            .data or []
        )
        print("ðŸ” [3/5] Generando documento Word...", flush=True)
        contenido = generar_word_mapa_conceptual(reunion, acuerdos)
        storage_path = f"{reunion_id_str}/mapa_conceptual.docx"
        bucket = supabase.storage.from_("documentos")
        print("ðŸ” [4/5] Subiendo a Supabase Storage...", flush=True)
        bucket.upload(
            storage_path,
            contenido,
            file_options={
                "content-type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "upsert": "true",
            },
        )
        url = bucket.get_public_url(storage_path)
        print("ðŸ” [5/5] Actualizando URL en BD...", flush=True)
        supabase.table("reuniones").update({"archivo_word_smartart_url": url}).eq("id", reunion_id_str).execute()
        return {
            "reunion_id": reunion_id_str,
            "url": url,
            "archivo_word_smartart_url": url,
        }
    except HTTPException:
        raise
    except Exception as exc:
        print("=" * 70, flush=True)
        print(f"âŒ ERROR en /regenerar-mapa para {reunion_id}", flush=True)
        print(f"   Tipo: {type(exc).__name__}", flush=True)
        print(f"   Mensaje: {exc}", flush=True)
        traceback.print_exc()
        print("=" * 70, flush=True)
        raise HTTPException(
            status_code=500,
            detail=f"Error: {type(exc).__name__}: {str(exc)}",
        ) from exc


@router.get("/descargar/{reunion_id}/{tipo}")
def descargar_documento(reunion_id: UUID, tipo: str) -> Response:
    if tipo not in DOCUMENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Tipo invÃ¡lido. Usa word_resumen o word_smartart.",
        )
    filename, media_type = DOCUMENT_TYPES[tipo]
    try:
        file_content = get_supabase().storage.from_("documentos").download(f"{reunion_id}/{filename}")
    except Exception as exc:
        print(f"Error descargando {tipo} de la reuniÃ³n {reunion_id}: {exc}")
        raise HTTPException(status_code=404, detail="El documento no existe o no se pudo descargar.") from exc

    return Response(
        content=file_content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


