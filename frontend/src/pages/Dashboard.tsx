import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  addMonths,
  format,
  isSameMonth,
  parseISO,
  startOfMonth,
  subMonths,
} from 'date-fns'
import { es } from 'date-fns/locale'
import { AlertCircle, ArrowDownRight, ArrowUpRight, Calendar, TrendingUp, Users } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PageHeader } from '@/components/layout/PageHeader'
import { supabase } from '@/lib/supabase'
import type { Comite, EstadoAcuerdo, ReunionListItem } from '@/types'

type ParticipantMeeting = { id: string; participantes_lista: unknown }
type AgreementRow = { id: string; estado: EstadoAcuerdo; created_at: string }
type MonthlyCount = { month: string; reuniones: number }
type CommitteeStat = { id: string; nombre: string; color: string; reuniones: number; duracion: number }

const agreementStates: { key: EstadoAcuerdo; label: string; color: string }[] = [
  { key: 'pendiente', label: 'Pendiente', color: '#EAB308' },
  { key: 'en_proceso', label: 'En Proceso', color: '#3B82F6' },
  { key: 'cumplido', label: 'Cumplido', color: '#22C55E' },
  { key: 'vencido', label: 'Vencido', color: '#EF4444' },
]

function percentageChange(current: number, previous: number) {
  if (previous === 0) return current === 0 ? 0 : 100
  return Math.round(((current - previous) / previous) * 100)
}

function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?'
}

