ALTER TABLE public.reuniones
    ADD COLUMN IF NOT EXISTS seccion_problema TEXT,
    ADD COLUMN IF NOT EXISTS seccion_solucion TEXT,
    ADD COLUMN IF NOT EXISTS seccion_mercado TEXT,
    ADD COLUMN IF NOT EXISTS seccion_finanzas TEXT,
    ADD COLUMN IF NOT EXISTS seccion_conclusion TEXT,
    ADD COLUMN IF NOT EXISTS seccion_proximos_pasos TEXT;

NOTIFY pgrst, 'reload schema';
