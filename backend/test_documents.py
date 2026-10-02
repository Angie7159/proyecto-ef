import truststore

truststore.inject_into_ssl()

from pathlib import Path

from app.services.documents.excel import generar_excel
from app.services.documents.word import generar_word_mapa_mental, generar_word_resumen
from app.supabase_client import get_supabase


def main() -> int:
    supabase = get_supabase()
    response = (
        supabase.table("reuniones")
        .select("*, comites(nombre, color)")
        .eq("estado", "procesada")
        .order("fecha", desc=True)
        .limit(1)
        .execute()
    )
    meetings = response.data or []
    if not meetings:
        print("No se encontraron reuniones procesadas en Supabase.")
        return 1

    reunion = meetings[0]
    agreements_response = (
        supabase.table("acuerdos")
        .select("*")
        .eq("reunion_id", reunion["id"])
        .order("fecha_limite", desc=False)
        .execute()
    )
    acuerdos = agreements_response.data or []
    acuerdos_nuevos = [item for item in acuerdos if item.get("es_nuevo")]
    acuerdos_anteriores = [item for item in acuerdos if not item.get("es_nuevo")]

    output_dir = Path("test_output")
    output_dir.mkdir(parents=True, exist_ok=True)
    files = {
        "resumen.xlsx": generar_excel(reunion, acuerdos_nuevos, acuerdos_anteriores),
        "resumen.docx": generar_word_resumen(reunion, acuerdos),
        "mapa_mental.docx": generar_word_mapa_mental(reunion),
    }
    for filename, content in files.items():
        output_path = output_dir / filename
        output_path.write_bytes(content)
        print(f"Documento generado: {output_path.resolve()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
