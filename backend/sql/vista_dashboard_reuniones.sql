-- Muestra también reuniones con estado 'error' en la vista del dashboard.
-- Ejecutar en Supabase SQL Editor después de confirmar los grants del proyecto.
DROP VIEW IF EXISTS vista_dashboard_reuniones;

CREATE VIEW vista_dashboard_reuniones AS
SELECT
    r.id,
    r.titulo_final AS titulo,
    r.fecha,
    r.hora_inicio,
    r.hora_fin,
    r.duracion_min,
    r.participantes_count AS participantes,
    r.fuente,
    r.estado,
    r.progreso,
    r.error_mensaje,
    c.id AS comite_id,
    c.nombre AS comite_nombre,
    c.color AS comite_color,
    r.resumen_ejecutivo AS resumen_corto,
    (
        SELECT COUNT(*)
        FROM acuerdos a
        WHERE a.reunion_id = r.id
          AND a.estado IN ('pendiente', 'en_proceso')
    ) AS acuerdos_pendientes,
    (
        SELECT COUNT(*)
        FROM acuerdos a
        WHERE a.reunion_id = r.id
          AND a.es_nuevo = true
    ) AS acuerdos_nuevos,
    r.created_at
FROM reuniones r
LEFT JOIN comites c ON r.comite_id = c.id
ORDER BY r.fecha DESC, r.hora_inicio DESC;
