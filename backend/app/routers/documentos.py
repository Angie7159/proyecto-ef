from uuid import UUID

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response

from app.routers._common import raise_database_error
from app.services.documents.excel import generar_excel
from app.services.documents.word import generar_word_mapa_mental, generar_word_resumen
from app.supabase_client import get_supabase

router = APIRouter(prefix="/documentos", tags=["Documentos"])

DOCUMENT_TYPES = {
    "excel": ("resumen.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    "word_resumen": ("resumen.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    "word_smartart": ("mapa_mental.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
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
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")

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
        raise_database_error(exc, "obtener la reunión y sus acuerdos")

    acuerdos_nuevos = [item for item in acuerdos if item.get("es_nuevo")]
    acuerdos_anteriores = [item for item in acuerdos if not item.get("es_nuevo")]
    try:
        files = {
            "excel": generar_excel(reunion, acuerdos_nuevos, acuerdos_anteriores),
            "word_resumen": generar_word_resumen(reunion, acuerdos),
            "word_smartart": generar_word_mapa_mental(reunion),
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
                "archivo_excel_url": urls["excel"],
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
        "archivo_excel_url": urls["excel"],
        "archivo_word_resumen_url": urls["word_resumen"],
        "archivo_word_smartart_url": urls["word_smartart"],
    }


@router.get("/descargar/{reunion_id}/{tipo}")
def descargar_documento(reunion_id: UUID, tipo: str) -> Response:
    if tipo not in DOCUMENT_TYPES:
        raise HTTPException(
            status_code=400,
            detail="Tipo inválido. Usa excel, word_resumen o word_smartart.",
        )
    filename, media_type = DOCUMENT_TYPES[tipo]
    try:
        file_content = get_supabase().storage.from_("documentos").download(f"{reunion_id}/{filename}")
    except Exception as exc:
        print(f"Error descargando {tipo} de la reunión {reunion_id}: {exc}")
        raise HTTPException(status_code=404, detail="El documento no existe o no se pudo descargar.") from exc

    return Response(
        content=file_content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
