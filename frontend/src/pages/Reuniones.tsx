import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle,
  Calendar,
  CheckCircle,
  Clock,
  Download,
  MoreHorizontal,
  Search,
  Trash2,
  Video,
  Mic,
  Upload,
  Users,
} from 'lucide-react'
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isThisWeek,
  isToday,
  parse,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns'
import { es } from 'date-fns/locale'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { supabase } from '@/lib/supabase'
import type { Comite, EstadoReunion, ReunionListItem } from '@/types'

type DateRange = 'todos' | 'hoy' | 'semana' | 'mes'
type DashboardFilters = {
  search: string
  comiteId: string
  estado: string
  rango: DateRange
}

const defaultFilters: DashboardFilters = {
  search: '',
  comiteId: 'todos',
  estado: 'todos',
  rango: 'todos',
}

const statusLabels: Record<EstadoReunion, string> = {
  pendiente_asignacion: 'Pendiente',
  procesada: 'Procesada',
  en_proceso: 'En proceso',
  error: 'Error',
}

const statusStyles: Record<EstadoReunion, string> = {
  pendiente_asignacion: 'border-amber-200 bg-amber-50 text-amber-700',
  procesada: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  en_proceso: 'border-blue-200 bg-blue-50 text-blue-700',
  error: 'border-red-200 bg-red-50 text-red-700',
}

function parseMeetingDate(value: string) {
  return parseISO(value)
}

function formatMeetingTime(value: string | null) {
  if (!value) return null
  const parsed = parse(value, value.length > 5 ? 'HH:mm:ss' : 'HH:mm', new Date())
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 5) : format(parsed, 'H:mm')
}

function MeetingSourceIcon({ source }: { source: ReunionListItem['fuente'] }) {
  const Icon = source.startsWith('teams_') || source === 'zoom'
    ? Video
    : source === 'presencial'
      ? Mic
      : Upload
  return <Icon aria-hidden="true" className="h-4 w-4 text-slate-500" />
}

function dateRangeBounds(range: DateRange, now: Date) {
  if (range === 'hoy') return { from: startOfDay(now), to: endOfDay(now) }
  if (range === 'semana') {
    return {
      from: startOfWeek(now, { weekStartsOn: 1 }),
      to: endOfWeek(now, { weekStartsOn: 1 }),
    }
  }
  if (range === 'mes') return { from: startOfMonth(now), to: endOfMonth(now) }
  return null
}

