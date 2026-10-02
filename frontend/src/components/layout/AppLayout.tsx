import type { ReactNode } from 'react'
import { Sidebar } from './Sidebar'

type AppLayoutProps = {
  children: ReactNode
}

export function AppLayout({ children }: AppLayoutProps) {
  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="min-w-0 flex-1 overflow-y-auto bg-[#FAFAFA]">
        {children}
      </main>
    </div>
  )
}
