ALTER TABLE public.reuniones
  ADD COLUMN IF NOT EXISTS progreso TEXT DEFAULT NULL;

ALTER TABLE public.reuniones
  ADD COLUMN IF NOT EXISTS error_mensaje TEXT;