function downloadMeetingSummary(meeting: ReunionListItem) {
  const content = [
    meeting.titulo,
    `Fecha: ${format(parseMeetingDate(meeting.fecha), 'd MMMM yyyy', { locale: es })}`,
    `Comité: ${meeting.comite_nombre ?? 'Sin comité'}`,
    `Estado: ${statusLabels[meeting.estado]}`,
    meeting.resumen_corto ?? '',
  ].filter(Boolean).join('\n\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `${meeting.titulo || 'reunion'}.txt`.replace(/[\\/:*?"<>|]/g, '-')
  anchor.click()
  URL.revokeObjectURL(url)
}

function Reuniones() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const queryClient = useQueryClient()
  const [filters, setFilters] = useState<DashboardFilters>(() => ({
    ...defaultFilters,
    comiteId: searchParams.get('comite') || 'todos',
  }))
  const [now] = useState(() => new Date())

  useEffect(() => {
    const committeeId = searchParams.get('comite') || 'todos'
    setFilters((current) => current.comiteId === committeeId ? current : { ...current, comiteId: committeeId })
  }, [searchParams])

  const { data: committees = [] } = useQuery({
    queryKey: ['comites'],
    queryFn: async () => {
      const { data, error } = await supabase.from('comites').select('*').order('nombre')
      if (error) throw error
      return (data ?? []) as Comite[]
    },
  })

  const {
    data: meetings = [],
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['reuniones', filters],
    queryFn: async () => {
      let query = supabase
        .from('vista_dashboard_reuniones')
        .select('*')
        .order('fecha', { ascending: false })

      const search = filters.search.trim()
      if (search) query = query.ilike('titulo', `%${search}%`)
      if (filters.comiteId !== 'todos') query = query.eq('comite_id', filters.comiteId)
      if (filters.estado !== 'todos') query = query.eq('estado', filters.estado)
      const bounds = dateRangeBounds(filters.rango, now)
      if (bounds) {
        query = query
          .gte('fecha', format(bounds.from, 'yyyy-MM-dd'))
          .lte('fecha', format(bounds.to, 'yyyy-MM-dd'))
      }

      const { data, error } = await query
      if (error) throw error
      return (data ?? []) as ReunionListItem[]
    },
    refetchInterval: (query) => query.state.data?.some((meeting) => meeting.estado === 'en_proceso') ? 5000 : false,
  })

  const meetingIds = meetings.map((meeting) => meeting.id)
  const pendingAgreementsQuery = useQuery({
    queryKey: ['acuerdos-pendientes-dashboard', meetingIds],
    enabled: !isLoading && !isError,
    queryFn: async () => {
      if (meetingIds.length === 0) return 0
      const { count, error } = await supabase
        .from('acuerdos')
        .select('id', { count: 'exact', head: true })
        .in('reunion_id', meetingIds)
        .eq('estado', 'pendiente')
      if (error) throw error
      return count ?? 0
    },
  })

  const deleteMeeting = useMutation({
    mutationFn: async (meeting: ReunionListItem) => {
      const { error } = await supabase.from('reuniones').delete().eq('id', meeting.id)
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Reunión eliminada')
      void queryClient.invalidateQueries({ queryKey: ['reuniones'] })
    },
    onError: () => toast.error('No se pudo eliminar la reunión'),
  })

  const groupedMeetings = useMemo(() => {
    const groups: Record<'HOY' | 'ESTA SEMANA' | 'ANTERIORES', ReunionListItem[]> = {
      HOY: [],
      'ESTA SEMANA': [],
      ANTERIORES: [],
    }

    meetings.forEach((meeting) => {
      const date = parseMeetingDate(meeting.fecha)
      if (isToday(date)) groups.HOY.push(meeting)
      else if (isThisWeek(date, { weekStartsOn: 1 })) groups['ESTA SEMANA'].push(meeting)
      else groups.ANTERIORES.push(meeting)
    })
    return groups
  }, [meetings])

  const kpis = [
    { label: 'Reuniones totales', value: meetings.length, icon: Calendar, iconClass: 'text-indigo-600 bg-indigo-50' },
    { label: 'Pendientes', value: meetings.filter((meeting) => meeting.estado === 'pendiente_asignacion').length, icon: Clock, iconClass: 'text-amber-600 bg-amber-50' },
    { label: 'Procesadas', value: meetings.filter((meeting) => meeting.estado === 'procesada').length, icon: CheckCircle, iconClass: 'text-emerald-600 bg-emerald-50' },
    { label: 'Acuerdos pendientes', value: pendingAgreementsQuery.data ?? 0, icon: AlertCircle, iconClass: 'text-rose-600 bg-rose-50' },
  ]

  function updateFilter<Key extends keyof DashboardFilters>(key: Key, value: DashboardFilters[Key]) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function confirmDelete(meeting: ReunionListItem) {
    if (window.confirm(`¿Eliminar la reunión “${meeting.titulo}”? Esta acción no se puede deshacer.`)) {
      deleteMeeting.mutate(meeting)
    }
  }

  function renderMeeting(meeting: ReunionListItem) {
    const date = parseMeetingDate(meeting.fecha)
    const start = formatMeetingTime(meeting.hora_inicio)
    const finish = formatMeetingTime(meeting.hora_fin)
    const dateLabel = format(date, 'EEE, d MMM', { locale: es }).replace('.', '')

    return (
      <Card
        key={meeting.id}
        role="link"
        tabIndex={0}
        aria-label={`Ver reunión ${meeting.titulo}`}
        onClick={() => navigate(`/reuniones/${meeting.id}`)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            navigate(`/reuniones/${meeting.id}`)
          }
        }}
        className="group cursor-pointer border-slate-200 shadow-sm transition hover:border-slate-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <CardContent className="flex flex-col gap-4 p-4 md:flex-row md:items-center">
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100">
              <MeetingSourceIcon source={meeting.fuente} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-slate-900">{meeting.titulo}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                <Users aria-hidden="true" className="h-3.5 w-3.5" />
                {meeting.participantes ?? 0} participantes
                <span aria-hidden="true">·</span>
                {meeting.duracion_min ?? 0} min
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 md:ml-auto md:justify-end">
            {meeting.comite_nombre && (
              <Badge
                className="max-w-40 truncate border-transparent text-white hover:opacity-90"
                style={{ backgroundColor: meeting.comite_color ?? '#64748b' }}
              >
                {meeting.comite_nombre}
              </Badge>
            )}
            <span className="min-w-32 text-xs text-slate-500">
              {dateLabel}{start ? ` · ${start}${finish ? ` - ${finish}` : ''}` : ''}
            </span>
            <Badge variant="outline" className={statusStyles[meeting.estado]}>
              {meeting.estado === 'en_proceso' ? (
                <span className="inline-flex items-center gap-1.5 animate-pulse">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" /> Procesando...
                </span>
              ) : statusLabels[meeting.estado]}
            </Badge>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Acciones para ${meeting.titulo}`}
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                  className="h-8 w-8"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem onSelect={() => navigate(`/reuniones/${meeting.id}`)}>
                  Ver
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => downloadMeetingSummary(meeting)}>
                  <Download className="mr-2 h-4 w-4" /> Descargar
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-red-600 focus:text-red-600"
                  onSelect={() => confirmDelete(meeting)}
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Eliminar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7 p-6 md:p-8">
      <PageHeader
        title="Reuniones"
        actions={(
          <Button asChild>
            <Link to="/subir"><Upload className="h-4 w-4" /> Subir reunión</Link>
          </Button>
        )}
      />

      <section aria-label="Indicadores de reuniones" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {kpis.map(({ label, value, icon: Icon, iconClass }) => (
          <Card key={label} className="min-w-0">
            <CardContent className="p-5">
              <div className={`mb-4 flex h-9 w-9 items-center justify-center rounded-lg ${iconClass}`}>
                <Icon aria-hidden="true" className="h-5 w-5" />
              </div>
              {(isLoading || (label === 'Acuerdos pendientes' && pendingAgreementsQuery.isLoading)) ? (
                <Skeleton className="h-8 w-16" />
              ) : (
                <p className="text-2xl font-semibold tracking-tight text-slate-900">
                  {isError || (label === 'Acuerdos pendientes' && pendingAgreementsQuery.isError) ? '—' : value}
                </p>
              )}
              <p className="mt-1 block w-full min-w-[130px] whitespace-nowrap text-sm leading-5 text-slate-500">{label}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <Card>
        <CardContent className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="relative">
            <Search aria-hidden="true" className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              value={filters.search}
              onChange={(event) => updateFilter('search', event.target.value)}
              placeholder="Buscar por título"
              aria-label="Buscar por título"
              className="pl-9"
            />
          </div>
          <Select value={filters.comiteId} onValueChange={(value) => updateFilter('comiteId', value)}>
            <SelectTrigger aria-label="Filtrar por comité"><SelectValue placeholder="Comités" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos los comités</SelectItem>
              {committees.map((committee) => <SelectItem key={committee.id} value={committee.id}>{committee.nombre}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={filters.estado} onValueChange={(value) => updateFilter('estado', value)}>
            <SelectTrigger aria-label="Filtrar por estado"><SelectValue placeholder="Estado" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos los estados</SelectItem>
              <SelectItem value="pendiente_asignacion">Pendiente</SelectItem>
              <SelectItem value="procesada">Procesada</SelectItem>
              <SelectItem value="en_proceso">En proceso</SelectItem>
              <SelectItem value="error">Error</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.rango} onValueChange={(value: DateRange) => updateFilter('rango', value)}>
            <SelectTrigger aria-label="Filtrar por rango de fechas"><SelectValue placeholder="Rango de fechas" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todas las fechas</SelectItem>
              <SelectItem value="hoy">Hoy</SelectItem>
              <SelectItem value="semana">Esta semana</SelectItem>
              <SelectItem value="mes">Este mes</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {isLoading ? (
        <div className="space-y-2" aria-label="Cargando reuniones">
          {Array.from({ length: 5 }, (_, index) => (
            <Skeleton key={index} className="h-20 w-full rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <Card><CardContent className="p-8 text-center text-sm text-red-600">
          No se pudieron cargar las reuniones{error instanceof Error ? `: ${error.message}` : '.'}
        </CardContent></Card>
      ) : meetings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center px-6 py-14 text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
              <Calendar aria-hidden="true" className="h-7 w-7" />
            </div>
            <h2 className="text-lg font-semibold text-slate-900">Aún no hay reuniones</h2>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Sube una reunión para generar su informe y dar seguimiento a los acuerdos.</p>
            <Button asChild className="mt-5"><Link to="/subir"><Upload className="h-4 w-4" /> Subir primera reunión</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {(Object.entries(groupedMeetings) as [keyof typeof groupedMeetings, ReunionListItem[]][]).map(([group, entries]) => entries.length > 0 && (
            <section key={group} aria-label={group}>
              <h2 className="mb-3 text-xs font-semibold tracking-wide text-slate-500">{group}</h2>
              <div className="space-y-2">{entries.map(renderMeeting)}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

export default Reuniones
