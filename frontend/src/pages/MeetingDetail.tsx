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
    refetchInterval: (query) => query.state.data?.estado === 'en_proceso' ? 2000 : false,
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

  useEffect(() => {
    if (!processMeeting.isPending) return
    const intervalId = window.setInterval(() => {
      void meetingQuery.refetch()
    }, 2000)
    return () => window.clearInterval(intervalId)
  }, [meetingQuery.refetch, processMeeting.isPending])

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
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {(meeting.estado === 'en_proceso' || meeting.estado === 'error') && (
              <Button onClick={() => processMeeting.mutate()} disabled={processMeeting.isPending}>
                {processMeeting.isPending
                  ? <LoaderCircle className="h-4 w-4 animate-spin" />
                  : <RefreshCw className="h-4 w-4" />}
                {processMeeting.isPending ? 'Procesando...' : '🔄 Procesar'}
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
          <Card className="border-red-200 bg-red-50">
            <CardContent className="flex items-start gap-3 p-4 text-sm text-red-800">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div><p className="font-medium">No se pudo procesar la reunión</p><p className="mt-1">{meeting.error_mensaje}</p></div>
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
