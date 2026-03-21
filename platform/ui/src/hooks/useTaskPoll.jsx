/**
 * useTaskPoll — polls a single task by ID until it reaches a terminal state.
 *
 * Usage:
 *   const { status, result, error, cancel } = useTaskPoll(deviceId, taskId, 2500)
 *
 * Returns null values until the first poll completes.
 * Cleans up the interval on unmount automatically.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../lib/api'

const TERMINAL = new Set(['completed', 'failed', 'timeout'])

export function useTaskPoll(deviceId, taskId, intervalMs = 2500) {
  const [status, setStatus]   = useState(null)
  const [result, setResult]   = useState(null)
  const [error, setError]     = useState(null)
  const timerRef              = useRef(null)

  const cancel = useCallback(() => {
    clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  useEffect(() => {
    if (!deviceId || !taskId) return
    cancel()

    timerRef.current = setInterval(async () => {
      try {
        // Fetch by task ID directly when available, fall back to device task list
        let task
        try {
          task = await api.getTask(taskId)
        } catch {
          const tasks = await api.getTasks(deviceId)
          task = tasks.find(t => t.id === taskId)
        }
        if (!task) return
        setStatus(task.status)
        if (TERMINAL.has(task.status)) {
          cancel()
          setResult(task.result ?? null)
          if (task.status !== 'completed') setError(task.error || task.status)
        }
      } catch (e) {
        cancel()
        setError(e.message)
      }
    }, intervalMs)

    return cancel
  }, [deviceId, taskId, intervalMs, cancel])

  return { status, result, error, cancel }
}
