import { createContext, useContext, useState, useCallback } from 'react'
import { api, setToken, clearToken, getToken, getOperator, setOperator } from '../lib/api'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [operator, setOp] = useState(() => getOperator())
  const [token, setTok] = useState(() => getToken())

  const login = useCallback(async (email, password) => {
    const data = await api.login(email, password)
    setToken(data.access_token)
    setOperator({ id: data.operator_id, role: data.role, email })
    setTok(data.access_token)
    setOp({ id: data.operator_id, role: data.role, email })
    return data
  }, [])

  const logout = useCallback(() => {
    clearToken()
    setTok(null)
    setOp(null)
  }, [])

  return (
    <AuthContext.Provider value={{ operator, token, login, logout, isSuper: operator?.role === 'super_admin' }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
