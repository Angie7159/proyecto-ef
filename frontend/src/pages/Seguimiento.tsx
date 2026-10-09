import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { endOfDay, format, parseISO, startOfDay } from 'date-fns'
import { es } from 'date-fns/locale'
import { CalendarDays, CheckSquare, Clock3, FileSpreadsheet, Filter, LoaderCircle, Square, Users } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { DateRangePicker } from '@/components/ui/date-range-picker'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { generarExcelSeguimiento, getApiErrorMessage, listarComitesSeguimiento, listarReunionesSeguimiento, type ReunionSeguimiento } from '@/lib/api'

const statusStyles: Record<string, string> = {
  pendiente_asignacion: 'border-amber-200 bg-amber-50 text-amber-700',
  en_proceso: 'border-blue-200 bg-blue-50 text-blue-700',
  procesada: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  error: 'border-red-200 bg-red-50 text-red-700',
}

const statusLabels: Record<string, string> = {
  pendiente_asignacion: 'Pendiente',
  en_proceso: 'En proceso',
  procesada: 'Procesada',
  error: 'Error',
}

function meetingDate(value: string) {
  const date = parseISO(value)
  return Number.isNaN(date.getTime()) ? value : format(date, "d 'de' MMMM, yyyy", { locale: es })
}

function meetingWeekday(value: string) {
  const date = parseISO(value)
  return Number.isNaN(date.getTime()) ? '' : format(date, 'EEEE', { locale: es })
}

function filterByRange<T extends { fecha: string }>(meetings: T[], range?: DateRange) {
  if (!range?.from) return meetings
  return meetings.filter((meeting) => {
    const meetingDay = parseISO(meeting.fecha)
    if (Number.isNaN(meetingDay.getTime())) return false
    if (meetingDay < startOfDay(range.from!)) return false
    if (range.to && meetingDay > endOfDay(range.to)) return false
    return true
  })
}

