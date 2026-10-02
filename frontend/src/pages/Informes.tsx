import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { endOfMonth, endOfWeek, format, isThisMonth, parseISO, startOfDay } from 'date-fns'
import { es } from 'date-fns/locale'
import { AlertTriangle, Download, FileSpreadsheet, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { PageHeader } from '@/components/layout/PageHeader'
import { supabase } from '@/lib/supabase'
import type { Acuerdo, Comite, EstadoAcuerdo } from '@/types'

type CommitteeOption = Pick<Comite, 'id' | 'nombre' | 'color'>
type MeetingOption = { id: string; titulo_final: string }
type ReportData = { agreements: Acuerdo[]; committees: CommitteeOption[]; meetings: MeetingOption[] }
type DateFilter = 'todos' | 'vencidos' | 'semana' | 'mes'

const stateNames: Record<EstadoAcuerdo, string> = {
  pendiente: 'Pendiente',
  en_proceso: 'En proceso',
  cumplido: 'Cumplido',
  vencido: 'Vencido',
}
const stateStyles: Record<EstadoAcuerdo, string> = {
  pendiente: 'border-amber-200 bg-amber-50 text-amber-700',
  en_proceso: 'border-blue-200 bg-blue-50 text-blue-700',
  cumplido: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  vencido: 'border-red-200 bg-red-50 text-red-700',
}
const states = Object.keys(stateNames) as EstadoAcuerdo[]

function initials(value: string | null) {
  if (!value?.trim()) return '?'
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('')
}

function formatDeadline(value: string | null) {
  return value ? format(parseISO(value), 'dd/MM/yyyy', { locale: es }) : 'Sin fecha'
}

function isOverdue(agreement: Acuerdo, today: string) {
  return agreement.estado === 'vencido' || (
    agreement.estado !== 'cumplido' && Boolean(agreement.fecha_limite && agreement.fecha_limite < today)
  )
}

function downloadCsv(agreements: Acuerdo[], committeeMap: Map<string, CommitteeOption>, meetingMap: Map<string, MeetingOption>) {
  const columns = ['Comité', 'Descripción', 'Responsable', 'Fecha límite', 'Estado', 'Categoría', 'Reunión origen']
  const escapeCsv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
  const rows = agreements.map((agreement) => {
    const committee = committeeMap.get(agreement.comite_id)
    const meeting = meetingMap.get(agreement.reunion_origen_id ?? agreement.reunion_id)
    return [
      committee?.nombre ?? 'Sin comité',
      agreement.descripcion,
      agreement.responsable ?? 'Sin asignar',
      formatDeadline(agreement.fecha_limite),
      stateNames[agreement.estado],
      agreement.categoria ?? 'Otro',
      meeting?.titulo_final ?? '',
    ].map(escapeCsv).join(',')
  })
  const csv = `\uFEFF${[columns.map(escapeCsv).join(','), ...rows].join('\r\n')}`
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'seguimiento-acuerdos.csv'
  anchor.click()
  URL.revokeObjectURL(url)
}

function Informes() {
  const queryClient = useQueryClient()
  const [committeeFilter, setCommitteeFilter] = useState('todos')
  const [stateFilter, setStateFilter] = useState('todos')
  const [dueFilter, setDueFilter] = useState<DateFilter>('todos')
  const [search, setSearch] = useState('')
  const today = format(startOfDay(new Date()), 'yyyy-MM-dd')

  const reportQuery = useQuery({
    queryKey: ['informes-seguimiento'],
    queryFn: async (): Promise<ReportData> => {
      const [agreementsResult, committeesResult, meetingsResult] = await Promise.all([
        supabase.from('acuerdos').select('*'),
        supabase.from('comites').select('id, nombre, color').order('nombre'),
        supabase.from('reuniones').select('id, titulo_final'),
      ])
      if (agreementsResult.error) throw agreementsResult.error
      if (committeesResult.error) throw committeesResult.error
      if (meetingsResult.error) throw meetingsResult.error
      return {
        agreements: (agreementsResult.data ?? []) as Acuerdo[],
        committees: (committeesResult.data ?? []) as CommitteeOption[],
        meetings: (meetingsResult.data ?? []) as MeetingOption[],
      }
    },
  })

  const updateAgreement = useMutation({
    mutationFn: async ({ agreementId, estado }: { agreementId: string; estado: EstadoAcuerdo }) => {
      const { error } = await supabase.from('acuerdos').update({ estado }).eq('id', agreementId)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Estado del acuerdo actualizado')
      void queryClient.invalidateQueries({ queryKey: ['informes-seguimiento'] })
      void queryClient.invalidateQueries({ queryKey: ['acuerdos'] })
    },
    onError: () => toast.error('No se pudo actualizar el estado del acuerdo'),
  })

  const agreements = reportQuery.data?.agreements ?? []
  const committees = reportQuery.data?.committees ?? []
  const meetings = reportQuery.data?.meetings ?? []
  const committeeMap = useMemo(() => new Map(committees.map((committee) => [committee.id, committee])), [committees])
  const meetingMap = useMemo(() => new Map(meetings.map((meeting) => [meeting.id, meeting])), [meetings])

  const committeeScope = useMemo(() => (
    committeeFilter === 'todos'
      ? agreements
      : agreements.filter((agreement) => agreement.comite_id === committeeFilter)
  ), [agreements, committeeFilter])

  const filteredAgreements = useMemo(() => {
    const weekEnd = format(endOfWeek(new Date(), { weekStartsOn: 1 }), 'yyyy-MM-dd')
    const monthEnd = format(endOfMonth(new Date()), 'yyyy-MM-dd')
    const normalizedSearch = search.trim().toLocaleLowerCase('es')
    return committeeScope
      .filter((agreement) => stateFilter === 'todos' || agreement.estado === stateFilter)
      .filter((agreement) => {
        if (dueFilter === 'todos') return true
        if (dueFilter === 'vencidos') return isOverdue(agreement, today)
        if (!agreement.fecha_limite || agreement.fecha_limite < today) return false
        if (dueFilter === 'semana') return agreement.fecha_limite <= weekEnd
        return agreement.fecha_limite <= monthEnd
      })
      .filter((agreement) => !normalizedSearch || agreement.descripcion.toLocaleLowerCase('es').includes(normalizedSearch))
      .sort((a, b) => {
        const aOverdue = isOverdue(a, today)
        const bOverdue = isOverdue(b, today)
        if (aOverdue !== bOverdue) return aOverdue ? -1 : 1
        if (!a.fecha_limite) return b.fecha_limite ? 1 : 0
        if (!b.fecha_limite) return -1
        return a.fecha_limite.localeCompare(b.fecha_limite)
      })
  }, [committeeScope, dueFilter, search, stateFilter, today])

  const groups = useMemo(() => {
    const groupMap = new Map<string, Acuerdo[]>()
    filteredAgreements.forEach((agreement) => {
      const key = agreement.comite_id || 'sin-comite'
      const items = groupMap.get(key) ?? []
      items.push(agreement)
      groupMap.set(key, items)
    })
    return [...groupMap.entries()].map(([id, items]) => ({
      id,
      committee: committeeMap.get(id) ?? { id, nombre: 'Sin comité', color: '#64748B' },
      agreements: items,
      pending: items.filter((item) => item.estado === 'pendiente').length,
    })).sort((a, b) => a.committee.nombre.localeCompare(b.committee.nombre, 'es'))
  }, [committeeMap, filteredAgreements])

  const overdueCount = committeeScope.filter((agreement) => isOverdue(agreement, today)).length
  const kpis = [
    { label: 'Total acuerdos', value: committeeScope.length, style: 'text-slate-900' },
    { label: 'Pendientes', value: committeeScope.filter((agreement) => agreement.estado === 'pendiente').length, style: 'text-amber-700' },
    { label: 'Vencidos', value: overdueCount, style: overdueCount ? 'text-red-600' : 'text-slate-900' },
    { label: 'Cumplidos este mes', value: committeeScope.filter((agreement) => agreement.estado === 'cumplido' && agreement.updated_at && isThisMonth(parseISO(agreement.updated_at))).length, style: 'text-emerald-700' },
  ]

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-7xl space-y-6 p-6 md:p-8">
        <PageHeader
          title="Informes"
          subtitle="Seguimiento de acuerdos por comité"
          actions={(
            <div className="flex flex-wrap gap-2">
              <Tooltip>
                <TooltipTrigger asChild><span tabIndex={0}><Button variant="outline" disabled><FileSpreadsheet /> Exportar a Excel</Button></span></TooltipTrigger>
                <TooltipContent>Próximamente</TooltipContent>
              </Tooltip>
              <Button variant="outline" onClick={() => downloadCsv(filteredAgreements, committeeMap, meetingMap)} disabled={reportQuery.isLoading || filteredAgreements.length === 0}>
                <Download /> Descargar CSV
              </Button>
            </div>
          )}
        />

        <div className="grid gap-4 md:grid-cols-[minmax(240px,1fr)_2fr]">
          <div className="space-y-2">
            <label htmlFor="committee-filter" className="text-sm font-medium text-slate-700">Comité</label>
            <Select value={committeeFilter} onValueChange={setCommitteeFilter}>
              <SelectTrigger id="committee-filter" aria-label="Filtrar por comité"><SelectValue placeholder="Selecciona un comité" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los comités</SelectItem>
                {committees.map((committee) => <SelectItem key={committee.id} value={committee.id}>{committee.nombre}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>

        <section aria-label="Indicadores de acuerdos" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {kpis.map((kpi) => (
            <Card key={kpi.label}>
              <CardContent className="p-5">
                {reportQuery.isLoading ? <Skeleton className="h-8 w-20" /> : <p className={`text-3xl font-semibold tracking-tight ${kpi.style}`}>{kpi.value.toLocaleString('es-PE')}</p>}
                <p className="mt-1 text-sm text-slate-500">{kpi.label}</p>
              </CardContent>
            </Card>
          ))}
        </section>

        <Card>
          <CardContent className="grid grid-cols-1 gap-3 p-4 md:grid-cols-3">
            <Select value={stateFilter} onValueChange={setStateFilter}>
              <SelectTrigger aria-label="Filtrar por estado"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los estados</SelectItem>
                {states.map((state) => <SelectItem key={state} value={state}>{stateNames[state]}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={dueFilter} onValueChange={(value: DateFilter) => setDueFilter(value)}>
              <SelectTrigger aria-label="Filtrar por vencimiento"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="todos">Todos los vencimientos</SelectItem>
                <SelectItem value="vencidos">Vencidos</SelectItem>
                <SelectItem value="semana">Esta semana</SelectItem>
                <SelectItem value="mes">Este mes</SelectItem>
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar por descripción" aria-label="Buscar por descripción" className="pl-9" />
            </div>
          </CardContent>
        </Card>

        {reportQuery.isError ? (
          <Card className="border-red-200"><CardContent className="p-8 text-center text-sm text-red-700">No se pudieron cargar los acuerdos y comités.</CardContent></Card>
        ) : reportQuery.isLoading ? (
          <div className="space-y-4" aria-label="Cargando seguimiento">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-56 w-full rounded-xl" />)}</div>
        ) : groups.length === 0 ? (
          <Card><CardContent className="p-10 text-center text-sm text-slate-500">No hay acuerdos que coincidan con los filtros seleccionados.</CardContent></Card>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <Card key={group.id}>
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 border-b border-slate-100">
                  <div className="flex min-w-0 items-center gap-3">
                    <Badge className="max-w-64 truncate border-transparent text-white" style={{ backgroundColor: group.committee.color }}>{group.committee.nombre}</Badge>
                    <CardTitle className="truncate text-sm font-medium text-slate-500">{group.agreements.length} acuerdos</CardTitle>
                  </div>
                  <Badge variant="outline" className="shrink-0 border-amber-200 bg-amber-50 text-amber-700">{group.pending} pendientes</Badge>
                </CardHeader>
                <CardContent className="p-0">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="min-w-64">Descripción</TableHead>
                        <TableHead className="min-w-40">Responsable</TableHead>
                        <TableHead className="min-w-32">Fecha límite</TableHead>
                        <TableHead className="min-w-40">Estado</TableHead>
                        <TableHead className="min-w-48">Reunión origen</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.agreements.map((agreement) => {
                        const overdue = isOverdue(agreement, today)
                        const sourceId = agreement.reunion_origen_id ?? agreement.reunion_id
                        const sourceMeeting = meetingMap.get(sourceId)
                        const isUpdating = updateAgreement.isPending && updateAgreement.variables?.agreementId === agreement.id
                        return (
                          <TableRow key={agreement.id}>
                            <TableCell className="max-w-xl whitespace-normal font-medium text-slate-800">{agreement.descripcion}</TableCell>
                            <TableCell>
                              <span className="inline-flex items-center gap-2">
                                <Avatar className="h-7 w-7"><AvatarFallback className="bg-slate-100 text-[10px] font-semibold text-slate-700">{initials(agreement.responsable)}</AvatarFallback></Avatar>
                                <span className="max-w-40 truncate">{agreement.responsable || 'Sin asignar'}</span>
                              </span>
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className={overdue ? 'border-red-200 bg-red-50 text-red-700' : 'border-slate-200 bg-white text-slate-600'}>
                                {overdue && <AlertTriangle className="mr-1 h-3 w-3" />}{formatDeadline(agreement.fecha_limite)}
                              </Badge>
                            </TableCell>
                            <TableCell>
                              <Select value={agreement.estado} disabled={isUpdating} onValueChange={(estado: EstadoAcuerdo) => updateAgreement.mutate({ agreementId: agreement.id, estado })}>
                                <SelectTrigger aria-label={`Estado del acuerdo ${agreement.descripcion}`} className={`h-8 w-36 ${stateStyles[agreement.estado]}`}><SelectValue /></SelectTrigger>
                                <SelectContent>{states.map((state) => <SelectItem key={state} value={state}>{stateNames[state]}</SelectItem>)}</SelectContent>
                              </Select>
                            </TableCell>
                            <TableCell>
                              <Link to={`/reuniones/${sourceId}`} className="inline-flex max-w-52 items-center gap-1 truncate text-sm text-indigo-600 hover:text-indigo-800 hover:underline">
                                {sourceMeeting?.titulo_final ?? 'Ver reunión'}
                              </Link>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}

export default Informes
