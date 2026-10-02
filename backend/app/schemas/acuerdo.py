from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

EstadoAcuerdo = Literal["pendiente", "en_proceso", "cumplido", "vencido"]
CategoriaAcuerdo = Literal["Académico", "Gestión", "Estudiantes", "Infraestructura", "Otro"]


class AcuerdoBase(BaseModel):
    descripcion: str = Field(min_length=1)
    responsable: str | None = None
    fecha_limite: date | None = None
    estado: EstadoAcuerdo = "pendiente"
    categoria: CategoriaAcuerdo | None = None
    es_nuevo: bool = False
    observaciones: str | None = None


class AcuerdoCreate(AcuerdoBase):
    reunion_id: str
    comite_id: str


class AcuerdoResponse(AcuerdoBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    reunion_id: str
    comite_id: str
    reunion_origen_id: str | None = None
    created_at: datetime
    updated_at: datetime


class AcuerdoUpdateEstado(BaseModel):
    estado: EstadoAcuerdo