function getParticipantName(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  const name = item.nombre ?? item.name ?? item.full_name ?? item.email
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

function Dashboard() {
  const now = new Date()
  const currentMonth = startOfMonth(now)
  const previousMonth = subMonths(currentMonth, 1)

  const meetingsQuery = useQuery({
    queryKey: ['dashboard-analytics', 'reuniones'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('vista_dashboard_reuniones')
        .select('*')
        .order('fecha', { ascending: false })
      if (error) throw error
      return (data ?? []) as ReunionListItem[]
    },
  })

  const agreementsQuery = useQuery({
    queryKey: ['dashboard-analytics', 'acuerdos'],
    queryFn: async () => {
      const { data, error } = await supabase.from('acuerdos').select('id, estado, created_at')
      if (error) throw error
      return (data ?? []) as AgreementRow[]
    },
  })

  const committeesQuery = useQuery({
    queryKey: ['dashboard-analytics', 'comites'],
    queryFn: async () => {
      const { data, error } = await supabase.from('comites').select('*')
      if (error) throw error
      return (data ?? []) as Comite[]
    },
  })

  const participantsQuery = useQuery({
    queryKey: ['dashboard-analytics', 'participantes'],
    queryFn: async () => {
      const { data, error } = await supabase.from('reuniones').select('id, participantes_lista')
      if (error) throw error
      return (data ?? []) as ParticipantMeeting[]
    },
  })

  const meetings = meetingsQuery.data ?? []
  const agreements = agreementsQuery.data ?? []
  const committees = committeesQuery.data ?? []
  const participantMeetings = participantsQuery.data ?? []

  const monthlyMeetings = useMemo<MonthlyCount[]>(() => {
    return Array.from({ length: 6 }, (_, index) => {
      const monthStart = addMonths(currentMonth, index - 5)
      const monthEnd = addMonths(monthStart, 1)
      return {
        month: format(monthStart, 'MMM', { locale: es }).replace(/^./, (letter) => letter.toUpperCase()),
        reuniones: meetings.filter((meeting) => {
          const date = parseISO(meeting.fecha)
          return date >= monthStart && date < monthEnd
        }).length,
      }
    })
  }, [currentMonth, meetings])

  const committeeStats = useMemo<CommitteeStat[]>(() => {
    const stats = new Map<string, CommitteeStat>()
    committees.forEach((committee) => {
      stats.set(committee.id, {
        id: committee.id,
        nombre: committee.nombre,
        color: committee.color || '#64748B',
        reuniones: 0,
        duracion: 0,
      })
    })
    meetings.forEach((meeting) => {
      const key = meeting.comite_id ?? 'sin-comite'
      const current = stats.get(key) ?? {
        id: key,
        nombre: meeting.comite_nombre ?? 'Sin comité',
        color: meeting.comite_color ?? '#94A3B8',
        reuniones: 0,
        duracion: 0,
      }
      current.reuniones += 1
      current.duracion += meeting.duracion_min ?? 0
      stats.set(key, current)
    })
    return [...stats.values()]
      .map((item) => ({ ...item, duracion: item.reuniones ? Math.round(item.duracion / item.reuniones) : 0 }))
      .filter((item) => item.reuniones > 0)
      .sort((a, b) => b.reuniones - a.reuniones)
  }, [committees, meetings])

  const agreementsByState = useMemo(() => agreementStates.map((state) => ({
    estado: state.label,
    cantidad: agreements.filter((agreement) => agreement.estado === state.key).length,
    color: state.color,
  })), [agreements])

  const topParticipants = useMemo(() => {
    const counts = new Map<string, Set<string>>()
    participantMeetings.forEach((meeting) => {
      const attendees = Array.isArray(meeting.participantes_lista) ? meeting.participantes_lista : []
      attendees.forEach((attendee) => {
        const name = getParticipantName(attendee)
        if (!name) return
        const meetingIds = counts.get(name) ?? new Set<string>()
        meetingIds.add(meeting.id)
        counts.set(name, meetingIds)
      })
    })
    return [...counts.entries()]
      .map(([name, meetingIds]) => ({ name, reuniones: meetingIds.size }))
      .sort((a, b) => b.reuniones - a.reuniones || a.name.localeCompare(b.name))
      .slice(0, 5)
  }, [participantMeetings])

  const currentMonthMeetings = meetings.filter((meeting) => isSameMonth(parseISO(meeting.fecha), currentMonth)).length
  const previousMonthMeetings = meetings.filter((meeting) => isSameMonth(parseISO(meeting.fecha), previousMonth)).length
  const currentMonthPending = agreements.filter((agreement) =>
    agreement.estado === 'pendiente' && agreement.created_at && isSameMonth(parseISO(agreement.created_at), currentMonth),
  ).length
  const previousMonthPending = agreements.filter((agreement) =>
    agreement.estado === 'pendiente' && agreement.created_at && isSameMonth(parseISO(agreement.created_at), previousMonth),
  ).length
  const currentMonthCommittees = committees.filter((committee) => committee.created_at && isSameMonth(parseISO(committee.created_at), currentMonth)).length
  const previousMonthCommittees = committees.filter((committee) => committee.created_at && isSameMonth(parseISO(committee.created_at), previousMonth)).length
  const pendingTotal = agreements.filter((agreement) => agreement.estado === 'pendiente').length

  const metrics = [
    { label: 'Total de reuniones', value: meetings.length, change: percentageChange(currentMonthMeetings, previousMonthMeetings), icon: Calendar, color: 'bg-indigo-50 text-indigo-600' },
    { label: 'Reuniones este mes', value: currentMonthMeetings, change: percentageChange(currentMonthMeetings, previousMonthMeetings), icon: TrendingUp, color: 'bg-emerald-50 text-emerald-600' },
    { label: 'Acuerdos pendientes', value: pendingTotal, change: percentageChange(currentMonthPending, previousMonthPending), icon: AlertCircle, color: 'bg-amber-50 text-amber-600' },
    { label: 'Comités activos', value: committees.filter((committee) => committee.activo).length, change: percentageChange(currentMonthCommittees, previousMonthCommittees), icon: Users, color: 'bg-sky-50 text-sky-600' },
  ]

  const isLoading = meetingsQuery.isLoading || agreementsQuery.isLoading || committeesQuery.isLoading || participantsQuery.isLoading
  const isError = meetingsQuery.isError || agreementsQuery.isError || committeesQuery.isError || participantsQuery.isError

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7 p-6 md:p-8">
      <PageHeader title="Dashboard" subtitle="Análisis del sistema" />

      {isError && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-700">No se pudieron cargar todos los datos de analítica. Revisa el acceso a las tablas y vuelve a intentar.</CardContent>
        </Card>
      )}

      <section aria-label="Indicadores del sistema" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map(({ label, value, change, icon: Icon, color }) => {
          const isPositive = change >= 0
          const ChangeIcon = isPositive ? ArrowUpRight : ArrowDownRight
          return (
            <Card key={label}>
              <CardContent className="p-5">
                {isLoading ? <Skeleton className="mb-4 h-10 w-10 rounded-lg" /> : (
                  <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-lg ${color}`}><Icon className="h-5 w-5" /></div>
                )}
                {isLoading ? <Skeleton className="h-9 w-24" /> : <p className="text-3xl font-semibold tracking-tight text-slate-950">{value.toLocaleString('es-PE')}</p>}
                {isLoading ? <Skeleton className="mt-2 h-4 w-32" /> : <p className="mt-1 text-sm text-slate-500">{label}</p>}
                {isLoading ? <Skeleton className="mt-3 h-4 w-28" /> : (
                  <p className={`mt-3 inline-flex items-center gap-1 text-xs font-medium ${isPositive ? 'text-emerald-600' : 'text-rose-600'}`}>
                    <ChangeIcon className="h-3.5 w-3.5" /> {change > 0 ? '+' : ''}{change}% <span className="font-normal text-slate-400">vs mes anterior</span>
                  </p>
                )}
              </CardContent>
            </Card>
          )
        })}
      </section>

      <section aria-label="Gráficos de analítica" className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Card className="lg:col-span-7">
          <CardHeader><CardTitle className="text-base">Reuniones por mes</CardTitle></CardHeader>
          <CardContent className="h-[300px]">
            {isLoading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={monthlyMeetings} margin={{ top: 8, right: 12, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 12 }} />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 12 }} />
                  <Tooltip contentStyle={{ borderRadius: 12, borderColor: '#E2E8F0' }} />
                  <Line type="monotone" dataKey="reuniones" name="Reuniones" stroke="#4F46E5" strokeWidth={3} dot={{ r: 4, fill: '#4F46E5' }} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-5">
          <CardHeader><CardTitle className="text-base">Distribución por comité</CardTitle></CardHeader>
          <CardContent className="flex h-[300px] items-center gap-2">
            {isLoading ? <Skeleton className="h-full w-full" /> : committeeStats.length === 0 ? (
              <p className="w-full text-center text-sm text-slate-400">Aún no hay reuniones por comité.</p>
            ) : (
              <>
                <div className="h-full min-w-0 flex-1">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={committeeStats} dataKey="reuniones" nameKey="nombre" innerRadius="48%" outerRadius="78%" paddingAngle={2}>
                        {committeeStats.map((entry) => <Cell key={entry.id} fill={entry.color} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="max-h-full w-[44%] space-y-3 overflow-y-auto text-xs">
                  {committeeStats.map((entry) => (
                    <li key={entry.id} className="flex items-start gap-2 text-slate-600">
                      <span className="mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
                      <span className="min-w-0 flex-1"><span className="block truncate">{entry.nombre}</span><span className="text-slate-400">{entry.reuniones} reuniones</span></span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-6">
          <CardHeader><CardTitle className="text-base">Acuerdos por estado</CardTitle></CardHeader>
          <CardContent className="h-[300px]">
            {isLoading ? <Skeleton className="h-full w-full" /> : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={agreementsByState} margin={{ top: 8, right: 10, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="estado" axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 11 }} />
                  <YAxis allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 12 }} />
                  <Tooltip contentStyle={{ borderRadius: 12, borderColor: '#E2E8F0' }} />
                  <Bar dataKey="cantidad" name="Acuerdos" radius={[5, 5, 0, 0]}>
                    {agreementsByState.map((entry) => <Cell key={entry.estado} fill={entry.color} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card className="lg:col-span-6">
          <CardHeader><CardTitle className="text-base">Duración promedio por comité</CardTitle></CardHeader>
          <CardContent className="h-[300px]">
            {isLoading ? <Skeleton className="h-full w-full" /> : committeeStats.length === 0 ? (
              <p className="flex h-full items-center justify-center text-sm text-slate-400">Aún no hay datos de duración.</p>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={committeeStats} layout="vertical" margin={{ top: 4, right: 16, left: 4, bottom: 0 }}>
                  <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" allowDecimals={false} axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 11 }} />
                  <YAxis type="category" dataKey="nombre" width={112} axisLine={false} tickLine={false} tick={{ fill: '#64748B', fontSize: 11 }} />
                  <Tooltip formatter={(value) => [`${value} min`, 'Promedio']} contentStyle={{ borderRadius: 12, borderColor: '#E2E8F0' }} />
                  <Bar dataKey="duracion" name="Promedio" fill="#4F46E5" radius={[0, 5, 5, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader><CardTitle className="text-base">Top 5 participantes más activos</CardTitle></CardHeader>
        <CardContent>
          {participantsQuery.isLoading ? (
            <div className="space-y-3">{Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}</div>
          ) : topParticipants.length === 0 ? (
            <p className="py-5 text-center text-sm text-slate-400">Aún no hay participantes registrados.</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              {topParticipants.map((person, index) => (
                <li key={person.name} className="flex items-center gap-3 rounded-lg border border-slate-100 p-3">
                  <Avatar className="h-10 w-10"><AvatarFallback className="bg-indigo-50 text-sm font-semibold text-indigo-700">{initials(person.name)}</AvatarFallback></Avatar>
                  <div className="min-w-0"><p className="truncate text-sm font-medium text-slate-800">{index + 1}. {person.name}</p><p className="text-xs text-slate-500">{person.reuniones} reuniones</p></div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default Dashboard
