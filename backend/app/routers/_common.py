from typing import NoReturn

from fastapi import HTTPException


def raise_database_error(error: Exception, action: str) -> NoReturn:
    code = getattr(error, "code", None)
    if code in {"22P02", "23502", "23503", "23505", "23514"}:
        raise HTTPException(status_code=400, detail=f"No se pudo {action}: verifica los datos enviados.") from error
    raise HTTPException(status_code=500, detail=f"No se pudo {action} por un error de base de datos.") from error
