import { NavLink } from 'react-router-dom'
import {
  Calendar,
  FileSpreadsheet,
  GraduationCap,
  LayoutDashboard,
  Settings,
  Upload,
  Users,
} from 'lucide-react'

const navigation = [
  { label: 'Dashboard', to: '/', icon: LayoutDashboard },
  { label: 'Reuniones', to: '/reuniones', icon: Calendar },
  { label: 'Seguimiento', to: '/seguimiento', icon: FileSpreadsheet },
  { label: 'Comités', to: '/comites', icon: Users },
  { label: 'Subir', to: '/subir', icon: Upload },
  { label: 'Configuración', to: '/configuracion', icon: Settings },
]

export function Sidebar() {
  return (
    <aside className="flex h-screen w-60 shrink-0 flex-col bg-[#0F172A] text-white">
      <div className="px-6 py-6">
        <span className="flex items-center gap-2 text-xl font-bold tracking-tight">
          <GraduationCap aria-hidden="true" className="h-6 w-6" />
          MeetIA
        </span>
      </div>

      <nav aria-label="Navegación principal" className="space-y-1 px-3">
        {navigation.map(({ label, to, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 border-l-[3px] px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'border-[#4F46E5] bg-[#1E293B] text-white'
                  : 'border-transparent text-slate-300 hover:bg-[#1E293B] hover:text-white'
              }`
            }
          >
            <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={1.8} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>

      <div className="mt-auto border-t border-slate-700/70 p-4">
        <div className="flex items-center gap-3">
          <div
            aria-hidden="true"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#4F46E5] text-sm font-semibold text-white"
          >
            AP
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-white">Administrador</p>
            <p className="truncate text-xs text-slate-400">admin@meetia.edu</p>
          </div>
        </div>
      </div>
    </aside>
  )
}
