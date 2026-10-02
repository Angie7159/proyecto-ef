import { useRef, useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { useNavigate, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { FileAudio, FileVideo, LoaderCircle, UploadCloud, X } from 'lucide-react'
import { PageHeader } from '@/components/layout/PageHeader'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { supabase } from '@/lib/supabase'
import { getApiErrorMessage, procesarReunionCompleta } from '@/lib/api'
import type { Comite, FuenteReunion } from '@/types'

const MAX_FILE_SIZE = 500 * 1024 * 1024
const ACCEPTED_EXTENSIONS = ['mp3', 'mp4', 'm4a', 'wav', 'mov', 'webm']
const ACCEPTED_FILES = '.mp3,.mp4,.m4a,.wav,.mov,.webm'

type FormErrors = Partial<Record<'file' | 'title' | 'date' | 'time' | 'committee' | 'submit', string>>

function localToday() {
  return format(new Date(), 'yyyy-MM-dd')
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function Upload() {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [title, setTitle] = useState('')
  const [date, setDate] = useState(localToday)
  const [startTime, setStartTime] = useState('')
  const [endTime, setEndTime] = useState('')
  const [committeeId, setCommitteeId] = useState('')
  const [source, setSource] = useState<FuenteReunion>('upload')
  const [errors, setErrors] = useState<FormErrors>({})
  const [isUploading, setIsUploading] = useState(false)
  const [processingStage, setProcessingStage] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  const { data: committees = [], isLoading: committeesLoading, isError: committeesError } = useQuery({
    queryKey: ['comites', 'upload'],
    queryFn: async () => {
      const { data, error } = await supabase.from('comites').select('id, nombre').order('nombre')
      if (error) throw error
      return (data ?? []) as Pick<Comite, 'id' | 'nombre'>[]
    },
  })

  function validateFile(candidate: File | null) {
    if (!candidate) return 'Selecciona un archivo de audio o video.'
    const extension = candidate.name.split('.').pop()?.toLowerCase()
    if (!extension || !ACCEPTED_EXTENSIONS.includes(extension)) {
      return 'Formato no válido. Usa MP3, MP4, M4A, WAV, MOV o WEBM.'
    }
    if (candidate.size > MAX_FILE_SIZE) return 'El archivo supera el límite máximo de 500 MB.'
    return ''
  }

  function selectFile(candidate: File | null) {
    setFile(candidate)
    setErrors((current) => ({ ...current, file: validateFile(candidate) || undefined }))
  }

  function onFileInputChange(event: ChangeEvent<HTMLInputElement>) {
    selectFile(event.target.files?.[0] ?? null)
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault()
    setIsDragging(false)
    selectFile(event.dataTransfer.files?.[0] ?? null)
  }

  function validateForm() {
    const nextErrors: FormErrors = {}
    const fileError = validateFile(file)
    if (fileError) nextErrors.file = fileError
    if (!title.trim()) nextErrors.title = 'Escribe el título de la reunión.'
    if (!date) nextErrors.date = 'Selecciona la fecha de la reunión.'
    else if (date > localToday()) nextErrors.date = 'La fecha no puede ser futura.'
    if (startTime && endTime && endTime <= startTime) {
      nextErrors.time = 'La hora de fin debe ser posterior a la hora de inicio.'
    }
    if (!committeeId) nextErrors.committee = 'Selecciona un comité.'
    setErrors(nextErrors)
    return Object.keys(nextErrors).length === 0
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validateForm() || !file) return

    setIsUploading(true)
    setProcessingStage('Subiendo audio...')
    setErrors({})
    const extension = file.name.split('.').pop()!.toLowerCase()
    const objectPath = `${date}/${crypto.randomUUID()}.${extension}`
    let uploadedPath: string | null = null
    let meetingId: string | null = null

    try {
      const { data: storageData, error: storageError } = await supabase.storage
        .from('audios')
        .upload(objectPath, file, {
          cacheControl: '3600',
          contentType: file.type || undefined,
          upsert: false,
        })
      if (storageError) throw storageError
      uploadedPath = storageData.path

      const { data: publicData } = supabase.storage.from('audios').getPublicUrl(storageData.path)
      const { data: meeting, error: insertError } = await supabase.from('reuniones').insert({
        titulo_original: title.trim(),
        titulo_final: title.trim(),
        fecha: date,
        hora_inicio: startTime || null,
        hora_fin: endTime || null,
        duracion_min: startTime && endTime
          ? Math.round((new Date(`1970-01-01T${endTime}:00`).getTime() - new Date(`1970-01-01T${startTime}:00`).getTime()) / 60000)
          : null,
        comite_id: committeeId,
        fuente: source,
        estado: 'en_proceso',
        progreso: 'Transcribiendo con IA...',
        audio_url: publicData.publicUrl,
      }).select('id').single()
      if (insertError) {
        console.error('Error al crear el registro de reunión en Supabase:', {
          code: insertError.code,
          message: insertError.message,
          details: insertError.details,
          hint: insertError.hint,
        })
        throw insertError
      }
      const createdMeetingId = meeting.id
      meetingId = createdMeetingId

      setProcessingStage('Transcribiendo con IA...')
      const pipelinePromise = procesarReunionCompleta(createdMeetingId).then(
        (data) => ({ ok: true as const, data }),
        (error: unknown) => ({ ok: false as const, error }),
      )

      while (true) {
        const outcome = await Promise.race([
          pipelinePromise,
          new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 1500)),
        ])
        if (outcome) {
          if (!outcome.ok) throw outcome.error
          setProcessingStage('¡Listo!')
          break
        }

        const { data: progress, error: progressError } = await supabase
          .from('reuniones')
          .select('estado, progreso, error_mensaje')
          .eq('id', createdMeetingId)
          .single()
        if (progressError) throw progressError
        if (progress.error_mensaje) throw new Error(progress.error_mensaje)
        if (progress.progreso) setProcessingStage(progress.progreso)
        if (progress.estado === 'procesada') {
          setProcessingStage('¡Listo!')
          await pipelinePromise.then((result) => {
            if (!result.ok) throw result.error
          })
          break
        }
      }

      setProcessingStage('¡Listo!')
      toast.success('Reunión procesada y documentos generados')
      navigate(`/reuniones/${createdMeetingId}`)
    } catch (error) {
      if (uploadedPath && !meetingId) {
        await supabase.storage.from('audios').remove([uploadedPath])
      }
      let message = getApiErrorMessage(error)
      if (meetingId) {
        const { data: failedMeeting } = await supabase
          .from('reuniones')
          .select('error_mensaje')
          .eq('id', meetingId)
          .maybeSingle()
        message = failedMeeting?.error_mensaje || message
      }
      setProcessingStage('Error')
      setErrors({ submit: `No se pudo procesar la reunión. ${message}` })
      toast.error('No se pudo procesar la reunión')
    } finally {
      setIsUploading(false)
    }
  }

  const FileIcon = file?.type.startsWith('video/') ? FileVideo : FileAudio

  return (
    <div className="mx-auto w-full max-w-7xl space-y-6 p-6 md:p-8">
      <nav aria-label="Breadcrumb" className="flex items-center gap-2 text-sm text-slate-500">
        <Link to="/" className="hover:text-slate-900">Informes</Link>
        <span aria-hidden="true">/</span>
        <span className="text-slate-700">Subir reunión</span>
      </nav>
      <PageHeader title="Subir nueva reunión" />

      <Card className="mx-auto w-full max-w-2xl">
        <CardHeader>
          <CardTitle>Información de la reunión</CardTitle>
          <CardDescription>Sube la grabación para preparar su procesamiento y seguimiento.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} noValidate className="space-y-5">
            <div className="space-y-2">
              <span className="text-sm font-medium text-slate-800">Archivo de audio o video <span className="text-red-600">*</span></span>
              <label
                onDragOver={(event) => { event.preventDefault(); setIsDragging(true) }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={`flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-5 py-6 text-center transition-colors ${isDragging ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 bg-slate-50 hover:border-slate-400 hover:bg-slate-100'} ${errors.file ? 'border-red-300' : ''} ${isUploading ? 'pointer-events-none opacity-60' : ''}`}
              >
                <input
                  ref={inputRef}
                  type="file"
                  accept={ACCEPTED_FILES}
                  disabled={isUploading}
                  onChange={onFileInputChange}
                  className="sr-only"
                  aria-label="Seleccionar archivo de audio o video"
                />
                {file && !errors.file ? (
                  <div className="flex w-full items-center gap-3 text-left">
                    <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700"><FileIcon className="h-5 w-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-800">{file.name}</span>
                      <span className="mt-1 block text-xs text-slate-500">{formatFileSize(file.size)}</span>
                    </span>
                    {!isUploading && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label="Quitar archivo"
                        onClick={(event) => { event.preventDefault(); event.stopPropagation(); selectFile(null); if (inputRef.current) inputRef.current.value = '' }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <UploadCloud className="mb-3 h-8 w-8 text-slate-400" />
                    <span className="text-sm font-medium text-slate-700">Arrastra un archivo aquí o <span className="text-indigo-600">explora</span></span>
                    <span className="mt-1 text-xs text-slate-500">MP3, MP4, M4A, WAV, MOV o WEBM · Máximo 500 MB</span>
                  </>
                )}
              </label>
              {errors.file && <p className="text-xs text-red-600">{errors.file}</p>}
            </div>

            <div className="space-y-2">
              <label htmlFor="meeting-title" className="text-sm font-medium text-slate-800">Título de la reunión <span className="text-red-600">*</span></label>
              <Input id="meeting-title" value={title} disabled={isUploading} onChange={(event) => { setTitle(event.target.value); setErrors((current) => ({ ...current, title: undefined })) }} placeholder="Ej. Sesión ordinaria del comité" aria-invalid={Boolean(errors.title)} />
              {errors.title && <p className="text-xs text-red-600">{errors.title}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="meeting-date" className="text-sm font-medium text-slate-800">Fecha <span className="text-red-600">*</span></label>
                <Input id="meeting-date" type="date" max={localToday()} value={date} disabled={isUploading} onChange={(event) => { setDate(event.target.value); setErrors((current) => ({ ...current, date: undefined })) }} aria-invalid={Boolean(errors.date)} />
                {errors.date && <p className="text-xs text-red-600">{errors.date}</p>}
              </div>
              <div className="space-y-2">
                <label htmlFor="meeting-source" className="text-sm font-medium text-slate-800">Fuente</label>
                <Select value={source} onValueChange={(value: FuenteReunion) => setSource(value)} disabled={isUploading}>
                  <SelectTrigger id="meeting-source" aria-label="Fuente de la reunión"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="teams_manual">Teams</SelectItem>
                    <SelectItem value="zoom">Zoom</SelectItem>
                    <SelectItem value="presencial">Presencial</SelectItem>
                    <SelectItem value="upload">Otro</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <label htmlFor="meeting-start" className="text-sm font-medium text-slate-800">Hora de inicio</label>
                <Input id="meeting-start" type="time" value={startTime} disabled={isUploading} onChange={(event) => { setStartTime(event.target.value); setErrors((current) => ({ ...current, time: undefined })) }} aria-invalid={Boolean(errors.time)} />
              </div>
              <div className="space-y-2">
                <label htmlFor="meeting-end" className="text-sm font-medium text-slate-800">Hora de fin</label>
                <Input id="meeting-end" type="time" value={endTime} disabled={isUploading} onChange={(event) => { setEndTime(event.target.value); setErrors((current) => ({ ...current, time: undefined })) }} aria-invalid={Boolean(errors.time)} />
                {errors.time && <p className="text-xs text-red-600 sm:col-span-2">{errors.time}</p>}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-800">Comité <span className="text-red-600">*</span></label>
              <Select value={committeeId} onValueChange={(value) => { setCommitteeId(value); setErrors((current) => ({ ...current, committee: undefined })) }} disabled={isUploading || committeesLoading || committeesError}>
                <SelectTrigger aria-label="Comité de la reunión" aria-invalid={Boolean(errors.committee)}>
                  <SelectValue placeholder={committeesLoading ? 'Cargando comités…' : 'Selecciona un comité'} />
                </SelectTrigger>
                <SelectContent>
                  {committees.map((committee) => <SelectItem key={committee.id} value={committee.id}>{committee.nombre}</SelectItem>)}
                </SelectContent>
              </Select>
              {errors.committee && <p className="text-xs text-red-600">{errors.committee}</p>}
              {committeesError && <p className="text-xs text-red-600">No se pudieron cargar los comités.</p>}
            </div>

            {errors.submit && <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-700">{errors.submit}</p>}

            <div className="flex justify-end border-t border-slate-100 pt-4">
              <Button type="submit" disabled={isUploading || committeesLoading || committeesError} className="min-w-44">
                {isUploading ? <><LoaderCircle className="h-4 w-4 animate-spin" /> {processingStage || 'Procesando...'}</> : <><UploadCloud className="h-4 w-4" /> Subir y procesar</>}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default Upload
