import { Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import Dashboard from '@/pages/Dashboard'
import Comites from '@/pages/Comites'
import Configuracion from '@/pages/Configuracion'
import Informes from '@/pages/Informes'
import MeetingDetail from '@/pages/MeetingDetail'
import Reuniones from '@/pages/Reuniones'
import Upload from '@/pages/Upload'

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
