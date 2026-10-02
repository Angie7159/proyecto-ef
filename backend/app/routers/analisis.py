import time
from typing import Any
from uuid import UUID

from fastapi import APIRouter, HTTPException

from app.routers._common import raise_database_error
from app.services.analyze import analizar_transcripcion
from app.supabase_client import get_supabase

router = APIRouter(prefix="/analisis", tags=["Análisis IA"])


@router.post("/procesar/{reunion_id}")
def procesar_analisis(reunion_id: UUID) -> dict[str, Any]:
    supabase = get_supabase()
    try:
        meeting_response = (
            supabase.table("reuniones")
            .select("id, transcripcion, comite_id, comites(nombre)")
            .eq("id", str(reunion_id))
            .maybe_single()
            .execute()
        )
    except Exception as exc:
        raise_database_error(exc, "obtener la reunión")

    meeting = meeting_response.data
    if meeting is None:
        raise HTTPException(status_code=404, detail="Reunión no encontrada.")

    transcript = meeting.get("transcripcion")
    if not isinstance(transcript, str) or not transcript.strip():
        raise HTTPException(status_code=400, detail="La reunión no tiene una transcripción para analizar.")

    committee = meeting.get("comites")
    if isinstance(committee, list):
        committee = committee[0] if committee else None
    committee_name = committee.get("nombre", "") if isinstance(committee, dict) else ""

    started_at = time.time()
    try:
        analysis = analizar_transcripcion(transcript, committee_name)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        print(f"Error analizando la reunión {reunion_id}: {exc}")
        raise HTTPException(status_code=500, detail="No se pudo analizar la transcripción.") from exc
    elapsed = time.time() - started_at

    agreements = analysis["acuerdos_alcanzados"]
    committee_id = meeting.get("comite_id")
    if agreements and not committee_id:
        raise HTTPException(
            status_code=400,
            detail="Asigna un comité a la reunión antes de guardar los acuerdos detectados.",
        )

    try:
        update_response = (
            supabase.table("reuniones")
            .update(
                {
                    "resumen_ejecutivo": analysis["resumen_ejecutivo"],
                    "problemas_identificados": analysis["problemas_identificados"],
                    "puntos_clave": analysis["puntos_clave"],
                    "estado": "pendiente_asignacion",
                }
            )
            .eq("id", str(reunion_id))
            .select("id")
            .execute()
        )
        if not update_response.data:
            raise HTTPException(status_code=404, detail="Reunión no encontrada.")

        if agreements:
            agreement_rows = [
                {
                    "reunion_id": str(reunion_id),
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
            supabase.table("acuerdos").insert(agreement_rows).execute()
    except HTTPException:
        raise
    except Exception as exc:
        raise_database_error(exc, "guardar el análisis y los acuerdos")

    print(f"Análisis de la reunión {reunion_id} completado en {elapsed:.2f} segundos.")
    return {
        "reunion_id": str(reunion_id),
        "resumen_ejecutivo": analysis["resumen_ejecutivo"],
        "problemas_count": len(analysis["problemas_identificados"]),
        "acuerdos_count": len(agreements),
        "puntos_clave_count": len(analysis["puntos_clave"]),
        "tiempo_analisis_seg": round(elapsed, 2),
    }
