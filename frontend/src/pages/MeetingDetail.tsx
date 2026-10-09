import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, CircleHelp, Clock3, Download, FileText, LoaderCircle, Pencil, RefreshCw, Search, Users } from 'lucide-react'
import { format, parse, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Area, AreaChart, Bar, BarChart, PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer, XAxis, YAxis } from 'recharts'
import { supabase } from '@/lib/supabase'
import { actualizarTituloReunion, generarDocumentoReunion, getApiErrorMessage, obtenerEstadoReunion, procesarReunionCompleta, reanalizarReunion, type DocumentoReunion } from '@/lib/api'
import type { Acuerdo, Comite, EstadoAcuerdo, EstadoReunion, Reunion, ReunionParticipant } from '@/types'

type ReunionConComite = Reunion & { comites: Pick<Comite, 'id' | 'nombre' | 'color'> | null }
type ProblemaIdentificado = {
  titulo?: string
  descripcion?: string
  categoria?: string
}

const meetingStatusLabels: Record<EstadoReunion, string> = {
  pendiente_asignacion: 'Pendiente de asignación',
  en_proceso: 'En proceso',
  procesada: 'Procesada',
  error: 'Error',
}

const meetingStatusClasses: Record<EstadoReunion, string> = {
  pendiente_asignacion: 'border-amber-200 bg-amber-50 text-amber-700',
  en_proceso: 'border-blue-200 bg-blue-50 text-blue-700',
  procesada: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  error: 'border-red-200 bg-red-50 text-red-700',
}

const agreementStatusLabels: Record<EstadoAcuerdo, string> = {
  pendiente: 'Pendiente',
  en_proceso: 'En proceso',
  cumplido: 'Cumplido',
  vencido: 'Vencido',
}

function formatTime(value: string | null) {
  if (!value) return null
  const parsed = parse(value, value.length > 5 ? 'HH:mm:ss' : 'HH:mm', new Date())
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 5) : format(parsed, 'H:mm')
}

function formatDate(value: string) {
  return format(parseISO(value), 'EEE, d MMM yyyy', { locale: es }).replace('.', '')
}

function initials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?'
}

function participantDetails(value: ReunionParticipant | string) {
  if (typeof value === 'string') return { nombre: value, email: '', rol: '' }
  return {
    nombre: value.nombre || value.name || 'Participante',
    email: value.email || '',
    rol: value.rol || value.role || '',
  }
}

function scoreBand(score: number) {
  if (score <= 40) return { label: 'DEFICIENTE', color: '#EF4444', text: 'text-red-700' }
  if (score <= 60) return { label: 'MEJORABLE', color: '#F59E0B', text: 'text-amber-700' }
  if (score <= 80) return { label: 'ACEPTABLE', color: '#EAB308', text: 'text-yellow-800' }
  return { label: 'EXCELENTE', color: '#10B981', text: 'text-emerald-700' }
}

function progressLabel(progress: string | null | undefined) {
  const value = (progress ?? '').toLocaleLowerCase()
  if (value.includes('transcrib')) return 'Transcribiendo...'
  if (value.includes('analiz')) return 'Analizando...'
  if (value.includes('document') || value.includes('generando')) return 'Generando documentos...'
  if (value.includes('bot_enviado')) return 'Preparando reunión...'
  return progress?.trim() || 'Procesando...'
}

function progressDetails(progress: string | null | undefined) {
  const value = (progress ?? '').toLocaleLowerCase()
  if (value.includes('descargando')) return { label: 'Descargando audio', percent: 25 }
  if (value.includes('transcrib')) return { label: 'Transcribiendo con IA', percent: 50 }
  if (value.includes('analiz') || value.includes('reanaliz')) return { label: 'Analizando con IA', percent: 75 }
  if (value.includes('generando') || value.includes('document')) return { label: 'Generando documentos', percent: 90 }
  if (value.includes('subiendo')) return { label: 'Subiendo archivos', percent: 95 }
  if (value.includes('complet') || value.includes('listo')) return { label: 'Completado', percent: 100 }
  return { label: 'Iniciando procesamiento', percent: 8 }
}

