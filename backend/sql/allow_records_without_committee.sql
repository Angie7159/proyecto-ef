-- Permite reuniones generales y acuerdos sin comité.
ALTER TABLE public.reuniones
  ALTER COLUMN comite_id DROP NOT NULL;

ALTER TABLE public.acuerdos
  ALTER COLUMN comite_id DROP NOT NULL;
