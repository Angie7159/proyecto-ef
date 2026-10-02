import truststore

truststore.inject_into_ssl()

from functools import lru_cache

from supabase import Client, create_client

from app.config import get_settings


@lru_cache(maxsize=1)
def get_supabase() -> Client:
    """Devuelve el cliente singleton y verifica acceso a Supabase una vez."""
    settings = get_settings()
    client = create_client(
        settings.supabase_url,
        settings.supabase_secret_key.get_secret_value(),
    )

    try:
        client.table("comites").select("id").limit(1).execute()
    except Exception as exc:
        raise RuntimeError(
            "No se pudo verificar la conexión con Supabase. "
            "Comprueba SUPABASE_URL, SUPABASE_SECRET_KEY y el acceso a la tabla comites."
        ) from exc

    return client
