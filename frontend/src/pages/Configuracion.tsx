import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Download, ExternalLink, LoaderCircle, ShieldAlert, UserRound } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/layout/PageHeader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useLocalStorage } from '@/hooks/useLocalStorage'
import { supabase } from '@/lib/supabase'

type Preferences = {
  language: string; theme: string; emailNotifications: boolean; compactMode: boolean
  whisperModel: string; groqModel: string; temperature: number; autoProcess: boolean; includeTranscript: boolean
}

const defaultSettings: Preferences = {
  language: 'es', theme: 'light', emailNotifications: true, compactMode: false,
  whisperModel: 'small', groqModel: 'openai/gpt-oss-120b', temperature: 0.3,
  autoProcess: true, includeTranscript: false,
}

type Profile = { name: string; email: string; roleTitle: string; role: string }
const initialProfile: Profile = { name: 'Administrador', email: 'admin@meetia.edu', roleTitle: 'Coordinador Académico', role: 'admin' }

function initials(value: string) {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'U'
}

function SelectField({ label, value, onValueChange, options }: { label: string; value: string; onValueChange: (value: string) => void; options: [string, string][] }) {
  return <label className="block space-y-2 text-sm font-medium text-slate-700"><span>{label}</span><Select value={value} onValueChange={onValueChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{options.map(([key, title]) => <SelectItem key={key} value={key}>{title}</SelectItem>)}</SelectContent></Select></label>
}

function SwitchField({ label, checked, onCheckedChange }: { label: string; checked: boolean; onCheckedChange: (value: boolean) => void }) {
  return <div className="flex items-center justify-between gap-4 rounded-lg border border-slate-200 px-4 py-3"><span className="text-sm text-slate-700">{label}</span><button type="button" role="switch" aria-checked={checked} onClick={() => onCheckedChange(!checked)} className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 ${checked ? 'bg-indigo-600' : 'bg-slate-300'}`}><span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[22px]' : 'translate-x-0.5'}`} /></button></div>
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block space-y-2 text-sm font-medium text-slate-700"><span>{label}</span>{children}</label>
}

