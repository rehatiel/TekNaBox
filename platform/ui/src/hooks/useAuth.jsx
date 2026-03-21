import { createContext, useContext, useState, useCallback } from 'react'
import { api, setToken, clearToken, getToken, getOperator, setOperator } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [operator, setOp] = useState(() => getOperator())
  const [token, setTok] = useState(() => getToken())

  const setAuth = useCallback((token, op) => {
    setToken(token)
    setOperator(op)
    setTok(token)
    setOp(op)
  }, [])

  const login = useCallback(async (email, password) => {
    const data = await api.login(email, password)
    if (!data.mfa_required) {
      setAuth(data.access_token, { id: data.operator_id, role: data.role, email })
    }
    return data
  }, [setAuth])

  const logout = useCallback(async () => {
    try { await api.logout() } catch { /* token may already be expired */ }
    clearToken()
    setTok(null)
    setOp(null)
  }, [])

  return (
    <AuthContext.Provider value={{ operator, token, login, logout, setAuth, isSuper: operator?.role === 'super_admin' }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
