import { useMemo, useState, type FormEvent, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { differenceInCalendarDays, parseISO } from 'date-fns'
import { es } from 'date-fns/locale'
import {
  Building2,
  Ellipsis,
  Pencil,
  Plus,
  Users,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { supabase } from '@/lib/supabase'
import type { Comite, FrecuenciaComite } from '@/types'

const committeeColors = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EF4444', '#EC4899', '#06B6D4', '#84CC16']
const frequencyLabels: Record<FrecuenciaComite, string> = {
  semanal: 'Semanal',
  quincenal: 'Quincenal',
  mensual: 'Mensual',
  'ad-hoc': 'Ad-hoc',
}

type CommitteeForm = {
  nombre: string
  descripcion: string
  frecuencia: FrecuenciaComite
  color: string
  participantes_habituales: string[]
}
type MeetingCommitteeRow = { comite_id: string | null }
type PendingAgreementCommitteeRow = { comite_id: string | null }
type LastMeetingCommitteeRow = { comite_id: string | null; fecha: string }
type CommitteeStats = {
  meetings: Record<string, number>
  pending: Record<string, number>
  lastMeeting: Record<string, string>
}

const blankForm: CommitteeForm = {
  nombre: '',
  descripcion: '',
  frecuencia: 'mensual',
  color: committeeColors[0],
  participantes_habituales: [],
}

function makeInitials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || '?'
}

function lastMeetingLabel(date: string | undefined) {
  if (!date) return 'Sin reuniones'
  const days = differenceInCalendarDays(new Date(), parseISO(date))
  if (days <= 0) return 'Hoy'
  return `Hace ${days} ${days === 1 ? 'día' : 'días'}`
}

function Comites() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingCommittee, setEditingCommittee] = useState<Comite | null>(null)
  const [form, setForm] = useState<CommitteeForm>(blankForm)
  const [participantInput, setParticipantInput] = useState('')
  const [formError, setFormError] = useState('')

  const committeesQuery = useQuery({
    queryKey: ['comites'],
    queryFn: async () => {
      const { data, error } = await supabase.from('comites').select('*').eq('activo', true).order('nombre')
      if (error) throw error
      return (data ?? []) as Comite[]
    },
  })
  const meetingsCountQuery = useQuery({
    queryKey: ['comites-reuniones-count'],
    queryFn: async () => {
      const { data, error } = await supabase.from('reuniones').select('comite_id')
      if (error) throw error
      return (data ?? []) as MeetingCommitteeRow[]
    },
  })
  const pendingAgreementsQuery = useQuery({
    queryKey: ['comites-acuerdos-pendientes'],
    queryFn: async () => {
      const { data, error } = await supabase.from('acuerdos').select('comite_id').in('estado', ['pendiente', 'en_proceso'])
      if (error) throw error
      return (data ?? []) as PendingAgreementCommitteeRow[]
    },
  })
  const latestMeetingsQuery = useQuery({
    queryKey: ['comites-ultima-reunion'],
    queryFn: async () => {
      const { data, error } = await supabase.from('reuniones').select('comite_id, fecha').not('comite_id', 'is', null).order('fecha', { ascending: false })
      if (error) throw error
      return (data ?? []) as LastMeetingCommitteeRow[]
    },
  })

  const stats = useMemo<CommitteeStats>(() => {
    const meetings: Record<string, number> = {}
    const pending: Record<string, number> = {}
    const lastMeeting: Record<string, string> = {}
    meetingsCountQuery.data?.forEach(({ comite_id }) => {
      if (comite_id) meetings[comite_id] = (meetings[comite_id] ?? 0) + 1
    })
    pendingAgreementsQuery.data?.forEach(({ comite_id }) => {
      if (comite_id) pending[comite_id] = (pending[comite_id] ?? 0) + 1
    })
    latestMeetingsQuery.data?.forEach(({ comite_id, fecha }) => {
      if (comite_id && (!lastMeeting[comite_id] || fecha > lastMeeting[comite_id])) lastMeeting[comite_id] = fecha
    })
    return { meetings, pending, lastMeeting }
  }, [latestMeetingsQuery.data, meetingsCountQuery.data, pendingAgreementsQuery.data])

  const refreshCommitteeData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['comites'] }),
      queryClient.invalidateQueries({ queryKey: ['comites-reuniones-count'] }),
      queryClient.invalidateQueries({ queryKey: ['comites-acuerdos-pendientes'] }),
      queryClient.invalidateQueries({ queryKey: ['comites-ultima-reunion'] }),
    ])
  }

  const saveCommittee = useMutation({
    mutationFn: async (values: CommitteeForm) => {
      const { data: existing, error: existingError } = await supabase.from('comites').select('id, nombre')
      if (existingError) throw existingError
      const duplicate = (existing ?? []).some((item) => (
        item.id !== editingCommittee?.id && item.nombre.trim().toLocaleLowerCase('es') === values.nombre.trim().toLocaleLowerCase('es')
      ))
      if (duplicate) throw new Error('Ya existe un comité con ese nombre.')

      const payload = {
        nombre: values.nombre.trim(),
        descripcion: values.descripcion.trim() || null,
        frecuencia: values.frecuencia,
        color: values.color,
        participantes_habituales: values.participantes_habituales,
      }
      if (editingCommittee) {
        const { error } = await supabase.from('comites').update(payload).eq('id', editingCommittee.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('comites').insert({ ...payload, activo: true })
        if (error) throw error
      }
    },
    onSuccess: async () => {
      await refreshCommitteeData()
      toast.success(editingCommittee ? 'Comité actualizado' : 'Comité creado')
      closeDialog()
    },
    onError: (error) => setFormError(error instanceof Error ? error.message : 'No se pudo guardar el comité.'),
  })

  const deactivateCommittee = useMutation({
    mutationFn: async (committee: Comite) => {
      const { error } = await supabase.from('comites').update({ activo: false }).eq('id', committee.id)
      if (error) throw error
    },
    onSuccess: async () => {
      await refreshCommitteeData()
      toast.success('Comité desactivado')
    },
    onError: () => toast.error('No se pudo desactivar el comité'),
  })

  function closeDialog() {
    setDialogOpen(false)
    setEditingCommittee(null)
    setForm(blankForm)
    setParticipantInput('')
    setFormError('')
  }

  function openCreateDialog() {
    setEditingCommittee(null)
    setForm(blankForm)
    setParticipantInput('')
    setFormError('')
    setDialogOpen(true)
  }

  function openEditDialog(committee: Comite) {
    setEditingCommittee(committee)
    setForm({
      nombre: committee.nombre,
      descripcion: committee.descripcion ?? '',
      frecuencia: committee.frecuencia ?? 'mensual',
      color: committee.color || committeeColors[0],
      participantes_habituales: committee.participantes_habituales ?? [],
    })
    setParticipantInput('')
    setFormError('')
    setDialogOpen(true)
  }

  function addParticipant(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    const participant = participantInput.trim()
    if (!participant) return
    if (form.participantes_habituales.some((item) => item.toLocaleLowerCase('es') === participant.toLocaleLowerCase('es'))) {
      setParticipantInput('')
      return
    }
    setForm((current) => ({ ...current, participantes_habituales: [...current.participantes_habituales, participant] }))
    setParticipantInput('')
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!form.nombre.trim()) {
      setFormError('El nombre del comité es obligatorio.')
      return
    }
    setFormError('')
    saveCommittee.mutate(form)
  }

  function confirmDeactivate(committee: Comite, label: 'desactivar' | 'eliminar') {
    const prompt = label === 'eliminar'
      ? `¿Eliminar “${committee.nombre}”? El comité se ocultará, pero sus reuniones y acuerdos se conservarán.`
      : `¿Desactivar “${committee.nombre}”? Sus reuniones y acuerdos se conservarán.`
    if (window.confirm(prompt)) deactivateCommittee.mutate(committee)
  }

  function handleCardKeyDown(event: KeyboardEvent<HTMLDivElement>, committeeId: string) {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      navigate(`/reuniones?comite=${encodeURIComponent(committeeId)}`)
    }
  }

  const isLoading = committeesQuery.isLoading || meetingsCountQuery.isLoading || pendingAgreementsQuery.isLoading || latestMeetingsQuery.isLoading
  const isError = committeesQuery.isError || meetingsCountQuery.isError || pendingAgreementsQuery.isError || latestMeetingsQuery.isError
  const committees = committeesQuery.data ?? []

  return (
    <div className="mx-auto w-full max-w-7xl space-y-7 p-6 md:p-8">
      <PageHeader
        title="Comités"
        actions={<Button onClick={openCreateDialog}><Plus className="h-4 w-4" /> Nuevo comité</Button>}
      />

      {isError ? (
        <Card className="border-red-200"><CardContent className="p-8 text-center text-sm text-red-700">No se pudieron cargar los comités y sus estadísticas.</CardContent></Card>
      ) : isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Cargando comités">
          {Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="h-64 rounded-xl" />)}
        </div>
      ) : committees.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-72 flex-col items-center justify-center px-6 py-12 text-center">
            <span className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50 text-indigo-600"><Building2 className="h-7 w-7" /></span>
            <h2 className="text-lg font-semibold text-slate-900">Aún no hay comités</h2>
            <p className="mt-1 max-w-sm text-sm text-slate-500">Crea un comité para organizar reuniones, participantes y acuerdos.</p>
            <Button className="mt-5" onClick={openCreateDialog}><Plus className="h-4 w-4" /> Crear primer comité</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {committees.map((committee) => {
            const participants = committee.participantes_habituales ?? []
            const visibleParticipants = participants.slice(0, 5)
            const extraParticipants = participants.length - visibleParticipants.length
            return (
              <Card
                key={committee.id}
                role="link"
                tabIndex={0}
                aria-label={`Ver reuniones del comité ${committee.nombre}`}
                onClick={() => navigate(`/reuniones?comite=${encodeURIComponent(committee.id)}`)}
                onKeyDown={(event) => handleCardKeyDown(event, committee.id)}
                className="cursor-pointer transition hover:border-slate-300 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <CardHeader className="space-y-4 pb-3">
                  <div className="flex items-start gap-3">
                    <span className="h-10 w-10 shrink-0 rounded-full ring-4 ring-slate-50" style={{ backgroundColor: committee.color }} />
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate font-semibold text-slate-900">{committee.nombre}</h2>
                      <Badge variant="secondary" className="mt-1 text-xs">{committee.frecuencia ? frequencyLabels[committee.frecuencia] : 'Sin frecuencia'}</Badge>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Acciones para ${committee.nombre}`}
                          onClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          className="h-8 w-8 shrink-0"
                        ><Ellipsis className="h-4 w-4" /></Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenuItem onSelect={() => openEditDialog(committee)}><Pencil className="mr-2 h-4 w-4" /> Editar</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => confirmDeactivate(committee, 'desactivar')}>Desactivar</DropdownMenuItem>
                        <DropdownMenuItem className="text-red-600 focus:text-red-600" onSelect={() => confirmDeactivate(committee, 'eliminar')}>Eliminar</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                  <p className="line-clamp-2 min-h-10 text-sm leading-5 text-slate-500">{committee.descripcion || 'Sin descripción.'}</p>
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  <div className="grid grid-cols-3 gap-2 border-y border-slate-100 py-3">
                    <div><p className="text-[11px] text-slate-400">Reuniones</p><p className="mt-1 text-sm font-semibold text-slate-800">{stats.meetings[committee.id] ?? 0}</p></div>
                    <div><p className="text-[11px] text-slate-400">Acuerdos pendientes</p><p className="mt-1 text-sm font-semibold text-slate-800">{stats.pending[committee.id] ?? 0}</p></div>
                    <div><p className="text-[11px] text-slate-400">Última reunión</p><p className="mt-1 truncate text-sm font-semibold text-slate-800">{lastMeetingLabel(stats.lastMeeting[committee.id])}</p></div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><Users className="h-3.5 w-3.5" /> Participantes habituales</span>
                    <div className="flex items-center -space-x-2" aria-label={`${participants.length} participantes habituales`}>
                      {visibleParticipants.map((participant, index) => (
                        <Avatar key={`${participant}-${index}`} className="h-8 w-8 border-2 border-white">
                          <AvatarFallback className="text-[10px] font-semibold text-white" style={{ backgroundColor: committee.color }}>{makeInitials(participant)}</AvatarFallback>
                        </Avatar>
                      ))}
                      {extraParticipants > 0 && <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-[10px] font-semibold text-slate-600">+{extraParticipants}</span>}
                      {participants.length === 0 && <span className="text-xs text-slate-400">Sin participantes</span>}
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={(open) => open ? setDialogOpen(true) : closeDialog()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingCommittee ? 'Editar comité' : 'Nuevo comité'}</DialogTitle>
            <DialogDescription>Configura la información y participantes habituales del comité.</DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="committee-name" className="text-sm font-medium text-slate-700">Nombre <span className="text-red-600">*</span></label>
              <Input id="committee-name" value={form.nombre} maxLength={160} autoFocus onChange={(event) => { setForm((current) => ({ ...current, nombre: event.target.value })); setFormError('') }} placeholder="Ej. Comité Académico" />
            </div>
            <div className="space-y-2">
              <label htmlFor="committee-description" className="text-sm font-medium text-slate-700">Descripción</label>
              <textarea id="committee-description" value={form.descripcion} onChange={(event) => setForm((current) => ({ ...current, descripcion: event.target.value }))} rows={3} className="flex w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring" placeholder="Objetivo y responsabilidades del comité" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-slate-700">Frecuencia</label>
                <Select value={form.frecuencia} onValueChange={(frecuencia: FrecuenciaComite) => setForm((current) => ({ ...current, frecuencia }))}>
                  <SelectTrigger aria-label="Frecuencia del comité"><SelectValue /></SelectTrigger>
                  <SelectContent>{Object.entries(frequencyLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium text-slate-700">Color</legend>
                <div className="flex flex-wrap gap-2">
                  {committeeColors.map((color) => (
                    <button key={color} type="button" aria-label={`Elegir color ${color}`} aria-pressed={form.color === color} onClick={() => setForm((current) => ({ ...current, color }))} className={`h-7 w-7 rounded-full transition ${form.color === color ? 'ring-2 ring-slate-900 ring-offset-2' : 'hover:scale-110'}`} style={{ backgroundColor: color }} />
                  ))}
                </div>
              </fieldset>
            </div>
            <div className="space-y-2">
              <label htmlFor="committee-participants" className="text-sm font-medium text-slate-700">Participantes habituales</label>
              <Input id="committee-participants" value={participantInput} onChange={(event) => setParticipantInput(event.target.value)} onKeyDown={addParticipant} placeholder="Escribe un nombre y presiona Enter" />
              {form.participantes_habituales.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {form.participantes_habituales.map((participant, index) => (
                    <Badge key={`${participant}-${index}`} variant="secondary" className="gap-1 py-1 pl-2.5">
                      {participant}
                      <button type="button" aria-label={`Quitar a ${participant}`} onClick={() => setForm((current) => ({ ...current, participantes_habituales: current.participantes_habituales.filter((_, itemIndex) => itemIndex !== index) }))} className="ml-0.5 rounded-full hover:text-red-600"><X className="h-3 w-3" /></button>
                    </Badge>
                  ))}
                </div>
              )}
            </div>
            {formError && <p role="alert" className="text-sm text-red-600">{formError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeDialog} disabled={saveCommittee.isPending}>Cancelar</Button>
              <Button type="submit" disabled={saveCommittee.isPending || !form.nombre.trim()}>
                {saveCommittee.isPending ? 'Guardando…' : 'Guardar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default Comites
