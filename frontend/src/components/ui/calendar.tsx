import { DayPicker, type DayPickerProps } from 'react-day-picker'
import { cn } from '@/lib/utils'

function Calendar({ className, classNames, ...props }: DayPickerProps) {
  return (
    <DayPicker
      className={cn('p-3', className)}
      classNames={{
        months: 'flex flex-col',
        month: 'space-y-4',
        month_caption: 'relative flex h-9 items-center justify-center px-10',
        caption_label: 'text-sm font-semibold capitalize',
        nav: 'absolute inset-x-0 top-0 flex items-center justify-between',
        button_previous: 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
        button_next: 'inline-flex h-8 w-8 items-center justify-center rounded-md border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500',
        month_grid: 'w-full border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-center text-[0.75rem] font-normal text-slate-500',
        week: 'mt-1 flex w-full',
        day: 'relative h-9 w-9 p-0 text-center text-sm',
        day_button: 'inline-flex h-9 w-9 items-center justify-center rounded-md p-0 font-normal text-slate-800 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:pointer-events-none disabled:opacity-40',
        selected: 'bg-indigo-600 text-white hover:bg-indigo-600 hover:text-white',
        range_start: 'rounded-l-md bg-indigo-600 text-white',
        range_end: 'rounded-r-md bg-indigo-600 text-white',
        range_middle: 'bg-indigo-50 text-indigo-950',
        today: 'font-bold text-indigo-700',
        outside: 'text-slate-400 opacity-50',
        disabled: 'text-slate-300 opacity-40',
        ...classNames,
      }}
      {...props}
    />
  )
}

export { Calendar }
