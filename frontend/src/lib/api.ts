import axios from 'axios'

export const apiClient = axios.create({
  baseURL: '/api',
})

export type ProcesamientoCompletoResponse = {
  reunion_id: string
  estado: 'en_proceso'
  mensaje: string
}

export type EstadoReunionResponse = {
  reunion_id: string
  estado: 'pendiente_asignacion' | 'en_proceso' | 'procesada' | 'error'
  progreso: string | null
  error_mensaje: string | null
  updated_at: string
}

export async function procesarReunionCompleta(reunionId: string) {
  const response = await apiClient.post<ProcesamientoCompletoResponse>(
    `/reuniones/${encodeURIComponent(reunionId)}/procesar-completo`,
    {},
    { timeout: 30_000 },
  )
  return response.data
}

export async function obtenerEstadoReunion(reunionId: string) {
  const response = await apiClient.get<EstadoReunionResponse>(
    `/reuniones/${encodeURIComponent(reunionId)}/estado`,
  )
  return response.data
}

export async function reanalizarReunion(reunionId: string) {
  const response = await apiClient.post<{ success: boolean; reunion_id: string; acuerdos_generados: number; mensaje: string }>(
    `/reuniones/${encodeURIComponent(reunionId)}/reanalizar`,
    {},
    { timeout: 300_000 },
  )
  return response.data
}

export async function actualizarTituloReunion(reunionId: string, titulo_final: string) {
  const response = await apiClient.patch(`/reuniones/${encodeURIComponent(reunionId)}`, { titulo_final })
  return response.data
}

export type DocumentoReunion = 'word_resumen' | 'word_mapa_conceptual'

export async function generarDocumentoReunion(reunionId: string, tipo: DocumentoReunion) {
  const response = await apiClient.post<{ url: string; tipo: DocumentoReunion }>(
    `/documentos/generar/${encodeURIComponent(reunionId)}/${tipo}`,
    {},
    { timeout: 300_000 },
  )
  return response.data
}

export type ComiteSeguimiento = { id: string; nombre: string; color: string | null; reuniones_count: number }
export type ReunionSeguimiento = { id: string; titulo_final: string | null; fecha: string; hora_inicio: string | null; hora_fin: string | null; estado: string; participantes_count: number | null }

export async function listarComitesSeguimiento() {
  const response = await apiClient.get<ComiteSeguimiento[]>('/seguimiento/comites')
  return response.data
}

export async function listarReunionesSeguimiento(comiteId: string) {
  const response = await apiClient.get<ReunionSeguimiento[]>(`/seguimiento/reuniones/${encodeURIComponent(comiteId)}`)
  return response.data
}

export async function generarExcelSeguimiento(comiteId: string, reunionIds: string[]) {
  const response = await apiClient.post<Blob>('/seguimiento/generar-excel', {
    comite_id: comiteId,
    reunion_ids: reunionIds,
  }, { responseType: 'blob', timeout: 120_000 })
  return response.data
}

export function getApiErrorMessage(error: unknown) {
  if (axios.isAxiosError(error)) {
    const detail = error.response?.data?.detail
    if (typeof detail === 'string') return detail
    if (detail && typeof detail === 'object' && typeof detail.error === 'string') return detail.error
    if (typeof error.response?.data?.error === 'string') return error.response.data.error
    return error.message || 'No se pudo procesar la reunión.'
  }
  return error instanceof Error ? error.message : 'Ocurrió un error inesperado.'
}
