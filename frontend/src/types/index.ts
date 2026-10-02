// ============================================
// TIPOS DEL DOMINIO MEETIA
// ============================================

export type EstadoReunion = 
  | 'pendiente_asignacion' 
  | 'en_proceso' 
  | 'procesada' 
  | 'error';

export type FuenteReunion = 
  | 'teams_auto' 
  | 'teams_manual' 
  | 'zoom' 
  | 'presencial' 
  | 'upload';

export type EstadoAcuerdo = 
  | 'pendiente' 
  | 'en_proceso' 
  | 'cumplido' 
  | 'vencido';

export type CategoriaAcuerdo = 
  | 'Académico' 
  | 'Gestión' 
  | 'Estudiantes' 
  | 'Infraestructura' 
  | 'Otro';

export type FrecuenciaComite = 
  | 'semanal' 
  | 'quincenal' 
  | 'mensual' 
  | 'ad-hoc';

export interface Comite {
  id: string;
  nombre: string;
  descripcion: string | null;
  frecuencia: FrecuenciaComite | null;
  color: string;
  participantes_habituales: string[];
  activo: boolean;
  created_at: string;
  updated_at: string;
}

export interface ReunionListItem {
  id: string;
  titulo: string;
  fecha: string;
  hora_inicio: string | null;
  hora_fin: string | null;
  duracion_min: number | null;
  participantes: number;
  fuente: FuenteReunion;
  estado: EstadoReunion;
  comite_id: string | null;
  comite_nombre: string | null;
  comite_color: string | null;
  resumen_corto: string | null;
  acuerdos_pendientes: number;
  acuerdos_nuevos: number;
  created_at: string;
}

export interface Reunion {
  id: string;
  comite_id: string | null;
  titulo_original: string | null;
  titulo_final: string;
  fecha: string;
  hora_inicio: string | null;
  hora_fin: string | null;
  duracion_min: number | null;
  participantes_count: number;
  participantes_lista: any[];
  fuente: FuenteReunion;
  estado: EstadoReunion;
  transcripcion: string | null;
  resumen_ejecutivo: string | null;
  problemas_identificados: any[];
  puntos_clave: string[];
  archivo_excel_url: string | null;
  archivo_word_resumen_url: string | null;
  archivo_word_smartart_url: string | null;
  audio_url: string | null;
  progreso?: string | null;
  error_mensaje?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Acuerdo {
  id: string;
  reunion_id: string;
  comite_id: string;
  descripcion: string;
  responsable: string | null;
  fecha_limite: string | null;
  estado: EstadoAcuerdo;
  categoria: CategoriaAcuerdo | null;
  es_nuevo: boolean;
  reunion_origen_id: string | null;
  observaciones: string | null;
  created_at: string;
  updated_at: string;
}