export default function Configuracion() {
  const [settings, setSettings] = useLocalStorage<Preferences>('meetia_settings', defaultSettings)
  const [profile, setProfile] = useState(initialProfile)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deletePhrase, setDeletePhrase] = useState('')
  const queryClient = useQueryClient()
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'URL no configurada'

  const healthQuery = useQuery({
    queryKey: ['backend-health'],
    queryFn: async () => {
      const response = await fetch('http://localhost:8000/health')
      if (!response.ok) throw new Error('Backend no disponible')
      return response.json() as Promise<{ status: string; environment?: string }>
    },
    refetchInterval: 30_000,
    retry: 1,
  })

  const lastSync = useMemo(() => new Intl.DateTimeFormat('es-PE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date()), [])
  const updateSettings = <K extends keyof Preferences>(key: K, value: Preferences[K]) => setSettings((current) => ({ ...current, [key]: value }))

  const exportMutation = useMutation({
    mutationFn: async () => {
      const [meetings, agreements, committees] = await Promise.all([
        supabase.from('reuniones').select('*'), supabase.from('acuerdos').select('*'), supabase.from('comites').select('*'),
      ])
      const error = meetings.error || agreements.error || committees.error
      if (error) throw error
      const backup = { exported_at: new Date().toISOString(), reuniones: meetings.data, acuerdos: agreements.data, comites: committees.data }
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `meetia-backup-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(url)
    },
    onSuccess: () => toast.success('Exportación descargada'),
    onError: (error) => toast.error(`No se pudo exportar: ${error instanceof Error ? error.message : 'Error desconocido'}`),
  })

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.from('reuniones').select('id')
      if (error) throw error
      const ids = (data ?? []).map((item) => item.id as string)
      for (let index = 0; index < ids.length; index += 100) {
        const result = await supabase.from('reuniones').delete().in('id', ids.slice(index, index + 100))
        if (result.error) throw result.error
      }
      return ids.length
    },
    onSuccess: async (count) => {
      toast.success(`Se eliminaron ${count} reuniones`)
      setDeleteOpen(false)
      setDeletePhrase('')
      await queryClient.invalidateQueries()
    },
    onError: (error) => toast.error(`No se pudieron eliminar las reuniones: ${error instanceof Error ? error.message : 'Error desconocido'}`),
  })

  return (
    <TooltipProvider>
      <div className="mx-auto w-full max-w-4xl space-y-8 p-6 md:p-8">
        <PageHeader title="Configuración" />

        <Card><CardHeader><CardTitle>Perfil de usuario</CardTitle><CardDescription>Información básica de tu perfil en MeetIA.</CardDescription></CardHeader><CardContent className="space-y-6">
          <div className="flex items-center gap-4"><div className="flex h-20 w-20 items-center justify-center rounded-full bg-indigo-100 text-2xl font-semibold text-indigo-700">{initials(profile.name)}</div><div><p className="font-medium text-slate-900">{profile.name}</p><p className="text-sm text-slate-500">{profile.roleTitle}</p></div></div>
          <div className="grid gap-4 md:grid-cols-2"><Field label="Nombre completo"><Input value={profile.name} onChange={(event) => setProfile({ ...profile, name: event.target.value })} /></Field><Field label="Email"><Input type="email" value={profile.email} onChange={(event) => setProfile({ ...profile, email: event.target.value })} /></Field><Field label="Cargo"><Input value={profile.roleTitle} onChange={(event) => setProfile({ ...profile, roleTitle: event.target.value })} /></Field><SelectField label="Rol" value={profile.role} onValueChange={(role) => setProfile({ ...profile, role })} options={ [['admin', 'Admin'], ['editor', 'Editor'], ['viewer', 'Viewer']] } /></div>
          <Button onClick={() => toast.success('Perfil actualizado (demo)')}>Guardar cambios</Button>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Preferencias</CardTitle><CardDescription>Personaliza tu experiencia de uso.</CardDescription></CardHeader><CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2"><SelectField label="Idioma" value={settings.language} onValueChange={(value) => setSettings((current) => ({ ...current, language: value }))} options={ [['es', 'Español'], ['en', 'Inglés'], ['pt', 'Portugués']] } /><SelectField label="Tema" value={settings.theme} onValueChange={(value) => setSettings((current) => ({ ...current, theme: value }))} options={ [['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Automático']] } /></div>
          <SwitchField label="Recibir notificaciones por email cuando una reunión termine de procesarse" checked={settings.emailNotifications} onCheckedChange={(value) => setSettings((current) => ({ ...current, emailNotifications: value }))} />
          <SwitchField label="Modo compacto en listas" checked={settings.compactMode} onCheckedChange={(value) => setSettings((current) => ({ ...current, compactMode: value }))} />
          <Button variant="outline" onClick={() => toast.success('Preferencias guardadas')}>Guardar preferencias</Button>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Configuración de IA</CardTitle><CardDescription>Selecciona los modelos y opciones para procesar reuniones.</CardDescription></CardHeader><CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-2"><SelectField label="Modelo de transcripción (Whisper)" value={settings.whisperModel} onValueChange={(value) => setSettings((current) => ({ ...current, whisperModel: value }))} options={ [['tiny', 'tiny · rápido, menos preciso'], ['small', 'small · recomendado, balance'], ['medium', 'medium · lento, más preciso']] } /><SelectField label="Modelo de análisis (Groq)" value={settings.groqModel} onValueChange={(value) => setSettings((current) => ({ ...current, groqModel: value }))} options={ [['openai/gpt-oss-120b', 'openai/gpt-oss-120b · recomendado'], ['openai/gpt-oss-20b', 'openai/gpt-oss-20b · más rápido'], ['qwen/qwen3.6-27b', 'qwen/qwen3.6-27b · alternativo']] } /></div>
          <div className="space-y-2 rounded-lg border border-slate-200 p-4"><div className="flex items-center justify-between"><label htmlFor="temperature" className="text-sm font-medium text-slate-700">Temperatura del análisis IA</label><span className="rounded bg-slate-100 px-2 py-1 text-sm font-medium text-slate-700">{settings.temperature.toFixed(1)}</span></div><input id="temperature" type="range" min="0" max="1" step="0.1" value={settings.temperature} onChange={(event) => setSettings((current) => ({ ...current, temperature: Number(event.target.value) }))} className="h-2 w-full cursor-pointer accent-indigo-600" /><p className="text-xs text-slate-500">Menor = más consistente, Mayor = más creativo</p></div>
          <SwitchField label="Auto-procesar reuniones al subir el audio" checked={settings.autoProcess} onCheckedChange={(value) => setSettings((current) => ({ ...current, autoProcess: value }))} />
          <SwitchField label="Incluir transcripción completa en los documentos descargables" checked={settings.includeTranscript} onCheckedChange={(value) => setSettings((current) => ({ ...current, includeTranscript: value }))} />
          <Button onClick={() => toast.success('Configuración de IA guardada')}>Guardar configuración de IA</Button>
        </CardContent></Card>

        <Card><CardHeader><CardTitle>Información del sistema</CardTitle><CardDescription>Estado de los servicios conectados a MeetIA.</CardDescription></CardHeader><CardContent className="space-y-5">
          <div className="overflow-hidden rounded-lg border border-slate-200"><table className="w-full text-sm"><tbody className="divide-y divide-slate-200">
            <tr><th className="w-1/2 px-4 py-3 text-left font-medium text-slate-500">Versión MeetIA</th><td className="px-4 py-3 text-slate-900">v0.1.0</td></tr>
            <tr><th className="px-4 py-3 text-left font-medium text-slate-500">Entorno</th><td className="px-4 py-3 text-slate-900">{healthQuery.data?.environment || 'development'}</td></tr>
            <tr><th className="px-4 py-3 text-left font-medium text-slate-500">Backend API</th><td className="flex flex-wrap items-center gap-2 px-4 py-3"><span>http://localhost:8000</span><Badge className={healthQuery.isSuccess ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-100' : 'bg-red-100 text-red-700 hover:bg-red-100'}>{healthQuery.isPending ? 'Verificando' : healthQuery.isSuccess ? 'Conectado' : 'Desconectado'}</Badge>{healthQuery.isFetching && <LoaderCircle className="h-3.5 w-3.5 animate-spin text-slate-400" />}</td></tr>
            <tr><th className="px-4 py-3 text-left font-medium text-slate-500">Supabase</th><td className="flex flex-wrap items-center gap-2 px-4 py-3"><span className="break-all">{supabaseUrl}</span><Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Configurado</Badge></td></tr>
            <tr><th className="px-4 py-3 text-left font-medium text-slate-500">Última sincronización</th><td className="px-4 py-3 text-slate-900">{lastSync}</td></tr>
          </tbody></table></div>
          <div className="flex flex-wrap gap-3"><Tooltip><TooltipTrigger asChild><span tabIndex={0}><Button variant="outline" disabled><ExternalLink className="mr-2 h-4 w-4" />Ver documentación</Button></span></TooltipTrigger><TooltipContent>Próximamente</TooltipContent></Tooltip><Tooltip><TooltipTrigger asChild><span tabIndex={0}><Button variant="outline" disabled><UserRound className="mr-2 h-4 w-4" />Reportar un problema</Button></span></TooltipTrigger><TooltipContent>Próximamente</TooltipContent></Tooltip></div>
        </CardContent></Card>

        <Card className="border-red-200"><CardHeader><CardTitle className="flex items-center gap-2 text-red-700"><ShieldAlert className="h-5 w-5" />Zona de peligro</CardTitle><CardDescription>Estas acciones son irreversibles</CardDescription></CardHeader><CardContent className="flex flex-wrap gap-3">
          <Button className="bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => exportMutation.mutate()} disabled={exportMutation.isPending}><Download className="mr-2 h-4 w-4" />{exportMutation.isPending ? 'Preparando exportación…' : 'Exportar todos los datos'}</Button>
          <Button variant="destructive" onClick={() => setDeleteOpen(true)}><AlertTriangle className="mr-2 h-4 w-4" />Eliminar todas las reuniones</Button>
          <Tooltip><TooltipTrigger asChild><span tabIndex={0}><Button variant="destructive" disabled>Eliminar cuenta</Button></span></TooltipTrigger><TooltipContent>Próximamente</TooltipContent></Tooltip>
        </CardContent></Card>
      </div>

      <Dialog open={deleteOpen} onOpenChange={(open) => { setDeleteOpen(open); if (!open) setDeletePhrase('') }}><DialogContent><DialogHeader><DialogTitle className="flex items-center gap-2 text-red-700"><AlertTriangle className="h-5 w-5" />Eliminar todas las reuniones</DialogTitle><DialogDescription>Se eliminarán permanentemente las reuniones guardadas. Escribe <strong>ELIMINAR</strong> para confirmar esta acción.</DialogDescription></DialogHeader><Input autoFocus value={deletePhrase} onChange={(event) => setDeletePhrase(event.target.value)} placeholder="ELIMINAR" aria-label="Escribe ELIMINAR para confirmar" /><DialogFooter><Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteMutation.isPending}>Cancelar</Button><Button variant="destructive" disabled={deletePhrase !== 'ELIMINAR' || deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>{deleteMutation.isPending ? <><LoaderCircle className="mr-2 h-4 w-4 animate-spin" />Eliminando…</> : <><Check className="mr-2 h-4 w-4" />Eliminar reuniones</>}</Button></DialogFooter></DialogContent></Dialog>
    </TooltipProvider>
  )
}
