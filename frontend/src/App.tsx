import { Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { PageHeader } from '@/components/layout/PageHeader'
import Dashboard from '@/pages/Dashboard'
import Comites from '@/pages/Comites'
import Configuracion from '@/pages/Configuracion'
import Informes from '@/pages/Informes'
import MeetingDetail from '@/pages/MeetingDetail'
import Reuniones from '@/pages/Reuniones'
import Upload from '@/pages/Upload'

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="mx-auto w-full max-w-7xl p-6 md:p-8">
      <PageHeader title={title} />
      <section className="mt-8 rounded-xl border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">
        {title}
      </section>
    </div>
  )
}

function App() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/reuniones" element={<Reuniones />} />
        <Route path="/reuniones/:id" element={<MeetingDetail />} />
        <Route path="/informes" element={<Informes />} />
        <Route path="/comites" element={<Comites />} />
        <Route path="/subir" element={<Upload />} />
        <Route path="/configuracion" element={<Configuracion />} />
      </Routes>
    </AppLayout>
  )
}

export default App
