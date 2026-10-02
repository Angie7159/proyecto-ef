from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

FrecuenciaComite = Literal["semanal", "quincenal", "mensual", "ad-hoc"]


class ComiteBase(BaseModel):
    nombre: str = Field(min_length=1, max_length=200)
    descripcion: str | None = None
    frecuencia: FrecuenciaComite | None = None
    color: str = "#4F46E5"
    participantes_habituales: list[str] = Field(default_factory=list)


class ComiteCreate(ComiteBase):
    pass


class ComiteResponse(ComiteBase):
    model_config = ConfigDict(from_attributes=True)

    id: str
    activo: bool
    created_at: datetime
    updated_at: datetime
