from datetime import date, datetime, time
from io import BytesIO
from typing import Any

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter


HEADER_FILL = PatternFill("solid", fgColor="E2E8F0")
THIN_BORDER = Border(
    left=Side(style="thin", color="CBD5E1"),
    right=Side(style="thin", color="CBD5E1"),
    top=Side(style="thin", color="CBD5E1"),
    bottom=Side(style="thin", color="CBD5E1"),
)
STATUS_STYLES = {
    "pendiente": ("FEF3C7", "92400E", "Pendiente"),
    "en_proceso": ("DBEAFE", "1E40AF", "En Proceso"),
    "cumplido": ("DCFCE7", "166534", "Cumplido"),
    "vencido": ("FEE2E2", "991B1B", "Vencido"),
}
CATEGORY_COLORS = {
    "Académico": "DBEAFE",
    "Gestión": "EDE9FE",
    "Estudiantes": "DCFCE7",
    "Infraestructura": "FEF3C7",
    "Otro": "E2E8F0",
}


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


def _format_time(value: Any) -> str:
    if value is None or value == "":
        return "—"
    if isinstance(value, time):
        return value.strftime("%H:%M")
    return str(value)[:5]


def _participants(reunion: dict[str, Any]) -> str:
    participants = reunion.get("participantes_lista") or reunion.get("participantes") or []
    if isinstance(participants, list):
        names = [
            str(item.get("nombre", item)) if isinstance(item, dict) else str(item)
            for item in participants
        ]
        if names:
            return ", ".join(names)
    count = reunion.get("participantes_count", reunion.get("participantes"))
    return str(count) if count is not None else "—"


def _set_table_style(sheet, header_row: int = 1) -> None:
    for cell in sheet[header_row]:
        cell.font = Font(bold=True, color="0F172A")
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
        cell.border = THIN_BORDER
    sheet.row_dimensions[header_row].height = 24


def _style_table_borders(sheet, min_row: int = 1) -> None:
    for row in sheet.iter_rows(min_row=min_row):
        for cell in row:
            cell.border = THIN_BORDER
            cell.alignment = Alignment(vertical="top", wrap_text=True)


def _auto_width(sheet, max_width: int = 60) -> None:
    for column_cells in sheet.columns:
        max_length = max((len(str(cell.value or "")) for cell in column_cells), default=0)
        column_letter = get_column_letter(column_cells[0].column)
        sheet.column_dimensions[column_letter].width = min(max(max_length + 2, 12), max_width)


def generar_excel(
    reunion: dict[str, Any],
    acuerdos_nuevos: list[dict[str, Any]],
    acuerdos_anteriores: list[dict[str, Any]],
) -> bytes:
    workbook = Workbook()
    summary = workbook.active
    summary.title = "Resumen"
    title = reunion.get("titulo_final") or reunion.get("titulo") or "Reunión"
    summary.append([f"Informe de Reunión - {title}"])
    summary["A1"].font = Font(bold=True, size=16, color="0F172A")
    summary.merge_cells("A1:C1")
    summary.append(["Fecha", _format_date(reunion.get("fecha"))])
    summary.append(["Hora", f"{_format_time(reunion.get('hora_inicio'))} - {_format_time(reunion.get('hora_fin'))}"])
    summary.append(["Duración (min)", reunion.get("duracion_min") or "—"])
    summary.append(["Participantes", _participants(reunion)])
    summary.append([])
    summary.append(["Resumen Ejecutivo"])
    summary["A7"].font = Font(bold=True, size=12)
    summary.append([reunion.get("resumen_ejecutivo") or "Sin resumen disponible."])
    summary.merge_cells(start_row=8, start_column=1, end_row=8, end_column=3)
    summary["A8"].alignment = Alignment(wrap_text=True, vertical="top")
    summary.row_dimensions[8].height = 72
    summary.append([])
    summary.append(["Problemas identificados"])
    summary["A10"].font = Font(bold=True, size=12)
    summary.append(["Título", "Descripción", "Categoría"])
    _set_table_style(summary, 11)
    for problem in reunion.get("problemas_identificados") or []:
        summary.append([
            problem.get("titulo", ""),
            problem.get("descripcion", ""),
            problem.get("categoria", ""),
        ])
    problem_end = summary.max_row
    if problem_end >= 11:
        _style_table_borders(summary, 11)
    summary.append([])
    summary.append(["Puntos clave"])
    summary.cell(summary.max_row, 1).font = Font(bold=True, size=12)
    for point in reunion.get("puntos_clave") or []:
        summary.append([f"• {point}"])
    summary.column_dimensions["A"].width = 28
    summary.column_dimensions["B"].width = 52
    summary.column_dimensions["C"].width = 20

    followup = workbook.create_sheet("Seguimiento")
    headers = ["ID", "Reunión origen", "Acuerdo", "Responsable", "Fecha límite", "Estado", "Categoría"]
    followup.append(headers)
    _set_table_style(followup)
    rows = [(item, False) for item in acuerdos_anteriores] + [(item, True) for item in acuerdos_nuevos]
    for agreement, is_new in rows:
        followup.append([
            agreement.get("id", ""),
            agreement.get("reunion_origen_titulo") or agreement.get("reunion_origen_id") or title,
            agreement.get("descripcion", ""),
            agreement.get("responsable") or "Sin asignar",
            _format_date(agreement.get("fecha_limite")),
            agreement.get("estado", "pendiente"),
            agreement.get("categoria") or "Otro",
        ])
        row_number = followup.max_row
        if is_new:
            followup.cell(row_number, 2).value = f"{title} (nuevo)"
    _style_table_borders(followup)
    for row_number in range(2, followup.max_row + 1):
        status = str(followup.cell(row_number, 6).value or "pendiente").lower()
        fill_color, text_color, label = STATUS_STYLES.get(status, STATUS_STYLES["pendiente"])
        status_cell = followup.cell(row_number, 6)
        status_cell.value = label
        status_cell.fill = PatternFill("solid", fgColor=fill_color)
        status_cell.font = Font(color=text_color, bold=True)
    followup.freeze_panes = "A2"

    legend = workbook.create_sheet("Leyenda")
    legend.append(["Estados", "Color"])
    _set_table_style(legend)
    for key, (fill_color, text_color, label) in STATUS_STYLES.items():
        legend.append([label, fill_color])
        legend.cell(legend.max_row, 1).fill = PatternFill("solid", fgColor=fill_color)
        legend.cell(legend.max_row, 1).font = Font(color=text_color, bold=True)
    legend.append([])
    legend.append(["Categorías", "Color"])
    _set_table_style(legend, legend.max_row)
    for category, fill_color in CATEGORY_COLORS.items():
        legend.append([category, fill_color])
        legend.cell(legend.max_row, 1).fill = PatternFill("solid", fgColor=fill_color)
    _style_table_borders(legend)

    for sheet in workbook.worksheets:
        _auto_width(sheet)
    buffer = BytesIO()
    workbook.save(buffer)
    return buffer.getvalue()
