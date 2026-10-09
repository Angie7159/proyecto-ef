import truststore

truststore.inject_into_ssl()

import httpx
import json
import re
import time
from datetime import date
from typing import Any

from app.config import get_settings

GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODEL = "openai/gpt-oss-120b"
MAX_CHUNK_CHARS = 40_000
CHUNK_OVERLAP_CHARS = 2_000
CHUNK_THRESHOLD_CHARS = 50_000
ALLOWED_CATEGORIES = {"Académico", "Gestión", "Estudiantes", "Infraestructura", "Otro"}

SYSTEM_PROMPT = """Eres un asistente experto en análisis de reuniones de comités universitarios y empresariales.

Analiza la transcripción y devuelve SOLO un objeto JSON válido con esta estructura exacta:
{
  "resumen_ejecutivo": "Párrafo de 3-5 oraciones que resume la reunión de forma ejecutiva: contexto, participantes principales, tema central y propósito",
  "problema": "Descripción del problema o necesidad que motivó la reunión en 2-4 oraciones. Si no se identifica, escribe: No se identificó un problema específico en la reunión.",
  "solucion": "Descripción de la solución, propuesta o enfoque planteado en 3-5 oraciones. Si no se propuso, escribe: No se presentó una solución específica en la reunión.",
  "mercado": "Contexto de mercado, audiencia o competencia mencionado en 2-4 oraciones. Si no aplica, escribe: No se discutió contexto de mercado en esta reunión.",
  "finanzas": "Aspectos económicos, presupuestos o costos mencionados en 2-4 oraciones. Si no se hablaron cifras, escribe: No se presentaron cifras económicas en esta reunión.",
  "conclusion": "Conclusión de la reunión, decisiones tomadas y valoraciones en 3-5 oraciones",
  "proximos_pasos": ["Acción concreta con responsable si aplica"],
  "problemas_identificados": [{"titulo": "Título corto", "descripcion": "Descripción", "categoria": "Académico|Gestión|Estudiantes|Infraestructura|Otro"}],
  "acuerdos_alcanzados": [{"descripcion": "Qué se acordó", "responsable": "Nombre o cadena vacía", "fecha_limite": "YYYY-MM-DD o null", "categoria": "Académico|Gestión|Estudiantes|Infraestructura|Otro"}],
  "puntos_clave": ["Punto principal"],
  "participantes_mencionados": ["Nombre"]
}

Reglas: no inventes información; usa los textos indicados cuando una sección no aplique; próximos pasos debe contener acciones concretas; escribe de forma profesional y concisa; no incluyas texto fuera del JSON. Si no hay acuerdos o pasos concretos, devuelve listas vacías."""

EXPECTED_KEYS = {
    "resumen_ejecutivo",
    "problema",
    "solucion",
    "mercado",
    "finanzas",
    "conclusion",
    "proximos_pasos",
    "problemas_identificados",
    "acuerdos_alcanzados",
    "puntos_clave",
    "participantes_mencionados",
}


def _split_transcript(text: str) -> list[str]:
    if len(text) <= CHUNK_THRESHOLD_CHARS:
        return [text]

    step = MAX_CHUNK_CHARS - CHUNK_OVERLAP_CHARS
    return [text[start : start + MAX_CHUNK_CHARS] for start in range(0, len(text), step)]


