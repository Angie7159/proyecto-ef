from functools import lru_cache
from typing import Any

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        enable_decoding=False,
    )

    supabase_url: str
    supabase_secret_key: SecretStr
    groq_api_key: SecretStr
    environment: str = "development"
    whisper_model: str = "small"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    @field_validator("supabase_url", "supabase_secret_key", "groq_api_key", mode="before")
    @classmethod
    def validate_critical_values(cls, value: Any, info: Any) -> Any:
        variable_name = info.field_name.upper()
        if value is None or not str(value).strip():
            raise ValueError(f"Falta la variable requerida {variable_name} en backend/.env")

        normalized = str(value).strip()
        if normalized.startswith("TU_"):
            raise ValueError(
                f"{variable_name} todavía contiene un placeholder. "
                f"Completa su valor real en backend/.env antes de iniciar la API."
            )
        return normalized

    @field_validator("cors_origins", mode="before")
    @classmethod
    def parse_cors_origins(cls, value: Any) -> list[str]:
        if isinstance(value, str):
            return [origin.strip() for origin in value.split(",") if origin.strip()]
        if isinstance(value, list):
            return [str(origin).strip() for origin in value if str(origin).strip()]
        raise ValueError("CORS_ORIGINS debe ser una lista separada por comas")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
