import { useEffect, useState } from 'react'
import { addMonths, format, subDays, subMonths } from 'date-fns'
import { es } from 'date-fns/locale'
import { CalendarDays, ChevronDown } from 'lucide-react'
import type { DateRange } from 'react-day-picker'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type DateRangePickerProps = {
  value?: DateRange
  appliedPreset?: string | null
  onChange: (range: DateRange | undefined, presetLabel?: string) => void
  disabled?: boolean
  className?: string
}

const presets = [
  { label: 'En cualquier momento', getRange: () => undefined },
  { label: 'Hoy', getRange: (today: Date): DateRange => ({ from: today, to: today }) },
  { label: 'Últimos 7 días', getRange: (today: Date): DateRange => ({ from: subDays(today, 7), to: today }) },
  { label: 'Últimos 30 días', getRange: (today: Date): DateRange => ({ from: subDays(today, 30), to: today }) },
  { label: 'Últimos 90 días', getRange: (today: Date): DateRange => ({ from: subDays(today, 90), to: today }) },
  { label: 'Últimos 6 meses', getRange: (today: Date): DateRange => ({ from: subMonths(today, 6), to: today }) },
  { label: 'Últimos 12 meses', getRange: (today: Date): DateRange => ({ from: subMonths(today, 12), to: today }) },
]

function rangeLabel(range?: DateRange) {
  if (!range?.from) return 'En cualquier momento'
  const start = format(range.from, 'd MMM', { locale: es })
  if (!range.to) return `Desde ${start}`
  if (format(range.from, 'yyyy-MM-dd') === format(range.to, 'yyyy-MM-dd')) return format(range.from, "d 'de' MMMM, yyyy", { locale: es })
  return `${start} - ${format(range.to, 'd MMM, yyyy', { locale: es })}`
}

export function DateRangePicker({ value, appliedPreset, onChange, disabled, className }: DateRangePickerProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<DateRange | undefined>(value)
  const [draftPreset, setDraftPreset] = useState<string | null>(appliedPreset ?? null)
  const [month, setMonth] = useState(value?.from ?? new Date())

  useEffect(() => {
    if (open) {
      setDraft(value)
      setDraftPreset(appliedPreset ?? null)
      setMonth(value?.from ?? new Date())
    }
  }, [open, value])

  function apply() {
    onChange(draft, draftPreset ?? (draft?.from ? 'Personalizado' : 'En cualquier momento'))
    setOpen(false)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label="Seleccionar rango de fechas"
          className={cn('h-11 w-full justify-between px-3 font-normal', !value?.from && 'text-slate-500', className)}
        >
          <span className="flex min-w-0 items-center gap-2 truncate"><CalendarDays className="h-4 w-4 shrink-0 text-indigo-600" /><span className="truncate">{appliedPreset && appliedPreset !== 'Personalizado' ? appliedPreset : appliedPreset === 'Personalizado' && value?.from ? `Personalizado · ${rangeLabel(value)}` : rangeLabel(value)}</span></span>
          <ChevronDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(94vw,680px)] p-0">
        <div className="flex flex-col md:flex-row">
          <nav aria-label="Rangos de fecha predefinidos" className="grid grid-cols-2 gap-1 border-b p-3 md:w-52 md:shrink-0 md:grid-cols-1 md:border-b-0 md:border-r">
            {presets.map((preset, index) => {
              const active = draftPreset === preset.label || (!draftPreset && index === 0 && !draft?.from)
              return (
                <button
                  key={preset.label}
                  type="button"
                  className={cn('rounded-md px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 sm:text-sm', active && 'bg-indigo-50 font-medium text-indigo-700')}
                  onClick={() => {
                    const nextRange = preset.getRange(new Date())
                    setDraft(nextRange)
                    setDraftPreset(preset.label)
                    if (nextRange?.from) setMonth(nextRange.from)
                  }}
                >
                  {preset.label}
                </button>
              )
            })}
          </nav>
          <div className="min-w-0 flex-1 p-2 sm:p-3">
            <Calendar
              mode="range"
              selected={draft}
              onSelect={(range) => {
                setDraft(range)
                setDraftPreset('Personalizado')
              }}
              month={month}
              onMonthChange={setMonth}
              locale={es}
              weekStartsOn={1}
              startMonth={subMonths(new Date(), 120)}
              endMonth={addMonths(new Date(), 120)}
              className="mx-auto w-fit"
            />
            <div className="flex flex-col-reverse gap-2 border-t p-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-xs text-slate-500">{draftPreset && draftPreset !== 'Personalizado' ? draftPreset : draftPreset === 'Personalizado' ? `Personalizado · ${rangeLabel(draft)}` : rangeLabel(draft)}</p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancelar</Button>
                <Button type="button" size="sm" onClick={apply}>Aplicar</Button>
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
