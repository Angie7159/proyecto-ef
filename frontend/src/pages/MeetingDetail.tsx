import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, ArrowLeft, Download, FileSpreadsheet, FileText, LoaderCircle, RefreshCw } from 'lucide-react'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { supabase } from '@/lib/supabase'
import { getApiErrorMessage, procesarReunionCompleta } from '@/lib/api'
import { detenerBot, obtenerDiagnosticoBot, obtenerEstadoBot, obtenerUrlArchivoDiagnostico, reanalizarReunion } from '@/lib/bot'
import type { Acuerdo, Comite, EstadoAcuerdo, EstadoReunion, Reunion } from '@/types'

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
  const [diagnosticOpen, setDiagnosticOpen] = useState(false)

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
    refetchInterval: (query) => {
      const current = query.state.data
      if (current?.estado !== 'en_proceso') return false
      return current.progreso?.startsWith('bot_') ? 5000 : 2000
    },
  })

  const botIsRunning = meetingQuery.data?.estado === 'en_proceso'
    && Boolean(meetingQuery.data.progreso?.startsWith('bot_'))
  const botStatusQuery = useQuery({
    queryKey: ['bot-estado', id],
    enabled: Boolean(id) && botIsRunning,
    queryFn: () => obtenerEstadoBot(id!),
    refetchInterval: botIsRunning ? 5000 : false,
  })
  const botDiagnosticsQuery = useQuery({
    queryKey: ['bot-logs', id],
    enabled: Boolean(id) && diagnosticOpen,
    queryFn: () => obtenerDiagnosticoBot(id!),
    staleTime: 0,
  })

  const stopBotMutation = useMutation({
    mutationFn: () => {
      if (!id) throw new Error('No se encontró el identificador de la reunión.')
      return detenerBot(id)
    },
    onSuccess: (result) => toast.success(result.mensaje || 'Detención solicitada'),
    onError: (error: unknown) => toast.error(getApiErrorMessage(error)),
  })

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
      toast.success('Reunión procesada y documentos generados')
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
  const problems = (meeting.problemas_identificados ?? []) as ProblemaIdentificado[]
  const keyPoints = meeting.puntos_clave ?? []
  const committee = meeting.comites
  const esDelBot = meeting.fuente === 'bot_auto'
  const tieneAudio = Boolean(meeting.audio_url)
  const esManual = !esDelBot && tieneAudio
  const mostrarProcesar = esManual && ['en_proceso', 'error', 'pendiente_asignacion'].includes(meeting.estado)
  const mostrarReanalizar = esDelBot && meeting.estado === 'error' && Boolean(meeting.transcripcion?.trim())
  const botProgress = botStatusQuery.data?.progreso ?? meeting.progreso ?? ''
  const botProgressLabels: Record<string, string> = {
    bot_enviado: 'Enviando bot a Teams...',
    bot_unido: 'Bot unido a la reunión. Grabando...',
    bot_en_espera: 'Bot en sala de espera. Admítelo desde Teams.',
    bot_error: 'Error al unir el bot. Revisa los logs.',
  }
  const botElapsed = botStatusQuery.data?.tiempo_transcurrido_seg ?? 0
  const botElapsedLabel = `${Math.floor(botElapsed / 60)} min ${String(botElapsed % 60).padStart(2, '0')} s`
  const botCanStop = ['bot_enviado', 'bot_unido', 'bot_en_espera'].includes(botProgress)
  const botStoppedMessage = Boolean(meeting.error_mensaje && (
    meeting.error_mensaje.toLowerCase().includes('navegador fue cerrado')
    || meeting.error_mensaje.toLowerCase().includes('bot_detenido')
  ))
  const hasBotTranscript = meeting.fuente === 'bot_auto' && Boolean(meeting.transcripcion?.trim())
  const showSoftBotError = botStoppedMessage || hasBotTranscript
  const partialBotResult = meeting.fuente === 'bot_auto' && meeting.progreso === 'bot_procesada_parcial'

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-7xl space-y-6 p-6 md:p-8">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm text-slate-500">
          <Link to="/" className="shrink-0 hover:text-slate-900">Informes</Link>
          <span aria-hidden="true">/</span>
          <span className="truncate text-slate-700">{title}</span>
        </nav>

        <header className="flex flex-col gap-5 border-b border-slate-200 pb-6 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
            <p className="mt-2 text-sm text-slate-500">{dateDuration}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {committee && (
                <Badge className="border-transparent text-white" style={{ backgroundColor: committee.color }}>
                  {committee.nombre}
                </Badge>
              )}
              <Badge variant="outline" className={meetingStatusClasses[meeting.estado]}>
                {meetingStatusLabels[meeting.estado]}
              </Badge>
              {partialBotResult && <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">⚠️ Parcial</Badge>}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {mostrarProcesar && (
              <Button onClick={() => processMeeting.mutate()} disabled={processMeeting.isPending}>
                {processMeeting.isPending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                {processMeeting.isPending ? 'Procesando...' : '🔄 Procesar'}
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
            {meeting.estado === 'pendiente_asignacion' && (
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
                <DocumentDownloadButton label="Descargar Excel" icon={FileSpreadsheet} url={meeting.archivo_excel_url} />
                <DocumentDownloadButton label="Descargar Word" icon={FileText} url={meeting.archivo_word_resumen_url} />
              </>
            )}
          </div>
        </header>

        {meeting.error_mensaje && meeting.estado === 'error' && (
          <Card className={showSoftBotError ? 'border-amber-200 bg-amber-50' : 'border-red-200 bg-red-50'}>
            <CardContent className={`flex items-start gap-3 p-4 text-sm ${showSoftBotError ? 'text-amber-900' : 'text-red-800'}`}>
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">{botStoppedMessage
                  ? 'El bot fue detenido manualmente. Se guardó lo capturado hasta el momento.'
                  : hasBotTranscript
                    ? 'Se guardó la transcripción, pero el procesamiento quedó incompleto.'
                    : 'No se pudo procesar la reunión'}</p>
                {!botStoppedMessage && <p className="mt-1">{meeting.error_mensaje}</p>}
                {showSoftBotError && meeting.transcripcion && <p className="mt-1">La transcripción capturada está disponible en la pestaña Transcripción.</p>}
                {esDelBot && (
                  <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => setDiagnosticOpen(true)}>
                    Ver diagnóstico del bot
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        <Dialog open={diagnosticOpen} onOpenChange={setDiagnosticOpen}>
          <DialogContent className="max-h-[85vh] max-w-4xl overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Diagnóstico del bot</DialogTitle>
              <DialogDescription>Capturas de pantalla, HTML y subtítulos guardados durante el intento de ingreso.</DialogDescription>
            </DialogHeader>
            <div className="space-y-5">
              <section className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
                <h3 className="font-semibold">Error reportado</h3>
                <p className="mt-1 whitespace-pre-wrap">{meeting.error_mensaje || 'Sin mensaje de error.'}</p>
              </section>
              {botDiagnosticsQuery.isLoading && <p className="text-sm text-slate-500">Cargando archivos de diagnóstico...</p>}
              {botDiagnosticsQuery.isError && <p className="text-sm text-red-600">No se pudieron cargar los logs del bot.</p>}
              {botDiagnosticsQuery.data && (
                <>
                  <section className="space-y-3">
                    <h3 className="font-semibold text-slate-900">Screenshots ({botDiagnosticsQuery.data.screenshots.length})</h3>
                    {botDiagnosticsQuery.data.screenshots.length ? (
                      <div className="grid gap-4 md:grid-cols-2">
                        {botDiagnosticsQuery.data.screenshots.map((filename) => (
                          <a key={filename} href={obtenerUrlArchivoDiagnostico(meeting.id, filename)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-slate-50">
                            <img src={obtenerUrlArchivoDiagnostico(meeting.id, filename)} alt={`Captura ${filename}`} loading="lazy" className="w-full object-contain" />
                            <span className="block border-t px-3 py-2 text-xs text-slate-600">{filename}</span>
                          </a>
                        ))}
                      </div>
                    ) : <p className="text-sm text-slate-500">No hay screenshots guardados.</p>}
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-semibold text-slate-900">Páginas HTML</h3>
                    {botDiagnosticsQuery.data.pages.length ? botDiagnosticsQuery.data.pages.map((filename) => (
                      <a key={filename} href={obtenerUrlArchivoDiagnostico(meeting.id, filename)} target="_blank" rel="noreferrer" className="block text-sm text-indigo-700 underline">{filename}</a>
                    )) : <p className="text-sm text-slate-500">No hay páginas HTML guardadas.</p>}
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-semibold text-slate-900">Eventos de diagnóstico</h3>
                    {botDiagnosticsQuery.data.eventos
                      ? <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-slate-950 p-3 text-xs text-slate-100">{botDiagnosticsQuery.data.eventos}</pre>
                      : <p className="text-sm text-slate-500">No hay eventos de diagnóstico guardados.</p>}
                  </section>
                  <section className="space-y-2">
                    <h3 className="font-semibold text-slate-900">Subtítulos capturados ({botDiagnosticsQuery.data.subtitulos_capturados.length})</h3>
                    {botDiagnosticsQuery.data.subtitulos_capturados.length ? (
                      <pre className="max-h-56 overflow-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{JSON.stringify(botDiagnosticsQuery.data.subtitulos_capturados, null, 2)}</pre>
                    ) : <p className="text-sm text-slate-500">No se registraron subtítulos.</p>}
                  </section>
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>

        {botIsRunning && (
          <Card className="border-indigo-200 bg-indigo-50/70">
            <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-indigo-700">
                  <LoaderCircle className="h-5 w-5 animate-spin" />
                </div>
                <div>
                  <h2 className="font-semibold text-indigo-950">🤖 Bot en la reunión</h2>
                  <p className="mt-1 text-sm text-indigo-800">{botProgressLabels[botProgress] ?? 'Bot trabajando en la reunión...'}</p>
                  <p className="mt-1 text-xs text-indigo-700">Tiempo transcurrido: {botElapsedLabel} · Subtítulos capturados: {botStatusQuery.data?.subtitulos_capturados ?? 0}</p>
                </div>
              </div>
              {botCanStop && (
                <Button type="button" variant="outline" onClick={() => stopBotMutation.mutate()} disabled={stopBotMutation.isPending}>
                  {stopBotMutation.isPending && <LoaderCircle className="h-4 w-4 animate-spin" />}
                  {stopBotMutation.isPending ? 'Solicitando...' : 'Detener bot'}
                </Button>
              )}
            </CardContent>
          </Card>
        )}

        <Tabs defaultValue="resumen" className="space-y-4">
          <TabsList className="h-auto flex-wrap justify-start bg-transparent p-0">
            <TabsTrigger value="resumen" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Resumen</TabsTrigger>
            <TabsTrigger value="transcripcion" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Transcripción</TabsTrigger>
            <TabsTrigger value="acuerdos" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Acuerdos</TabsTrigger>
            <TabsTrigger value="descargas" className="rounded-none border-b-2 border-transparent px-4 py-2 data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">Descargas</TabsTrigger>
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
              <Card>
                <CardContent className="flex items-center justify-between gap-4 p-5">
                  <div><h2 className="font-medium text-slate-900">Informe Excel</h2><p className="mt-1 text-sm text-slate-500">Hoja de acuerdos y seguimiento</p></div>
                  <DocumentDownloadButton label="Descargar Excel" icon={Download} url={meeting.archivo_excel_url} />
                </CardContent>
              </Card>
              <Card>
                <CardContent className="flex items-center justify-between gap-4 p-5">
                  <div><h2 className="font-medium text-slate-900">Resumen Word</h2><p className="mt-1 text-sm text-slate-500">Documento de resumen de la reunión</p></div>
                  <DocumentDownloadButton label="Descargar Word" icon={Download} url={meeting.archivo_word_resumen_url} />
                </CardContent>
              </Card>
            </div>
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