function DocumentDownloadButton({ label, icon: Icon, url }: { label: string; icon: typeof Download; url: string | null }) {
  return (
    <Button
      type="button"
      variant="outline"
      disabled={!url}
      onClick={() => { if (url) window.open(url, '_blank', 'noopener,noreferrer') }}
    >
      <Icon className="h-4 w-4" /> {label}
    </Button>
  )
}

function MeetingDetail() {
  const { id } = useParams<{ id: string }>()
  const queryClient = useQueryClient()
  const [selectedCommittee, setSelectedCommittee] = useState('')
  const [assignmentDialogOpen, setAssignmentDialogOpen] = useState(false)
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [participantSearch, setParticipantSearch] = useState('')
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')

  const meetingQuery = useQuery({
    queryKey: ['reunion', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reuniones')
        .select('*, comites(id, nombre, color)')
        .eq('id', id!)
        .maybeSingle()
      if (error) throw error
      return data as ReunionConComite | null
    },
  })

  const meetingStatusQuery = useQuery({
    queryKey: ['reunion-estado', id],
    enabled: Boolean(id),
    queryFn: () => obtenerEstadoReunion(id!),
    refetchInterval: (query) => query.state.data?.estado === 'en_proceso' ? 5000 : false,
  })

  useEffect(() => {
    const status = meetingStatusQuery.data
    if (!status || !id) return
    const previous = queryClient.getQueryData<ReunionConComite | null>(['reunion', id])
    queryClient.setQueryData<ReunionConComite | null>(['reunion', id], (current) => current ? {
      ...current,
      estado: status.estado,
      progreso: status.progreso,
      error_mensaje: status.error_mensaje,
      updated_at: status.updated_at,
    } : current)
    if (previous?.estado === 'en_proceso' && status.estado === 'procesada') {
      toast.success('Reunión procesada correctamente')
      void queryClient.invalidateQueries({ queryKey: ['acuerdos', id] })
      void queryClient.invalidateQueries({ queryKey: ['reuniones'] })
    }
  }, [id, meetingStatusQuery.data, queryClient])

  const agreementsQuery = useQuery({
    queryKey: ['acuerdos', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('acuerdos')
        .select('*')
        .eq('reunion_id', id!)
        .order('created_at', { ascending: true })
      if (error) throw error
      return (data ?? []) as Acuerdo[]
    },
  })

  const committeesQuery = useQuery({
    queryKey: ['comites'],
    queryFn: async () => {
      const { data, error } = await supabase.from('comites').select('id, nombre, color').order('nombre')
      if (error) throw error
      return (data ?? []) as Pick<Comite, 'id' | 'nombre' | 'color'>[]
    },
  })

  const updateAgreement = useMutation({
    mutationFn: async ({ agreementId, status }: { agreementId: string; status: EstadoAcuerdo }) => {
      const { error } = await supabase.from('acuerdos').update({ estado: status }).eq('id', agreementId)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Estado del acuerdo actualizado')
      void queryClient.invalidateQueries({ queryKey: ['acuerdos', id] })
    },
    onError: () => toast.error('No se pudo actualizar el acuerdo'),
  })

  const assignCommittee = useMutation({
    mutationFn: async () => {
      if (!selectedCommittee || !id) throw new Error('Selecciona un comité')
      const { error } = await supabase.from('reuniones').update({ comite_id: selectedCommittee }).eq('id', id)
      if (error) throw error
      const { error: agreementsError } = await supabase.from('acuerdos').update({ comite_id: selectedCommittee }).eq('reunion_id', id).is('comite_id', null)
      if (agreementsError) throw agreementsError
    },
    onSuccess: () => {
      toast.success('Comité asignado')
      setAssignmentDialogOpen(false)
      void queryClient.invalidateQueries({ queryKey: ['reunion', id] })
      void queryClient.invalidateQueries({ queryKey: ['reuniones'] })
    },
    onError: () => toast.error('No se pudo asignar el comité'),
  })

  const processMeeting = useMutation({
    mutationFn: () => {
      if (!id) throw new Error('No se encontró el identificador de la reunión.')
      return procesarReunionCompleta(id)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reunion', id] }),
        queryClient.invalidateQueries({ queryKey: ['acuerdos', id] }),
        queryClient.invalidateQueries({ queryKey: ['reuniones'] }),
      ])
      toast.success('Procesamiento iniciado en segundo plano')
      void queryClient.invalidateQueries({ queryKey: ['reunion-estado', id] })
    },
    onError: async (error: unknown) => {
      await queryClient.invalidateQueries({ queryKey: ['reunion', id] })
      toast.error(getApiErrorMessage(error))
    },
  })

  const retryAnalysis = useMutation({
    mutationFn: () => {
      if (!id) throw new Error('No se encontró el identificador de la reunión.')
      return reanalizarReunion(id)
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['reunion', id] }),
        queryClient.invalidateQueries({ queryKey: ['acuerdos', id] }),
        queryClient.invalidateQueries({ queryKey: ['reuniones'] }),
      ])
      toast.success('Análisis completado')
    },
    onError: (error: unknown) => toast.error(getApiErrorMessage(error)),
  })

  const updateTitle = useMutation({
    mutationFn: () => {
      if (!id || !titleDraft.trim()) throw new Error('Escribe un título para la reunión.')
      return actualizarTituloReunion(id, titleDraft.trim())
    },
    onSuccess: async () => {
      setTitleEditing(false)
      await queryClient.invalidateQueries({ queryKey: ['reunion', id] })
      await queryClient.invalidateQueries({ queryKey: ['reuniones'] })
      toast.success('Título actualizado')
    },
    onError: (error: unknown) => toast.error(getApiErrorMessage(error)),
  })

  const generateDocument = useMutation({
    mutationFn: (type: DocumentoReunion) => {
      if (!id) throw new Error('No se encontró el identificador de la reunión.')
      return generarDocumentoReunion(id, type)
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['reunion', id] })
      toast.success('Documento generado')
    },
    onError: (error: unknown) => toast.error(getApiErrorMessage(error)),
  })

  useEffect(() => {
    if (!processMeeting.isPending) return
    const intervalId = window.setInterval(() => {
      void meetingQuery.refetch()
    }, 2000)
    return () => window.clearInterval(intervalId)
  }, [meetingQuery.refetch, processMeeting.isPending])

  useEffect(() => {
    if (meetingQuery.data?.estado !== 'procesada') return
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['acuerdos', id] }),
      queryClient.invalidateQueries({ queryKey: ['reuniones'] }),
    ])
  }, [id, meetingQuery.data?.estado, queryClient])

  if (meetingQuery.isLoading) {
    return (
      <div className="mx-auto max-w-7xl space-y-6 p-6 md:p-8">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-10 w-2/3" />
        <Skeleton className="h-6 w-80" />
        <Skeleton className="h-10 w-full max-w-xl" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (meetingQuery.isError) {
    return (
      <div className="mx-auto max-w-7xl p-6 md:p-8">
        <Card><CardContent className="p-8 text-center text-sm text-red-600">No se pudo cargar la reunión.</CardContent></Card>
      </div>
    )
  }

  const meeting = meetingQuery.data
  if (!meeting) {
    return (
      <div className="mx-auto flex min-h-[70vh] max-w-7xl flex-col items-center justify-center p-6 text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-slate-100 text-slate-500">
          <AlertCircle className="h-7 w-7" />
        </div>
        <h1 className="text-2xl font-semibold text-slate-900">Reunión no encontrada</h1>
        <p className="mt-2 text-sm text-slate-500">La reunión solicitada no existe o ya no está disponible.</p>
        <Button asChild className="mt-6"><Link to="/"><ArrowLeft className="h-4 w-4" /> Volver al dashboard</Link></Button>
      </div>
    )
  }

  const title = meeting.titulo_final || meeting.titulo_original || 'Reunión sin título'
  const start = formatTime(meeting.hora_inicio)
  const finish = formatTime(meeting.hora_fin)
  const dateDuration = `${formatDate(meeting.fecha)}${start ? ` · ${start}${finish ? ` - ${finish}` : ''}` : ''}${meeting.duracion_min != null ? ` · ${meeting.duracion_min} min` : ''}`
  const currentProgress = progressDetails(meeting.progreso)
  const problems = (meeting.problemas_identificados ?? []) as ProblemaIdentificado[]
  const keyPoints = meeting.puntos_clave ?? []
  const committee = meeting.comites
  const tieneAudio = Boolean(meeting.audio_url)
  const mostrarProcesar = tieneAudio && ['en_proceso', 'error', 'pendiente_asignacion'].includes(meeting.estado)
  const mostrarReanalizar = meeting.estado === 'error' && Boolean(meeting.transcripcion?.trim())
  const participants = (meeting.participantes_lista ?? []).map(participantDetails)
  const filteredParticipants = participants.filter((person) =>
    `${person.nombre} ${person.email} ${person.rol}`.toLocaleLowerCase().includes(participantSearch.trim().toLocaleLowerCase()),
  )
  const scoreCards = [
    { title: 'Puntaje informe', value: meeting.puntaje_informe },
    { title: 'Participación', value: meeting.participacion_score },
    { title: 'Sentimiento', value: meeting.sentimiento_score },
  ]
  const participationData = (meeting.participantes_lista ?? []).flatMap((participant, index) => {
    if (typeof participant === 'string') return []
    const rawValue = participant.intervenciones ?? participant.interventions
    const participated = participant.participo ?? participant.participated
    if (typeof rawValue !== 'number' && typeof participated !== 'boolean') return []
    return [{ name: participant.nombre || participant.name || `P${index + 1}`, value: typeof rawValue === 'number' ? rawValue : participated ? 1 : 0 }]
  })

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-7xl space-y-6 p-6 md:p-8">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-slate-500">
          <Link to="/reuniones" className="inline-flex shrink-0 items-center gap-1 hover:text-slate-900 hover:underline"><ArrowLeft className="h-3.5 w-3.5" />Reuniones</Link>
          <span aria-hidden="true" className="text-slate-300">/</span>
          <span className="max-w-md truncate font-medium text-slate-900">{title}</span>
        </nav>

        <header className="flex flex-col gap-5 border-b border-slate-200 pb-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {titleEditing ? (
                <input
                  autoFocus
                  value={titleDraft}
                  maxLength={300}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  onBlur={() => {
                    if (titleDraft.trim() && titleDraft.trim() !== title) updateTitle.mutate()
                    else setTitleEditing(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                  }}
                  disabled={updateTitle.isPending}
                  aria-label="Editar título de la reunión"
                  className="min-w-0 max-w-2xl rounded-md border border-indigo-300 bg-white px-2 py-1 text-2xl font-semibold text-slate-900 outline-none focus:ring-2 focus:ring-indigo-200"
                />
              ) : (
                <>
                  <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
                  <Button type="button" variant="ghost" size="icon" aria-label="Editar título" onClick={() => { setTitleDraft(title); setTitleEditing(true) }}>
                    <Pencil className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
            <p className="mt-2 text-sm text-slate-500">{dateDuration}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {committee && (
                <Badge className="border-transparent text-white" style={{ backgroundColor: committee.color }}>
                  {committee.nombre}
                </Badge>
              )}
              <span className="inline-flex items-center gap-1">
                <Badge variant="outline" className={meetingStatusClasses[meeting.estado]}>{meetingStatusLabels[meeting.estado]}</Badge>
                <Tooltip><TooltipTrigger asChild><button type="button" aria-label="Ayuda sobre estados" className="text-slate-400 hover:text-slate-700"><CircleHelp className="h-4 w-4" /></button></TooltipTrigger><TooltipContent className="max-w-xs"><p>Estados de una reunión:</p><p>• Pendiente: Recién subida, falta procesar</p><p>• En proceso: Transcribiendo o analizando con IA</p><p>• Procesada: Lista con resumen, acuerdos y documentos</p><p>• Error: Hubo un problema, revisa el detalle</p></TooltipContent></Tooltip>
              </span>
              {meeting.estado === 'en_proceso' && <Badge variant="outline" className="border-blue-200 bg-blue-50 text-blue-700">{progressLabel(meeting.progreso)}</Badge>}
              <button type="button" onClick={() => setParticipantsOpen(true)} className="inline-flex items-center -space-x-2 rounded-full pl-2 hover:opacity-80" aria-label={`Ver ${participants.length} participantes`}>
                {participants.slice(0, 5).map((person, index) => (
                  <span key={`${person.email}-${index}`} title={person.nombre} className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-indigo-100 text-xs font-semibold text-indigo-800">{initials(person.nombre)}</span>
                ))}
                {participants.length > 5 && <span className="flex h-8 items-center justify-center rounded-full border-2 border-white bg-slate-200 px-2 text-[10px] font-semibold text-slate-700">+{participants.length - 5} más</span>}
                {participants.length === 0 && <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-xs text-slate-600"><Users className="h-3.5 w-3.5" />{meeting.participantes_count || 0} participantes</span>}
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {mostrarProcesar && (
              <Button onClick={() => processMeeting.mutate()} disabled={processMeeting.isPending}>
                {processMeeting.isPending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                {processMeeting.isPending ? 'Iniciando...' : meeting.estado === 'error' ? 'Reintentar procesamiento' : 'Procesar'}
              </Button>
            )}
            {mostrarReanalizar && (
              <Button onClick={() => retryAnalysis.mutate()} disabled={retryAnalysis.isPending}>
                {retryAnalysis.isPending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                {retryAnalysis.isPending ? 'Re-analizando...' : '🔁 Reintentar análisis'}
              </Button>
            )}
            {(!committee || meeting.estado === 'pendiente_asignacion') && (
              <Dialog open={assignmentDialogOpen} onOpenChange={setAssignmentDialogOpen}>
                <DialogTrigger asChild><Button variant="outline">Asignar comité</Button></DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Asignar comité</DialogTitle>
                    <DialogDescription>Selecciona el comité responsable de esta reunión.</DialogDescription>
                  </DialogHeader>
                  <Select value={selectedCommittee} onValueChange={setSelectedCommittee}>
                    <SelectTrigger aria-label="Seleccionar comité"><SelectValue placeholder="Selecciona un comité" /></SelectTrigger>
                    <SelectContent>
                      {(committeesQuery.data ?? []).map((item) => (
                        <SelectItem key={item.id} value={item.id}>{item.nombre}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <DialogFooter>
                    <Button variant="outline" onClick={() => setAssignmentDialogOpen(false)}>Cancelar</Button>
                    <Button disabled={!selectedCommittee || assignCommittee.isPending} onClick={() => assignCommittee.mutate()}>
                      Asignar
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            )}
            {(meeting.estado === 'pendiente_asignacion' || meeting.estado === 'procesada') && (
              <>
                <DocumentDownloadButton label="Descargar Word" icon={FileText} url={meeting.archivo_word_resumen_url} />
              </>
            )}
          </div>
        </header>

        {meeting.estado === 'en_proceso' && (
          <Card className="border-indigo-200 bg-indigo-50/70">
            <CardContent className="p-5">
              <div className="flex items-center justify-between gap-3">
                <div><h2 className="font-semibold text-indigo-950">⏳ Procesando reunión...</h2><p className="mt-1 text-sm text-indigo-800">{currentProgress.label}</p></div>
                <span className="text-sm font-semibold text-indigo-700">{currentProgress.percent}%</span>
              </div>
              <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-indigo-100" role="progressbar" aria-label={currentProgress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={currentProgress.percent}>
                <div className="h-full rounded-full bg-indigo-600 transition-all duration-500" style={{ width: `${currentProgress.percent}%` }} />
              </div>
              {meetingStatusQuery.isError && <p className="mt-2 text-xs text-amber-700">No se pudo actualizar el progreso. Se reintentará en la siguiente consulta.</p>}
            </CardContent>
          </Card>
        )}

        <Dialog open={participantsOpen} onOpenChange={setParticipantsOpen}>
          <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
            <DialogHeader><DialogTitle>Participantes</DialogTitle><DialogDescription>{participants.length} participantes mencionados en la reunión.</DialogDescription></DialogHeader>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input value={participantSearch} onChange={(event) => setParticipantSearch(event.target.value)} placeholder="Buscar por nombre" aria-label="Buscar participante por nombre" className="h-10 w-full rounded-md border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-indigo-200" />
            </div>
            <div className="space-y-2">
              {filteredParticipants.map((person, index) => (
                <div key={`${person.email}-${person.nombre}-${index}`} className="flex items-center gap-3 rounded-lg border border-slate-100 p-3">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-sm font-semibold text-indigo-800">{initials(person.nombre)}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium text-slate-900">{person.nombre}</span><span className="block truncate text-xs text-slate-500">{person.email || 'Email no disponible'}</span></span>
                  {person.rol && <Badge variant="outline">{person.rol}</Badge>}
                </div>
              ))}
              {filteredParticipants.length === 0 && <p className="py-6 text-center text-sm text-slate-500">{participants.length ? 'No hay coincidencias.' : 'No se encontraron nombres de participantes en la transcripción.'}</p>}
            </div>
          </DialogContent>
        </Dialog>

        {meeting.error_mensaje && meeting.estado === 'error' && (
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-start gap-3 p-4 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div><p className="font-medium">No se pudo procesar la reunión</p><p className="mt-1">{meeting.error_mensaje}</p></div>
            </CardContent>
          </Card>
        )}

        <section aria-label="Métricas de la reunión" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {scoreCards.map(({ title: metricTitle, value }) => {
            const score = value == null ? null : Math.max(0, Math.min(100, value))
            const band = score == null ? null : scoreBand(score)
            return (
              <Card key={metricTitle} className="h-[160px]">
                <CardContent className="flex h-full flex-col p-4">
                  <p className="text-sm font-medium text-slate-500">{metricTitle}</p>
                  {score == null ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-1 text-slate-400"><Clock3 className="h-5 w-5" /><span className="text-xs">Pendiente de análisis</span></div>
                  ) : metricTitle.toLowerCase().includes('particip') && participationData.length === 0 ? (
                    <div className="flex flex-1 items-center justify-center gap-3"><span className="text-3xl font-semibold text-slate-900">{score}</span><span className="max-w-28 text-center text-xs text-slate-400">Sin datos de participación individual</span></div>
                  ) : metricTitle.toLowerCase().includes('particip') ? (
                    <div className="relative min-h-0 flex-1"><ResponsiveContainer width="100%" height="100%"><BarChart data={participationData} margin={{ top: 8, right: 2, left: 2, bottom: 0 }}><XAxis dataKey="name" hide /><YAxis hide /><Bar dataKey="value" fill="#6366F1" radius={[3, 3, 0, 0]} /></BarChart></ResponsiveContainer><span className="pointer-events-none absolute inset-0 flex items-center justify-center text-3xl font-semibold text-slate-900">{score}</span></div>
                  ) : metricTitle === 'Sentimiento' ? (
                    <div className="relative min-h-0 flex-1"><ResponsiveContainer width="100%" height="100%"><AreaChart data={[{ value: score }, { value: score }, { value: score }, { value: score }]} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}><Area type="monotone" dataKey="value" stroke={score <= 40 ? '#EF4444' : score <= 60 ? '#EAB308' : '#10B981'} fill={score <= 40 ? '#EF4444' : score <= 60 ? '#EAB308' : '#10B981'} fillOpacity={0.16} strokeWidth={2} /></AreaChart></ResponsiveContainer><span className="pointer-events-none absolute inset-0 flex items-center justify-center text-3xl font-semibold text-slate-900">{score}</span></div>
                  ) : (
                    <div className="relative mx-auto mt-1 h-[92px] w-[92px]"><ResponsiveContainer width="100%" height="100%"><RadialBarChart data={[{ value: score }]} startAngle={90} endAngle={-270} innerRadius="78%" outerRadius="100%" barSize={9}><PolarAngleAxis type="number" domain={[0, 100]} tick={false} /><RadialBar dataKey="value" background={{ fill: '#E2E8F0' }} cornerRadius={8} fill={band?.color} /></RadialBarChart></ResponsiveContainer><span className="pointer-events-none absolute inset-0 flex items-center justify-center text-2xl font-semibold text-slate-900">{score}</span></div>
                  )}
                  <p className={`mt-auto text-center text-xs font-semibold tracking-wide ${band?.text ?? 'text-slate-400'}`}>{band?.label ?? (metricTitle === 'Sentimiento' ? 'SENTIMIENTO GENERAL' : 'PUNTAJE SOBRE 100')}</p>
                </CardContent>
              </Card>
            )
          })}
        </section>

        <Tabs defaultValue="resumen" className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start bg-transparent p-0">
            <TabsTrigger value="resumen" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Resumen</TabsTrigger>
            <TabsTrigger value="transcripcion" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Transcripción</TabsTrigger>
            <TabsTrigger value="acuerdos" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Acuerdos</TabsTrigger>
            <TabsTrigger value="descargas" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Descargas</TabsTrigger>
            <TabsTrigger value="participantes" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Participantes</TabsTrigger>
          </TabsList>

          <TabsContent value="resumen" className="space-y-5">
            <Card>
              <CardHeader><CardTitle className="text-base">Resumen ejecutivo</CardTitle></CardHeader>
              <CardContent className="pt-0 text-sm leading-7 text-slate-600">
                {meeting.resumen_ejecutivo || <p className="text-slate-400">Resumen no disponible.</p>}
              </CardContent>
            </Card>

            {problems.length > 0 && (
              <section className="space-y-3">
                <h2 className="text-base font-semibold text-slate-900">Problemas identificados</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {problems.map((problem, index) => (
                    <Card key={`${problem.titulo ?? 'problema'}-${index}`}>
                      <CardContent className="p-5">
                        <div className="flex items-start justify-between gap-3">
                          <h3 className="font-medium text-slate-900">{problem.titulo || `Problema ${index + 1}`}</h3>
                          {problem.categoria && <Badge variant="secondary">{problem.categoria}</Badge>}
                        </div>
                        <p className="mt-2 text-sm leading-6 text-slate-600">{problem.descripcion || 'Sin descripción.'}</p>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </section>
            )}

            {keyPoints.length > 0 && (
              <Card>
                <CardHeader><CardTitle className="text-base">Puntos clave</CardTitle></CardHeader>
                <CardContent className="pt-0">
                  <ul className="list-disc space-y-2 pl-5 text-sm leading-6 text-slate-600">
                    {keyPoints.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}
                  </ul>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          <TabsContent value="transcripcion">
            <Card>
              <CardHeader><CardTitle className="text-base">Transcripción</CardTitle></CardHeader>
              <CardContent className="pt-0">
                {meeting.transcripcion ? (
                  <ScrollArea className="h-[min(60vh,640px)] rounded-md border bg-slate-50 p-4">
                    <p className="whitespace-pre-wrap text-sm leading-7 text-slate-700">{meeting.transcripcion}</p>
                  </ScrollArea>
                ) : (
                  <p className="rounded-md bg-slate-50 p-8 text-center text-sm text-slate-500">Transcripción no disponible</p>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="acuerdos">
            <Card>
              <CardHeader><CardTitle className="text-base">Acuerdos de la reunión</CardTitle></CardHeader>
              <CardContent className="pt-0">
                {agreementsQuery.isLoading ? (
                  <div className="space-y-2 py-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>
                ) : agreementsQuery.isError ? (
                  <p className="py-8 text-center text-sm text-red-600">No se pudieron cargar los acuerdos.</p>
                ) : (agreementsQuery.data ?? []).length === 0 ? (
                  <p className="py-8 text-center text-sm text-slate-500">Esta reunión todavía no tiene acuerdos.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-64">Descripción</TableHead>
                        <TableHead>Responsable</TableHead>
                        <TableHead>Fecha límite</TableHead>
                        <TableHead>Estado</TableHead>
                        <TableHead>Categoría</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(agreementsQuery.data ?? []).map((agreement) => (
                        <TableRow key={agreement.id}>
                          <TableCell className="max-w-md whitespace-normal font-medium text-slate-800">{agreement.descripcion}</TableCell>
                          <TableCell>{agreement.responsable || 'Sin asignar'}</TableCell>
                          <TableCell>{agreement.fecha_limite ? format(parseISO(agreement.fecha_limite), 'd MMM yyyy', { locale: es }) : '—'}</TableCell>
                          <TableCell>
                            <Select
                              value={agreement.estado}
                              onValueChange={(status: EstadoAcuerdo) => updateAgreement.mutate({ agreementId: agreement.id, status })}
                            >
                              <SelectTrigger className="w-36" aria-label={`Estado del acuerdo ${agreement.descripcion}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(Object.keys(agreementStatusLabels) as EstadoAcuerdo[]).map((status) => (
                                  <SelectItem key={status} value={status}>{agreementStatusLabels[status]}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>{agreement.categoria || '—'}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="descargas">
            <div className="grid gap-4 md:grid-cols-2">
              {([
                { type: 'word_resumen', title: 'Resumen Word', description: 'Resumen ejecutivo de la reuni?n', url: meeting.archivo_word_resumen_url },
                { type: 'word_mapa_conceptual', title: 'Mapa conceptual', description: 'Problemas, acuerdos y puntos clave', url: meeting.archivo_word_smartart_url },
              ] as const).map(({ type, title: documentTitle, description, url }) => {
                const isGenerating = generateDocument.isPending && generateDocument.variables === type
                return (
                  <Card key={type}>
                    <CardContent className="flex h-full flex-col justify-between gap-5 p-5">
                      <div><h2 className="font-medium text-slate-900">{documentTitle}</h2><p className="mt-1 text-sm text-slate-500">{description}</p></div>
                      {url ? (
                        <Button type="button" variant="outline" onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}><Download className="h-4 w-4" />Descargar</Button>
                      ) : (
                        <Button type="button" variant="outline" onClick={() => generateDocument.mutate(type)} disabled={generateDocument.isPending}>
                          {isGenerating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                          {isGenerating ? 'Generando?' : 'Generar'}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          </TabsContent>

          <TabsContent value="participantes">
            <Card>
              <CardHeader><CardTitle className="text-base">Participantes de la reunión</CardTitle></CardHeader>
              <CardContent className="pt-0">
                {participants.length ? (
                  <Table>
                    <TableHeader><TableRow><TableHead>Nombre</TableHead><TableHead>Email</TableHead><TableHead>Rol</TableHead></TableRow></TableHeader>
                    <TableBody>{participants.map((person, index) => <TableRow key={index}><TableCell className="font-medium">{person.nombre}</TableCell><TableCell>{person.email || '?'}</TableCell><TableCell>{person.rol || '?'}</TableCell></TableRow>)}</TableBody>
                  </Table>
                ) : <p className="py-8 text-center text-sm text-slate-500">A?n no hay participantes identificados.</p>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
      {processMeeting.isPending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-6" role="status" aria-live="polite">
          <Card className="w-full max-w-md shadow-xl">
            <CardContent className="flex flex-col items-center p-8 text-center">
              <LoaderCircle className="h-10 w-10 animate-spin text-indigo-600" />
              <h2 className="mt-4 text-lg font-semibold text-slate-900">Procesando reunión</h2>
              <p className="mt-2 text-sm text-slate-600">{meeting.progreso || 'Preparando el procesamiento...'}</p>
              <p className="mt-1 text-xs text-slate-400">Puede tardar varios minutos. No cierres esta página.</p>
            </CardContent>
          </Card>
        </div>
      )}
    </TooltipProvider>
  )
}

export default MeetingDetail
