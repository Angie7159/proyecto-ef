from fastapi import APIRouter, HTTPException, status

from app.schemas.comite import ComiteCreate, ComiteResponse
from app.supabase_client import get_supabase
from app.routers._common import raise_database_error

router = APIRouter(prefix="/comites", tags=["Comités"])


@router.get("/", response_model=list[ComiteResponse])
def listar_comites() -> list[dict]:
    try:
        response = (
            get_supabase()
            .table("comites")
            .select("*")
            .eq("activo", True)
            .order("nombre")
            .execute()
        )
        return response.data or []
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "listar los comités")


@router.get("/{comite_id}", response_model=ComiteResponse)
def obtener_comite(comite_id: str) -> dict:
    try:
        response = (
            get_supabase()
            .table("comites")
            .select("*")
            .eq("id", comite_id)
            .maybe_single()
            .execute()
        )
        if response.data is None:
            raise HTTPException(status_code=404, detail="Comité no encontrado.")
        return response.data
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "obtener el comité")


@router.post("/", response_model=ComiteResponse, status_code=status.HTTP_201_CREATED)
def crear_comite(comite: ComiteCreate) -> dict:
    try:
        response = (
            get_supabase()
            .table("comites")
            .insert(comite.model_dump(mode="json"))
            .select("*")
            .single()
            .execute()
        )
        return response.data
    except Exception as exc:
        raise_database_error(exc, "crear el comité")
