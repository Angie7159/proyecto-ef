import axios from 'axios'

const botApi = axios.create({
  baseURL: 'http://localhost:8000/api',
  timeout: 600_000,
})

export type AgregarReunionPorLinkParams = {
  meeting_url: string
  titulo: string
  comite_id: string | null
  duracion_min: number
}

export type AgregarReunionPorLinkResponse = {
  id?: string
  reunion_id?: string
  [key: string]: unknown
}

export type EstadoBotResponse = {
  reunion_id: string
  progreso: string | null
  estado: string
  tiempo_transcurrido_seg: number
  subtitulos_capturados: number
  error_mensaje?: string | null
}

export async function agregarReunionPorLink(params: AgregarReunionPorLinkParams) {
  const response = await botApi.post<AgregarReunionPorLinkResponse>(
    '/bot/agregar-reunion-link',
    params,
  )
  return response.data
}

export async function obtenerEstadoBot(reunionId: string) {
  const response = await botApi.get<EstadoBotResponse>(
    `/bot/estado/${encodeURIComponent(reunionId)}`,
  )
  return response.data
}

export async function detenerBot(reunionId: string) {
  const response = await botApi.post<{ success: boolean; mensaje: string }>(
    `/bot/detener/${encodeURIComponent(reunionId)}`,
    {},
  )
  return response.data
}

export async function reanalizarReunion(reunionId: string) {
  const response = await botApi.post<{ success: boolean; reunion_id: string; acuerdos_generados: number; mensaje: string }>(
    `/reuniones/${encodeURIComponent(reunionId)}/reanalizar`,
    {},
    { timeout: 300_000 },
  )
  return response.data
}

export type DiagnosticoBotResponse = {
  reunion_id: string
  screenshots: string[]
  pages: string[]
  subtitulos_capturados: { timestamp: number; texto: string }[]
  eventos: string
}

export type EstadoCuentaMicrosoft = {
  conectada: boolean
  email: string | null
  fecha_conexion: string | null
}

export async function obtenerEstadoCuentaMicrosoft() {
  const response = await botApi.get<EstadoCuentaMicrosoft>('/cuentas/estado')
  return response.data
}

export async function conectarCuentaMicrosoft() {
  const response = await botApi.post<{ success: boolean; email: string | null; nombre: string | null }>(
    '/cuentas/conectar-microsoft',
    {},
    { timeout: 370_000 },
  )
  return response.data
}

export async function confirmarConexionMicrosoft() {
  const response = await botApi.post<{ success: boolean; email: string | null; mensaje: string }>(
    '/cuentas/confirmar-conexion',
    {},
  )
  return response.data
}

export async function desconectarCuentaMicrosoft() {
  const response = await botApi.delete<{ success: boolean }>('/cuentas/desconectar')
  return response.data
}

export async function obtenerDiagnosticoBot(reunionId: string) {
  const response = await botApi.get<DiagnosticoBotResponse>(
    `/bot/logs/${encodeURIComponent(reunionId)}`,
  )
  return response.data
}

export function obtenerUrlArchivoDiagnostico(reunionId: string, filename: string) {
  return `http://localhost:8000/api/bot/logs/${encodeURIComponent(reunionId)}/files/${encodeURIComponent(filename)}`
}
