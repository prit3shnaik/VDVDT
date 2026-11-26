import { RouterProvider } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { router } from './app/router'
import { AuthProvider } from './hooks/useAuth'

function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
      <Toaster
        position="top-right"
        toastOptions={{
          duration: 3000,
          style: {
            fontFamily: 'Inter, Segoe UI, sans-serif',
            borderRadius: '8px',
            border: '1px solid var(--line)',
            background: '#ffffff',
            color: 'var(--ink)',
            boxShadow: '0 16px 40px rgba(15, 23, 42, 0.12)',
          },
        }}
      />
    </AuthProvider>
  )
}

export default App
