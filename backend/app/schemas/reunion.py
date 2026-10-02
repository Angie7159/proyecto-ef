from datetime import date, datetime, time
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

EstadoReunion = Literal[
    "pendiente_asignacion",
    "en_proceso",
    "procesada",
    "error",
]
FuenteReunion = Literal["teams_auto", "teams_manual", "zoom", "presencial", "upload"]


class ReunionBase(BaseModel):
    titulo_final: str = Field(min_length=1, max_length=300)
    fecha: date
    hora_inicio: time | None = None
    hora_fin: time | None = None
    duracion_min: int | None = Field(default=None, ge=0)
    participantes_count: int = Field(default=0, ge=0)
    participantes_lista: list[Any] = Field(default_factory=list)
    fuente: FuenteReunion
    comite_id: str | None = None


class ReunionCreate(ReunionBase):
    pass


class ComiteResumen(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    nombre: str
    color: str


class ReunionResponse(ReunionBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    titulo_original: str | None = None
    estado: EstadoReunion
    transcripcion: str | None = None
    resumen_ejecutivo: str | None = None
    problemas_identificados: list[Any] = Field(default_factory=list)
    puntos_clave: list[str] = Field(default_factory=list)
    archivo_excel_url: str | None = None
    archivo_word_resumen_url: str | None = None
    archivo_word_smartart_url: str | None = None
    audio_url: str | None = None
    created_at: datetime
    updated_at: datetime
    comites: ComiteResumen | None = None


class ReunionListItem(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    titulo: str
    fecha: date
    hora_inicio: time | None = None
    hora_fin: time | None = None
    duracion_min: int | None = None
    participantes: int
    fuente: FuenteReunion
    estado: EstadoReunion
    comite_id: str | None = None
    comite_nombre: str | None = None
    comite_color: str | None = None
    resumen_corto: str | None = None
    acuerdos_pendientes: int = 0
    acuerdos_nuevos: int = 0
    created_at: datetime


class AsignarComiteRequest(BaseModel):
    comite_id: str = Field(min_length=1)