export default function Seguimiento() {
  const [committeeId, setCommitteeId] = useState('')
  const [dateRange, setDateRange] = useState<DateRange | undefined>(undefined)
  const [dateRangePreset, setDateRangePreset] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const committees = useQuery({ queryKey: ['comites-con-reuniones'], queryFn: listarComitesSeguimiento })
  const meetings = useQuery({
    queryKey: ['reuniones-comite', committeeId],
    queryFn: () => listarReunionesSeguimiento(committeeId),
    enabled: Boolean(committeeId),
  })

  const filteredMeetings = useMemo(
    () => filterByRange(meetings.data ?? [], dateRange),
    [meetings.data, dateRange],
  )
  const meetingsByWeekday = useMemo(() => {
    const groups: Record<string, ReunionSeguimiento[]> = {}
    for (const meeting of filteredMeetings) {
      const weekday = meetingWeekday(meeting.fecha)
      if (weekday) (groups[weekday] ??= []).push(meeting)
    }
    return groups
  }, [filteredMeetings])
  const weekdayPattern = useMemo(() => {
    const committeeMeetings = meetings.data ?? []
    if (committeeMeetings.length < 3) return null
    const counts = new Map<number, number>()
    for (const meeting of committeeMeetings) {
      const parsed = parseISO(meeting.fecha)
      if (!Number.isNaN(parsed.getTime())) counts.set(parsed.getDay(), (counts.get(parsed.getDay()) ?? 0) + 1)
    }
    const mostCommon = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]
    if (!mostCommon || mostCommon[1] / committeeMeetings.length <= 0.7) return null
    const dayName = format(new Date(2026, 9, 4 + mostCommon[0]), 'EEEE', { locale: es })
    return { day: mostCommon[0], name: dayName, percent: mostCommon[1] / committeeMeetings.length }
  }, [meetings.data])
  const committeeName = committees.data?.find((item) => item.id === committeeId)?.nombre ?? 'comite'
  const selectedMeetings = (meetings.data ?? []).filter((meeting) => selectedIds.includes(meeting.id))
  const participantsTotal = selectedMeetings.reduce((sum, meeting) => sum + (meeting.participantes_count ?? 0), 0)

  // Selecciona todas las reuniones al cargar o cambiar de comité. Al cambiar
  // el rango, `changeDateRange` limita la selección a las reuniones visibles.
  useEffect(() => {
    if (committeeId && meetings.data) {
      setSelectedIds(filterByRange(meetings.data, dateRange).map((meeting) => meeting.id))
    }
    // Intencionalmente depende del comité y del resultado cargado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committeeId, meetings.data])

  const generate = useMutation({
    mutationFn: () => generarExcelSeguimiento(committeeId, selectedIds),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `seguimiento_${committeeName.replace(/\s+/g, '_')}_${Date.now()}.xlsx`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success('Excel generado correctamente')
    },
    onError: (error) => toast.error(getApiErrorMessage(error) || 'Error al generar el Excel'),
  })

  function changeCommittee(id: string) {
    setCommitteeId(id)
    setSelectedIds([])
  }

  function changeDateRange(range: DateRange | undefined, presetLabel?: string) {
    setDateRange(range)
    setDateRangePreset(range ? presetLabel || 'Personalizado' : null)
    setSelectedIds(filterByRange(meetings.data ?? [], range).map((meeting) => meeting.id))
  }

  function clearFilters() {
    setCommitteeId('')
    setDateRange(undefined)
    setDateRangePreset(null)
    setSelectedIds([])
    toast.message('Filtros limpiados')
  }

  function showRecentPattern(count: number) {
    if (!weekdayPattern || !meetings.data) return
    const matching = meetings.data.filter((meeting) => {
      const parsed = parseISO(meeting.fecha)
      return !Number.isNaN(parsed.getTime()) && parsed.getDay() === weekdayPattern.day
    }).slice(0, count)
    if (!matching.length) return
    const first = parseISO(matching[matching.length - 1].fecha)
    const last = parseISO(matching[0].fecha)
    const range = { from: first, to: last }
    changeDateRange(range, `Últimos ${matching.length} ${weekdayPattern.name}`)
  }

  function toggleMeeting(id: string) {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((selected) => selected !== id)
      : [...current, id])
  }

  function selectAll() {
    const filteredIds = filteredMeetings.map((meeting) => meeting.id)
    setSelectedIds((current) => [...new Set([...current, ...filteredIds])])
    toast.success(`${filteredIds.length} reuniones seleccionadas`)
  }

  function deselectAll() {
    const filteredIds = new Set(filteredMeetings.map((meeting) => meeting.id))
    setSelectedIds((current) => current.filter((id) => !filteredIds.has(id)))
    toast.message('Selección actualizada')
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 pb-28 md:p-8 md:pb-32">
      <PageHeader title="Seguimiento" subtitle="Genera un libro consolidado de acuerdos y acciones por comité" />

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-lg">Configuración del reporte</CardTitle>
          <CardDescription>Selecciona el comité y el rango de fechas de las reuniones a incluir.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-5 pt-0 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="seguimiento-comite" className="text-sm font-medium text-slate-700">Comité</label>
            {committees.isLoading ? <Skeleton className="h-11 w-full" /> : (
              <Select value={committeeId} onValueChange={changeCommittee}>
                <SelectTrigger id="seguimiento-comite" className="h-11 w-full" aria-label="Seleccionar comité">
                  <SelectValue placeholder="Selecciona un comité" />
                </SelectTrigger>
                <SelectContent>
                  {(committees.data ?? []).map((committee) => (
                    <SelectItem key={committee.id} value={committee.id}>
                      <span className="flex items-center gap-2">
                        <span aria-hidden="true" className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: committee.color || '#94A3B8' }} />
                        <span className="max-w-48 truncate">{committee.nombre}</span>
                        <span className="text-xs text-slate-500">{committee.reuniones_count} reuniones</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {committees.isError && <p role="alert" className="text-sm text-red-600">No se pudieron cargar los comités. Recarga la página.</p>}
            {!committees.isLoading && !committees.isError && committees.data?.length === 0 && <p className="text-sm text-slate-500">No hay comités con reuniones procesadas.</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-slate-700">Rango de fechas</label>
            <DateRangePicker value={dateRange} appliedPreset={dateRangePreset} onChange={changeDateRange} disabled={!committeeId} />
          </div>
        </CardContent>
      </Card>

      {committeeId ? (
        <>
        <Card className="border-indigo-100 bg-indigo-50/60 shadow-none">
          <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex gap-3">
              <Filter aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-indigo-700" />
              <div className="space-y-1 text-sm">
                <p className="font-semibold text-indigo-950">Filtros activos</p>
                <p className="text-slate-700"><span className="font-medium">Comité:</span> {committeeName}</p>
                <p className="text-slate-700"><span className="font-medium">Rango:</span> {dateRange ? `${format(dateRange.from!, 'd MMM yyyy', { locale: es })} → ${format(dateRange.to ?? dateRange.from!, 'd MMM yyyy', { locale: es })}${dateRangePreset ? ` (${dateRangePreset.toLocaleLowerCase()})` : ''}` : 'En cualquier momento'}</p>
                <p className="text-slate-700"><span className="font-medium">Resultados:</span> {filteredMeetings.length} {filteredMeetings.length === 1 ? 'reunión encontrada' : 'reuniones encontradas'}</p>
              </div>
            </div>
            <Button type="button" variant="outline" size="sm" className="shrink-0 bg-white" onClick={clearFilters}>Limpiar filtros</Button>
          </CardContent>
        </Card>

        {weekdayPattern && (
          <Card className="border-slate-200 shadow-none">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-slate-700">Este comité se reúne principalmente los <strong className="uppercase text-indigo-700">{weekdayPattern.name}</strong> <span className="text-xs text-slate-500">({Math.round(weekdayPattern.percent * 100)}% de las reuniones)</span></p>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={() => showRecentPattern(4)}>Ver últimos 4 {weekdayPattern.name}</Button>
                <Button type="button" variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={() => showRecentPattern(8)}>Ver últimos 8 {weekdayPattern.name}</Button>
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="gap-4 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-1">
              <CardTitle className="text-lg">Reuniones disponibles</CardTitle>
              <CardDescription>{filteredMeetings.length} {filteredMeetings.length === 1 ? 'reunión encontrada' : 'reuniones encontradas'}</CardDescription>
            </div>
            <div className="flex w-full gap-2 sm:w-auto">
              <Button type="button" variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={selectAll} disabled={!filteredMeetings.length}>
                <CheckSquare aria-hidden="true" className="mr-1.5 h-4 w-4" />Seleccionar todas
              </Button>
              <Button type="button" variant="outline" size="sm" className="flex-1 sm:flex-none" onClick={deselectAll} disabled={!selectedIds.length || !filteredMeetings.length}>
                <Square aria-hidden="true" className="mr-1.5 h-4 w-4" />Deseleccionar todas
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            {meetings.isLoading ? (
              <div className="space-y-2" aria-label="Cargando reuniones">{[0, 1, 2].map((item) => <Skeleton key={item} className="h-[76px] w-full" />)}</div>
            ) : meetings.isError ? (
              <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">No se pudieron cargar las reuniones. Intenta de nuevo.</div>
            ) : filteredMeetings.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <CalendarDays aria-hidden="true" className="mx-auto mb-3 h-12 w-12 text-slate-300" />
                <p className="font-medium">No hay reuniones en el rango seleccionado</p>
                <p className="mt-1 text-sm">Prueba ampliando el rango de fechas.</p>
              </div>
            ) : (
              <div className="max-h-[500px] space-y-5 overflow-y-auto pr-1 [scrollbar-gutter:stable] [scrollbar-width:thin]" aria-label="Reuniones disponibles">
                {Object.entries(meetingsByWeekday).map(([weekday, weekdayMeetings]) => (
                  <section key={weekday} className="space-y-2">
                    <h3 className="sticky top-0 z-[1] bg-white/95 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{weekday} · {weekdayMeetings.length} {weekdayMeetings.length === 1 ? 'reunión' : 'reuniones'}</h3>
                    {weekdayMeetings.map((meeting) => {
                  const checked = selectedIds.includes(meeting.id)
                  const status = meeting.estado || 'procesada'
                  return (
                    <label
                      key={meeting.id}
                      className={`flex cursor-pointer flex-col gap-2 rounded-lg border p-3 transition-colors hover:bg-slate-50 sm:flex-row sm:items-center sm:gap-3 sm:p-4 ${checked ? 'border-indigo-200 bg-indigo-50/40' : 'border-slate-200 bg-white'}`}
                    >
                      <div className="flex flex-col gap-2 sm:contents">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleMeeting(meeting.id)}
                          aria-label={`Incluir ${meeting.titulo_final || 'reunión sin título'}`}
                          className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer appearance-auto rounded border-2 border-slate-400 accent-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 sm:mt-0"
                        />
                        <p className="min-w-0 flex-1 truncate text-sm font-medium text-slate-900">{meeting.titulo_final || 'Reunión sin título'}</p>
                      </div>
                      <div className="min-w-0 flex-1 pl-8 sm:pl-0">
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-slate-500 sm:text-sm">
                          <span className="inline-flex items-center gap-1.5"><CalendarDays aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /><strong className="font-semibold capitalize text-indigo-700">{meetingWeekday(meeting.fecha)}</strong>, {meetingDate(meeting.fecha)}</span>
                          <span className="inline-flex items-center gap-1.5"><Clock3 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{meeting.hora_inicio || '—'} – {meeting.hora_fin || '—'}</span>
                          <span className="inline-flex items-center gap-1.5"><Users aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />{meeting.participantes_count ?? 0}</span>
                        </div>
                      </div>
                      <Badge onClick={(event) => { event.preventDefault(); event.stopPropagation() }} variant="outline" className={`ml-8 shrink-0 text-[10px] sm:ml-0 sm:text-xs ${statusStyles[status] || statusStyles.procesada}`}>
                        {statusLabels[status] || status}
                      </Badge>
                    </label>
                  )
                    })}
                  </section>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        </>
      ) : (
        <Card>
          <CardContent className="py-12 text-center text-slate-500">
            <Users aria-hidden="true" className="mx-auto mb-3 h-12 w-12 text-slate-300" />
            <p className="font-medium text-slate-700">Selecciona un comité para ver las reuniones disponibles</p>
            <p className="mt-1 text-sm">Las reuniones se seleccionarán automáticamente al cargar.</p>
          </CardContent>
        </Card>
      )}

      {committeeId && (
        <div className="sticky bottom-3 z-10">
          <Card className="border-indigo-200 bg-white/95 shadow-lg backdrop-blur">
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-center text-sm text-slate-600 sm:text-left">{selectedIds.length === 0 ? <span>Selecciona al menos una reunión</span> : <><strong className="text-slate-900">{selectedIds.length} reuniones</strong> · {participantsTotal} participantes totales</>}</p>
              <Button size="lg" onClick={() => generate.mutate()} disabled={generate.isPending || !committeeId || selectedIds.length === 0} className="w-full sm:w-auto">
                {generate.isPending ? <LoaderCircle aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet aria-hidden="true" className="mr-2 h-4 w-4" />}
                {generate.isPending ? 'Generando…' : 'Generar Excel de seguimiento'}
              </Button>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  )
}
