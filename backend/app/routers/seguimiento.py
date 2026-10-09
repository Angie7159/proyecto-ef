from datetime import date
from re import sub
from uuid import UUID

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.routers._common import raise_database_error
from app.services.documents.excel import generar_excel_seguimiento
from app.supabase_client import get_supabase

router = APIRouter(tags=["Seguimiento"])
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


class GenerarSeguimientoRequest(BaseModel):
    comite_id: UUID
    reunion_ids: list[UUID] = Field(min_length=1)


@router.get("/comites")
def listar_comites_con_reuniones_procesadas() -> list[dict]:
    supabase = get_supabase()
    try:
        committees = supabase.table("comites").select("id, nombre, color").execute().data or []
        meetings = supabase.table("reuniones").select("comite_id").neq("estado", "error").execute().data or []
        counts: dict[str, int] = {}
        for meeting in meetings:
            committee_id = meeting.get("comite_id")
            if committee_id:
                counts[committee_id] = counts.get(committee_id, 0) + 1
        return [{**committee, "reuniones_count": counts.get(str(committee["id"]), 0)}
                for committee in committees if counts.get(str(committee["id"]), 0)]
    except Exception as exc:
        raise_database_error(exc, "listar comités con reuniones procesadas")


@router.get("/reuniones/{comite_id}")
def listar_reuniones_procesadas(comite_id: UUID) -> list[dict]:
    try:
        return get_supabase().table("reuniones").select(
            "id, titulo_final, fecha, hora_inicio, hora_fin, estado, participantes_count"
        ).eq("comite_id", str(comite_id)).neq("estado", "error").order(
            "fecha", desc=True
        ).execute().data or []
    except Exception as exc:
        raise_database_error(exc, "listar reuniones procesadas del comité")


@router.post("/generar-excel")
def generar_excel_de_seguimiento(payload: GenerarSeguimientoRequest) -> Response:
    supabase = get_supabase()
    committee_id = str(payload.comite_id)
    meeting_ids = list(dict.fromkeys(str(item) for item in payload.reunion_ids))
    try:
        committee_response = supabase.table("comites").select("id, nombre").eq("id", committee_id).maybe_single().execute()
        committee = committee_response.data
        if not committee:
            raise HTTPException(status_code=404, detail="Comité no encontrado")
        meetings = supabase.table("reuniones").select("*").eq(
            "comite_id", committee_id
        ).neq("estado", "error").in_("id", meeting_ids).order("fecha", desc=True).execute().data or []
        if not meetings:
            raise HTTPException(status_code=404, detail="No se encontraron reuniones procesadas seleccionadas")
        if len(meetings) != len(meeting_ids):
            raise HTTPException(status_code=400, detail="La selección contiene reuniones no procesadas o de otro comité")
        for meeting in meetings:
            meeting["acuerdos"] = supabase.table("acuerdos").select("*").eq(
                "reunion_id", str(meeting["id"])
            ).order("fecha_limite", desc=False).execute().data or []
        content = generar_excel_seguimiento(committee.get("nombre") or "Comité", meetings)
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "generar el Excel de seguimiento")

    safe_name = sub(r"[^A-Za-z0-9_-]+", "_", committee.get("nombre") or "comite").strip("_") or "comite"
    filename = f"seguimiento_{safe_name}_{date.today().isoformat()}.xlsx"
    return Response(content=content, media_type=XLSX_TYPE, headers={
        "Content-Disposition": f'attachment; filename="{filename}"'
    })
