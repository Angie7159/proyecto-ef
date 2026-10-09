import truststore

truststore.inject_into_ssl()

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.routers import acuerdos, analisis, comites, documentos, reuniones, seguimiento, transcripcion
from app.supabase_client import get_supabase

settings = get_settings()


@asynccontextmanager
async def lifespan(_: FastAPI):
    get_supabase()
    yield


app = FastAPI(
    title="MeetIA API",
    version="0.1.0",
    description="API para gestionar reuniones de comités universitarios.",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(comites.router, prefix="/api")
app.include_router(reuniones.router, prefix="/api")
app.include_router(acuerdos.router, prefix="/api")
app.include_router(transcripcion.router, prefix="/api")
app.include_router(analisis.router, prefix="/api")
app.include_router(documentos.router, prefix="/api")
app.include_router(seguimiento.router, prefix="/api/seguimiento")


@app.get("/")
def read_root() -> dict[str, str]:
    return {"message": "MeetIA API", "version": "0.1.0"}


@app.get("/health")
def health_check() -> dict[str, str]:
    return {"status": "ok", "environment": settings.environment}