def _validate_analysis(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or not EXPECTED_KEYS.issubset(payload):
        raise ValueError("El JSON no contiene todos los campos requeridos.")

    summary = payload["resumen_ejecutivo"]
    if not isinstance(summary, str):
        raise ValueError("resumen_ejecutivo debe ser texto.")

    section_fields = ("problema", "solucion", "mercado", "finanzas", "conclusion")
    if any(not isinstance(payload[field], str) for field in section_fields):
        raise ValueError("Las nuevas secciones del análisis deben ser texto.")

    list_fields = ("proximos_pasos", "problemas_identificados", "acuerdos_alcanzados", "puntos_clave", "participantes_mencionados")
    if any(not isinstance(payload[field], list) for field in list_fields):
        raise ValueError("Los próximos pasos, problemas, acuerdos, puntos clave y participantes deben ser listas.")

    problems: list[dict[str, str]] = []
    for problem in payload["problemas_identificados"]:
        if not isinstance(problem, dict) or not all(
            isinstance(problem.get(field), str) for field in ("titulo", "descripcion", "categoria")
        ):
            raise ValueError("Cada problema debe incluir titulo, descripcion y categoria como texto.")
        if problem["categoria"] not in ALLOWED_CATEGORIES:
            raise ValueError("El problema contiene una categorÃ­a no vÃ¡lida.")
        problems.append({field: problem[field] for field in ("titulo", "descripcion", "categoria")})

    agreements: list[dict[str, str | None]] = []
    for agreement in payload["acuerdos_alcanzados"]:
        if not isinstance(agreement, dict) or not all(
            isinstance(agreement.get(field), str)
            for field in ("descripcion", "responsable", "categoria")
        ):
            raise ValueError("Cada acuerdo debe incluir descripcion, responsable y categoria como texto.")
        due_date = agreement.get("fecha_limite")
        if due_date is not None:
            if not isinstance(due_date, str):
                raise ValueError("fecha_limite debe ser una fecha YYYY-MM-DD o null.")
            try:
                date.fromisoformat(due_date)
            except ValueError as exc:
                raise ValueError("fecha_limite debe tener el formato YYYY-MM-DD.") from exc
        if agreement["categoria"] not in ALLOWED_CATEGORIES:
            raise ValueError("El acuerdo contiene una categorÃ­a no vÃ¡lida.")
        agreements.append(
            {
                "descripcion": agreement["descripcion"],
                "responsable": agreement["responsable"],
                "fecha_limite": due_date,
                "categoria": agreement["categoria"],
            }
        )

    if not all(isinstance(value, str) for value in payload["puntos_clave"]):
        raise ValueError("Cada punto clave debe ser texto.")
    if not all(isinstance(value, str) for value in payload["proximos_pasos"]):
        raise ValueError("Cada próximo paso debe ser texto.")
    if not all(isinstance(value, str) for value in payload["participantes_mencionados"]):
        raise ValueError("Cada participante mencionado debe ser texto.")

    return {
        "resumen_ejecutivo": summary,
        **{field: payload[field] for field in section_fields},
        "proximos_pasos": payload["proximos_pasos"],
        "problemas_identificados": problems,
        "acuerdos_alcanzados": agreements,
        "puntos_clave": payload["puntos_clave"],
        "participantes_mencionados": payload["participantes_mencionados"],
    }


def _extract_json(content: str) -> Any:
    first_brace = content.find("{")
    last_brace = content.rfind("}")
    if first_brace < 0 or last_brace < first_brace:
        raise ValueError("La respuesta no contiene un objeto JSON.")
    return json.loads(content[first_brace : last_brace + 1])


def _analyze_chunk(
    text: str,
    nombre_comite: str,
    model: str,
    headers: dict[str, str],
) -> dict[str, Any]:
    user_prompt = (
        f"ComitÃ©: {nombre_comite or 'No especificado'}\n\n"
        f"TranscripciÃ³n:\n{text}"
    )
    messages: list[dict[str, str]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_prompt},
    ]

    correction_attempts = 0
    rate_limit_retried = False
    json_error_retried = False
    while correction_attempts < 2:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.3,
            "max_tokens": 4096,
        }
        try:
            response = httpx.post(
                GROQ_ENDPOINT,
                headers=headers,
                json=payload,
                timeout=60.0,
            )
        except httpx.HTTPError as exc:
            raise RuntimeError(f"No se pudo conectar con Groq: {exc}") from exc

        if response.status_code == 429 and not rate_limit_retried:
            rate_limit_retried = True
            print("LÃ­mite de Groq alcanzado (429); reintentando en 5 segundos...")
            time.sleep(5)
            continue

        if response.status_code != 200:
            try:
                error_body = response.json()
            except ValueError:
                error_body = {}
            error_info = error_body.get("error", {}) if isinstance(error_body, dict) else {}
            error_code = str(error_info.get("code", "")).lower() if isinstance(error_info, dict) else ""

            if response.status_code == 404 and error_code == "model_not_found":
                raise RuntimeError(
                    f"El modelo {model} no estÃ¡ disponible. Modelos recomendados: "
                    "openai/gpt-oss-120b, qwen/qwen3.6-27b"
                )
            if (
                response.status_code == 400
                and error_code == "json_validate_failed"
                and not json_error_retried
            ):
                json_error_retried = True
                print("Groq rechazÃ³ la validaciÃ³n JSON; reintentando sin response_format...")
                # Las solicitudes se envÃ­an sin response_format desde el primer intento.
                continue
            raise RuntimeError(
                f"Groq respondiÃ³ HTTP {response.status_code}: {response.text[:1000]}"
            )

        try:
            content = response.json()["choices"][0]["message"]["content"] or ""
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            raise RuntimeError("Groq devolviÃ³ una respuesta sin contenido reconocible.") from exc

        try:
            return _validate_analysis(_extract_json(content))
        except (json.JSONDecodeError, ValueError) as exc:
            correction_attempts += 1
            if correction_attempts >= 2:
                raise RuntimeError(
                    "Groq devolviÃ³ JSON invÃ¡lido despuÃ©s de dos intentos de anÃ¡lisis."
                ) from exc

            print("La respuesta JSON no es vÃ¡lida; solicitando una correcciÃ³n al modelo...")
            messages.extend(
                [
                    {"role": "assistant", "content": content},
                    {
                        "role": "user",
                        "content": (
                            "Corrige tu respuesta anterior. Devuelve Ãºnicamente un JSON vÃ¡lido "
                            "con todos los campos y tipos requeridos por el esquema del sistema. "
                            "No agregues texto fuera del JSON."
                        ),
                    },
                ]
            )

    raise RuntimeError("No se pudo analizar la transcripciÃ³n con Groq.")


