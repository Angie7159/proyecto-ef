from fastapi import APIRouter, HTTPException

from app.routers._common import raise_database_error
from app.schemas.acuerdo import (
    AcuerdoCreate,
    AcuerdoResponse,
    AcuerdoUpdateEstado,
)
from app.supabase_client import get_supabase

router = APIRouter(prefix="/acuerdos", tags=["Acuerdos"])


@router.get("/reunion/{reunion_id}", response_model=list[AcuerdoResponse])
def listar_acuerdos_de_reunion(reunion_id: str) -> list[dict]:
    try:
        response = (
            get_supabase()
            .table("acuerdos")
            .select("*")
            .eq("reunion_id", reunion_id)
            .order("fecha_limite", desc=False)
            .execute()
        )
        return response.data or []
    except Exception as exc:
        raise_database_error(exc, "listar los acuerdos de la reunión")


@router.get("/comite/{comite_id}", response_model=list[AcuerdoResponse])
def listar_acuerdos_de_comite(comite_id: str, solo_pendientes: bool = False) -> list[dict]:
    try:
        query = get_supabase().table("acuerdos").select("*").eq("comite_id", comite_id)
        if solo_pendientes:
            query = query.eq("estado", "pendiente")
        response = query.order("fecha_limite", desc=False).execute()
        return response.data or []
    except Exception as exc:
        raise_database_error(exc, "listar los acuerdos del comité")


@router.patch("/{acuerdo_id}/estado", response_model=AcuerdoResponse)
def actualizar_estado_acuerdo(acuerdo_id: str, payload: AcuerdoUpdateEstado) -> dict:
    try:
        response = (
            get_supabase()
            .table("acuerdos")
            .update({"estado": payload.estado})
            .eq("id", acuerdo_id)
            .select("*")
            .maybe_single()
            .execute()
        )
        if response.data is None:
            raise HTTPException(status_code=404, detail="Acuerdo no encontrado.")
        return response.data
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "actualizar el estado del acuerdo")


@router.post("/", response_model=AcuerdoResponse, status_code=201)
def crear_acuerdo(acuerdo: AcuerdoCreate) -> dict:
    try:
        response = (
            get_supabase()
            .table("acuerdos")
            .insert(acuerdo.model_dump(mode="json"))
            .select("*")
            .single()
            .execute()
        )
        return response.data
    except Exception as exc:
        raise_database_error(exc, "crear el acuerdo")
