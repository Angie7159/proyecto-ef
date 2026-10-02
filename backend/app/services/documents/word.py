from collections import defaultdict
from datetime import date, datetime
from io import BytesIO
import re
from typing import Any

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Inches, Pt, RGBColor


def _format_date(value: Any) -> str:
    if value is None or value == "":
        return "Sin fecha"
    if isinstance(value, datetime):
        return value.strftime("%d/%m/%Y")
    if isinstance(value, date):
        return value.strftime("%d/%m/%Y")
    try:
        return date.fromisoformat(str(value)[:10]).strftime("%d/%m/%Y")
    except ValueError:
        return str(value)


def _set_word_font(document: Document) -> None:
    normal = document.styles["Normal"]
    normal.font.name = "Calibri"
    normal.font.size = Pt(10)
    for style_name in ("Heading 1", "Heading 2", "Heading 3"):
        document.styles[style_name].font.name = "Calibri"


def _save_document(document: Document) -> bytes:
    buffer = BytesIO()
    document.save(buffer)
    return buffer.getvalue()


def generar_word_resumen(reunion: dict[str, Any], acuerdos: list[dict[str, Any]]) -> bytes:
    document = Document()
    _set_word_font(document)
    section = document.sections[0]
    section.top_margin = Inches(0.7)
    section.bottom_margin = Inches(0.7)

    title = document.add_heading("Resumen Ejecutivo", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    committee = reunion.get("comites") or {}
    if isinstance(committee, list):
        committee = committee[0] if committee else {}
    committee_name = committee.get("nombre") if isinstance(committee, dict) else None
    subtitle = document.add_paragraph(
        f"{committee_name or 'Comité no asignado'} - {_format_date(reunion.get('fecha'))}"
    )
    subtitle.alignment = WD_ALIGN_PARAGRAPH.CENTER

    document.add_heading("1. Resumen General", level=1)
    document.add_paragraph(reunion.get("resumen_ejecutivo") or "No hay resumen ejecutivo disponible.")

    document.add_heading("2. Problemas Identificados", level=1)
    problems = reunion.get("problemas_identificados") or []
    if problems:
        for problem in problems:
            paragraph = document.add_paragraph(style="List Bullet")
            paragraph.add_run(f"{problem.get('titulo', 'Problema')}: ").bold = True
            paragraph.add_run(problem.get("descripcion", ""))
            if problem.get("categoria"):
                paragraph.add_run(f" [{problem['categoria']}]")
    else:
        document.add_paragraph("No se identificaron problemas.")

    document.add_heading("3. Acuerdos Alcanzados", level=1)
    if acuerdos:
        table = document.add_table(rows=1, cols=5)
        table.style = "Light Shading Accent 1"
        for cell, heading in zip(table.rows[0].cells, ["Acuerdo", "Responsable", "Fecha límite", "Estado", "Categoría"]):
            cell.text = heading
        for agreement in acuerdos:
            cells = table.add_row().cells
            cells[0].text = str(agreement.get("descripcion", ""))
            cells[1].text = str(agreement.get("responsable") or "Sin asignar")
            cells[2].text = _format_date(agreement.get("fecha_limite"))
            cells[3].text = str(agreement.get("estado", "pendiente")).replace("_", " ").title()
            cells[4].text = str(agreement.get("categoria") or "Otro")
    else:
        document.add_paragraph("No se registraron acuerdos.")

    document.add_heading("4. Responsables Asignados", level=1)
    by_owner: dict[str, list[str]] = defaultdict(list)
    for agreement in acuerdos:
        by_owner[agreement.get("responsable") or "Sin asignar"].append(agreement.get("descripcion", ""))
    if by_owner:
        for owner, descriptions in sorted(by_owner.items()):
            paragraph = document.add_paragraph(style="List Bullet")
            paragraph.add_run(f"{owner}: ").bold = True
            paragraph.add_run("; ".join(descriptions))
    else:
        document.add_paragraph("No hay responsables asignados.")

    footer = section.footer.paragraphs[0]
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    footer.add_run(f"Generado el {_format_date(date.today())}").font.color.rgb = RGBColor(100, 116, 139)
    return _save_document(document)


def generar_word_mapa_mental(reunion: dict[str, Any]) -> bytes:
    document = Document()
    _set_word_font(document)
    title_text = reunion.get("titulo_final") or reunion.get("titulo") or "Reunión"
    title = document.add_heading(f"Mapa Mental - {title_text}", level=0)
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER

    document.add_heading(title_text, level=1)
    points = reunion.get("puntos_clave") or []
    problems = reunion.get("problemas_identificados") or []
    for point in points:
        document.add_heading(str(point), level=2)
        point_words = {word.casefold() for word in str(point).split() if len(word) > 4}
        related = [
            problem.get("descripcion", "")
            for problem in problems
            if point_words.intersection(
                word.casefold() for word in f"{problem.get('titulo', '')} {problem.get('descripcion', '')}".split()
            )
        ]
        details = related[:3]
        if len(details) < 2 and reunion.get("resumen_ejecutivo"):
            summary_sentences = [
                sentence.strip()
                for sentence in re.split(r"(?<=[.!?])\s+", str(reunion["resumen_ejecutivo"]))
                if sentence.strip()
            ]
            for sentence in summary_sentences:
                if sentence not in details:
                    details.append(sentence)
                if len(details) >= 2:
                    break
        for detail in details:
            document.add_paragraph(str(detail), style="List Bullet")

    instruction = document.add_paragraph()
    instruction.paragraph_format.space_before = Pt(12)
    instruction.add_run(
        "Instrucción: Selecciona todo el texto → Pestaña Inicio → Convertir a SmartArt → "
        "Proceso → Elige el diseño deseado."
    ).italic = True
    return _save_document(document)
