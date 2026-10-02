import axios from 'axios'

export const apiClient = axios.create({
  baseURL: '/api',
})

export type ProcesamientoCompletoResponse = {
  reunion_id: string
  estado: 'procesada'
  transcripcion_caracteres: number
  acuerdos_detectados: number
  problemas_detectados: number
  archivos_generados: {
    excel: string
    word_resumen: string
    word_smartart: string
  }
  tiempo_total_seg: number
}

export async function procesarReunionCompleta(reunionId: string) {
  const response = await apiClient.post<ProcesamientoCompletoResponse>(
    `/reuniones/${encodeURIComponent(reunionId)}/procesar-completo`,
    {},
    { timeout: 600_000 },
  )
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