def _combine_summaries(summaries: list[str]) -> str:
    if len(summaries) == 1:
        return summaries[0]

    sentences_by_summary = [
        [sentence.strip() for sentence in re.split(r"(?<=[.!?])\s+", summary.strip()) if sentence.strip()]
        for summary in summaries
    ]
    selected: list[str] = []

    # Conserva las primeras ideas del primer resumen y aÃ±ade contexto de los demÃ¡s chunks.
    for sentence in sentences_by_summary[0][:3]:
        selected.append(sentence)
    for sentences in sentences_by_summary[1:]:
        if sentences and len(selected) < 5:
            selected.append(sentences[0])
    for sentences in sentences_by_summary:
        for sentence in sentences:
            if len(selected) >= 5:
                break
            if sentence not in selected:
                selected.append(sentence)
    return " ".join(selected[:5])


def analizar_transcripcion(
    texto: str,
    nombre_comite: str = "",
    model: str = GROQ_MODEL,
) -> dict[str, Any]:
    if not texto or not texto.strip():
        raise ValueError("La transcripciÃ³n estÃ¡ vacÃ­a; no hay texto para analizar.")

    settings = get_settings()
    api_key = settings.groq_api_key
    if hasattr(api_key, "get_secret_value"):
        api_key = api_key.get_secret_value()
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    chunks = _split_transcript(texto.strip())
    print(f"Analizando transcripciÃ³n con Groq ({len(chunks)} chunk(s))...")
    analyses = []
    for index, chunk in enumerate(chunks, start=1):
        print(f"Analizando chunk {index}/{len(chunks)} ({len(chunk):,} caracteres)...")
        analyses.append(_analyze_chunk(chunk, nombre_comite, model, headers))

    return {
        "resumen_ejecutivo": _combine_summaries([item["resumen_ejecutivo"] for item in analyses]),
        **{
            field: _combine_summaries([item[field] for item in analyses])
            for field in ("problema", "solucion", "mercado", "finanzas", "conclusion")
        },
        "proximos_pasos": list(dict.fromkeys(step for item in analyses for step in item["proximos_pasos"])),
        "problemas_identificados": [problem for item in analyses for problem in item["problemas_identificados"]],
        "acuerdos_alcanzados": [agreement for item in analyses for agreement in item["acuerdos_alcanzados"]],
        "puntos_clave": [point for item in analyses for point in item["puntos_clave"]],
        "participantes_mencionados": [
            participant for item in analyses for participant in item["participantes_mencionados"]
        ],
    }


def calcular_metricas_reunion(
    resumen: str,
    acuerdos: list[dict[str, Any]],
    problemas: list[dict[str, Any]],
    puntos_clave: list[str],
    participantes_count: int,
) -> dict[str, int | None]:
    """Calcula indicadores simples y reproducibles para el informe."""
    puntaje = None
    if resumen and resumen.strip():
        puntaje = min(100, 30 + len(acuerdos) * 5 + len(problemas) * 3 + len(puntos_clave) * 2)
    return {
        "puntaje_informe": puntaje,
        "participacion_score": min(100, max(0, participantes_count) * 8),
        "sentimiento_score": 70,
    }


