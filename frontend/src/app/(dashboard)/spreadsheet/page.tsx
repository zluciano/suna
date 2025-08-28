'use client';

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import Spreadsheet from 'react-spreadsheet';
import './spreadsheet.css';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { toast } from 'sonner';
import { Loader2, Sparkles, Plus, Minus, Keyboard } from 'lucide-react';
import { cn } from '@/lib/utils';

type Point = { row: number; column: number };
type Range = { start: Point; end: Point };
type Cell = { value: string | number | ''; readOnly?: boolean; className?: string };
type RunMapEntry = { row: number; targetCols: number[]; targetHeaders: string[] };
type RunMap = Record<string, RunMapEntry>;

// Processor options with descriptions
const PROCESSORS = [
  { value: 'lite', label: 'Lite', description: 'Basic information retrieval' },
  { value: 'base', label: 'Base', description: 'Simple web research' },
  { value: 'core', label: 'Core', description: 'Complex web research' },
  { value: 'pro', label: 'Pro', description: 'Exploratory web research' }
];

// Helper to normalize headers for fuzzy matching
function norm(s: string) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim();
}

// Global deduplication - survives React Strict Mode re-renders with atomic locking
const globalActiveConnections = new Map<string, { locked: boolean; timestamp: number }>();

// Atomic lock function to prevent race conditions
function atomicLock(taskGroupId: string): boolean {
  const existing = globalActiveConnections.get(taskGroupId);
  if (existing && existing.locked) {
    return false; // Already locked
  }
  
  // Set lock immediately
  globalActiveConnections.set(taskGroupId, { locked: true, timestamp: Date.now() });
  return true; // Successfully acquired lock
}

function atomicUnlock(taskGroupId: string): void {
  globalActiveConnections.delete(taskGroupId);
}

export default function SpreadsheetPage() {
  // Check for React Strict Mode double execution
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  // Initial data with some sample companies
  const [data, setData] = useState<Cell[][]>([
    [{ value: 'Company' }, { value: 'Stage' }, { value: 'Employee Count' }],
    [{ value: 'Mintlify' }, { value: '' }, { value: '' }],
    [{ value: 'Etched' }, { value: '' }, { value: '' }],
    [{ value: 'LangChain' }, { value: '' }, { value: '' }],
    [{ value: 'Mixpanel' }, { value: '' }, { value: '' }],
    [{ value: 'Octolane AI' }, { value: '' }, { value: '' }],
    [{ value: 'Cognition AI' }, { value: '' }, { value: '' }],
    [{ value: 'Mercor' }, { value: '' }, { value: '' }],
    [{ value: 'Browserbase' }, { value: '' }, { value: '' }],
    [{ value: 'Supabase' }, { value: '' }, { value: '' }],
    [{ value: 'Martian' }, { value: '' }, { value: '' }],
  ]);

  const [range, setRange] = useState<Range | null>(null);
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [processor, setProcessor] = useState('lite');
  const [successCount, setSuccessCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [lastEnrichTime, setLastEnrichTime] = useState<number | null>(null);
  const [initialPendingCount, setInitialPendingCount] = useState<number>(0);
  const [flashCells, setFlashCells] = useState<Set<string>>(new Set());
  const esRef = useRef<EventSource | null>(null);
  const successCountRef = useRef(0);
  const errorCountRef = useRef(0);
  const initialPendingCountRef = useRef(0);
  const [liveMessage, setLiveMessage] = useState('');
  const [currentTaskGroupId, setCurrentTaskGroupId] = useState<string | null>(null);
  const currentTaskGroupIdRef = useRef<string | null>(null);


  const lastConnectionTime = useRef<number>(0);
  const isConnecting = useRef<boolean>(false);
  const activeTaskGroupId = useRef<string | null>(null);
  const isEnrichmentInProgress = useRef<boolean>(false);

  const dataRef = useRef(data);
  const syncRef = <T,>(ref: React.MutableRefObject<T>, value: T) => { ref.current = value; };

  useEffect(() => { syncRef(dataRef, data); }, [data]);
  useEffect(() => { syncRef(successCountRef, successCount); }, [successCount]);
  useEffect(() => { syncRef(errorCountRef, errorCount); }, [errorCount]);
  useEffect(() => { syncRef(initialPendingCountRef, initialPendingCount); }, [initialPendingCount]);
  useEffect(() => { 
    currentTaskGroupIdRef.current = currentTaskGroupId; 
  }, [currentTaskGroupId]);

  // Ensure any open EventSource is closed when the component unmounts
  useEffect(() => {
    return () => {
      if (esRef.current) {
        try { esRef.current.close(); } catch { }
        esRef.current = null;
      }
    };
  }, []);

  // Header helpers
  const headers = useMemo(() => (data[0] || []).map((c) => (c?.value ?? '').toString()), [data]);
  const headerIndex: Record<string, number> = useMemo(() => {
    const map: Record<string, number> = {};
    headers.forEach((h, i) => (map[norm(h)] = i));
    return map;
  }, [headers]);

  // Pending state management
  const cellKey = useCallback((p: Point) => `${p.row}:${p.column}`, []);

  const addPending = useCallback((cells: Point[]) =>
    setPending(prev => {
      const next = new Set(prev);
      cells.forEach(p => next.add(`${p.row}:${p.column}`));
      return next;
    }), []);

  const clearPending = useCallback((cells: Point[]) =>
    setPending(prev => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      cells.forEach(p => next.delete(`${p.row}:${p.column}`));
      return next;
    }), []);

  const isPending = (r: number, c: number) => pending.has(`${r}:${c}`);

  // Selection handler
  const onSelect = useCallback(
    (selected: unknown) => {
      try {
        const selectionType = selected?.constructor?.name || '';
        if (selectionType === 'EmptySelection') return;

        const sel = selected as { toRange?: (data: Cell[][]) => Range | null };
        const r = sel?.toRange?.(data);

        if (r?.start && r?.end) {
          const maxRow = data.length - 1;
          const maxCol = (data[0] || []).length - 1;
          const start: Point = {
            row: Math.max(0, Math.min(maxRow, r.start.row)),
            column: Math.max(0, Math.min(maxCol, r.start.column)),
          };
          const end: Point = {
            row: Math.max(0, Math.min(maxRow, r.end.row)),
            column: Math.max(0, Math.min(maxCol, r.end.column)),
          };
          const normRange: Range = {
            start: { row: Math.min(start.row, end.row), column: Math.min(start.column, end.column) },
            end: { row: Math.max(start.row, end.row), column: Math.max(start.column, end.column) },
          };
          setRange(normRange);
        }
      } catch (error) {
        console.error('Error in onSelect:', error);
        toast.error('Error selecting cells');
      }
    },
    [data]
  );

  // Add row function
  const addRow = useCallback(() => {
    setData(prev => {
      const newRow = new Array(prev[0]?.length || 3).fill({ value: '' });
      return [...prev, newRow];
    });
    toast.success('Row added');
  }, []);

  // Add column function
  const addColumn = useCallback(() => {
    setData(prev => prev.map(row => [...row, { value: '' }]));
    toast.success('Column added');
  }, []);

  // Delete row function
  const deleteRow = useCallback(() => {
    if (!range || range.start.row === 0) {
      toast.error('Cannot delete header row');
      return;
    }
    
    setData(prev => {
      const newData = [...prev];
      newData.splice(range.start.row, 1);
      return newData;
    });
    setRange(null);
    toast.success('Row deleted');
  }, [range]);

  // Delete column function
  const deleteColumn = useCallback(() => {
    if (!range) {
      toast.error('No column selected');
      return;
    }
    
    setData(prev => prev.map(row => {
      const newRow = [...row];
      newRow.splice(range.start.column, 1);
      return newRow;
    }));
    setRange(null);
    toast.success('Column deleted');
  }, [range]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        switch (e.key) {
          case 'k':
            e.preventDefault();
            addColumn();
            break;
          case 'j':
            e.preventDefault();
            addRow();
            break;
          case 'Enter':
            e.preventDefault();
            handleEnrich();
            break;
          case 'Backspace':
            e.preventDefault();
            if (range) {
              if (range.start.row === range.end.row) {
                deleteRow();
              } else {
                deleteColumn();
              }
            }
            break;
        }
      } else if (e.key === 'Escape') {
        setRange(null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addColumn, addRow, deleteRow, deleteColumn, range]);

  // Apply enrichment results
  const applyRowResult = useCallback(
    (row: number, content: unknown, targetHeaders?: string[], targetCols?: number[]) => {
      const obj: Record<string, unknown> =
        content && typeof content === 'object' && !Array.isArray(content)
          ? content as Record<string, unknown>
          : {};

      setData((prev) => {
        const next = prev.map((rowArr) => rowArr.slice());
        
        if (targetHeaders && targetCols) {
          targetHeaders.forEach((header, i) => {
            const col = targetCols[i];
            if (col !== undefined && next[row] && col < next[row].length) {
              const value = obj["content"] ? obj["content"][header] : obj[header];
              next[row][col] = { 
                value: value !== null && value !== undefined && value !== '' && value !== 'null' && value !== 'undefined' ? String(value) : '',
                className: 'success-flash'
              };
            }
          });
        }

        return next;
      });

      // Flash animation
      if (targetCols) {
        const flashKeys = targetCols.map(col => `${row}:${col}`);
        setFlashCells(prev => new Set([...prev, ...flashKeys]));
        setTimeout(() => {
          setFlashCells(prev => {
            const next = new Set(prev);
            flashKeys.forEach(key => next.delete(key));
            return next;
          });
        }, 1000);
      }
    },
    []
  );

  // SSE Connection with retry logic
  const createSSEConnection = useCallback((taskGroupId: string, runMap: Record<string, any>, attempt = 0) => {
    const maxRetries = 3;
    const baseDelay = 1000; // 1 second base delay
    const now = Date.now();
    
    // CRITICAL: Atomic global deduplication that survives React Strict Mode
    if (attempt === 0) {
      // Atomic lock acquisition - prevents all race conditions
      if (!atomicLock(taskGroupId)) {
        console.log(`[SSE] GLOBAL BLOCK: ${taskGroupId} already locked - render ${renderCountRef.current}`);
        return;
      }
      console.log(`[SSE] GLOBAL LOCK ACQUIRED: ${taskGroupId} - render ${renderCountRef.current}`);
      
      // Additional local checks (kept for safety)
      if (activeTaskGroupId.current === taskGroupId) {
        console.log('[SSE] Already processing this task group, skipping connection creation');
        return;
      }
      
      if (currentTaskGroupIdRef.current === taskGroupId && esRef.current) {
        console.log('[SSE] Already connected to this task group, skipping connection creation');
        return;
      }
      
      if (isConnecting.current) {
        console.log('[SSE] Connection already in progress, skipping');
        return;
      }
      
      if (now - lastConnectionTime.current < 2000) {
        console.log('[SSE] Debouncing connection attempt, too soon since last attempt');
        return;
      }
    }
    
    lastConnectionTime.current = now;
    isConnecting.current = true;
    activeTaskGroupId.current = taskGroupId;
    
    console.log(`[SSE] Creating NEW EventSource for ${taskGroupId} at ${new Date().toISOString()}`);
    const eventSource = new EventSource(`/api/spreadsheet/parallel?taskgroup_id=${encodeURIComponent(taskGroupId)}`);
    esRef.current = eventSource;
    console.log(`[SSE] EventSource created at ${new Date().toISOString()}, readyState: ${eventSource.readyState}`);

    // Handle server-side duplicate rejection
    eventSource.addEventListener('error', (event) => {
      // Check if this is a 409 (duplicate connection) error
      if (eventSource.readyState === EventSource.CLOSED && eventSource.url.includes(taskGroupId)) {
        console.log('[SSE] Server rejected duplicate connection, this is expected');
        return;
      }
    });

    let hasReceivedData = false;
    let connectionTimeout: ReturnType<typeof setTimeout>;
    let isNormalCompletion = false; // Track if stream ended normally

    eventSource.onopen = () => {
      console.log(`[SSE] Connection opened at ${new Date().toISOString()}`);
      hasReceivedData = true;
      isConnecting.current = false;
      // setConnectionStatus('connected');
      // setRetryCount(0);
      clearTimeout(connectionTimeout);
      
      if (attempt > 0) {
        toast.success('Connection restored');
      }
    };

    eventSource.onmessage = (event) => {
      hasReceivedData = true;
      clearTimeout(connectionTimeout);
      console.log(`[SSE] Message received at ${new Date().toISOString()}:`, event.data);
      
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === 'connection' && data.status === 'established') {
          console.log(`[SSE] Connection confirmation received for ${data.taskgroup_id}`);
          // setConnectionStatus('connected');
          return; // Don't process further
        } else if (data.type === 'task_run.state' && data.run?.status === 'completed' && data.output) {
          const runId = data.run.run_id;
          const runInfo = runMap[runId];
          
          if (runInfo) {
            applyRowResult(runInfo.row, data.output, runInfo.targetHeaders, runInfo.targetCols);
            
            // Clear pending cells for this run
            const completedCells = runInfo.targetCols.map((col: number) => ({ row: runInfo.row, column: col }));
            clearPending(completedCells);
            
            setSuccessCount(prev => prev + 1);
            toast.success(`Row ${runInfo.row + 1} enriched successfully`);
          }
          
          // Check if this was an already-completed task (no active runs)
          // If the run is completed and not active, the task group is done
          if (data.run?.is_active === false) {
            console.log('[SSE] Received already-completed task, closing connection normally');
            clearTimeout(connectionTimeout);
            
            // Mark as normal completion to prevent error handler from retrying
            isNormalCompletion = true;
            
            eventSource.close();
            esRef.current = null;
            setBusy(false);
            setCurrentTaskGroupId(null);
            currentTaskGroupIdRef.current = null;
            activeTaskGroupId.current = null;
            isConnecting.current = false;
            isEnrichmentInProgress.current = false;
            // setConnectionStatus('disconnected');
            
            // Release global lock
            atomicUnlock(taskGroupId);
            console.log(`[SSE] GLOBAL UNLOCK: ${taskGroupId} - already-completed task received`);
            
            // Clear any remaining pending cells
            setPending(new Set());
            
            const totalSuccess = successCountRef.current;
            const totalErrors = errorCountRef.current;
            
            console.log(`[SSE] Enrichment completed: ${totalSuccess} successful, ${totalErrors} errors`);
            toast.success(`Enrichment completed: ${totalSuccess} successful, ${totalErrors} errors`);
            
            return; // Exit early to prevent further processing
          }
        } else if (data.type === 'task_run.state' && data.run?.status === 'failed') {
          const runId = data.run.run_id;
          const runInfo = runMap[runId];
          
          if (runInfo) {
            // Clear pending cells for failed run
            const failedCells = runInfo.targetCols.map((col: number) => ({ row: runInfo.row, column: col }));
            clearPending(failedCells);
            
            setErrorCount(prev => prev + 1);
            toast.error(`Row ${runInfo.row + 1} enrichment failed`);
          }
        } else if (data.type === 'task_group_status' && data.status?.is_active === false) {
          // Task group completed - this is NORMAL, not an error
          console.log('[SSE] Task group completed normally, closing connection cleanly');
          clearTimeout(connectionTimeout);
          
          // Mark as normal completion to prevent error handler from retrying
          isNormalCompletion = true;
          
          eventSource.close();
          esRef.current = null;
          setBusy(false);
          setCurrentTaskGroupId(null);
          currentTaskGroupIdRef.current = null;
          activeTaskGroupId.current = null;
          isConnecting.current = false;
          isEnrichmentInProgress.current = false;
          // setConnectionStatus('disconnected');
          
          // Release global lock
          atomicUnlock(taskGroupId);
          console.log(`[SSE] GLOBAL UNLOCK: ${taskGroupId} - task completed normally`);
          
          // Clear any remaining pending cells
          setPending(new Set());
          
          const totalSuccess = successCountRef.current;
          const totalErrors = errorCountRef.current;
          
          if (totalSuccess > 0) {
            toast.success(`Enrichment completed! ${totalSuccess} successful, ${totalErrors} errors`);
          } else {
            toast.error('Enrichment completed with errors');
          }
        }
      } catch (error) {
        console.error('Error parsing SSE event:', error);
      }
    };

    eventSource.onerror = (error) => {
      console.error('[SSE] Error event received:', error);
      console.error('[SSE] EventSource readyState:', eventSource.readyState);
      console.error('[SSE] EventSource url:', eventSource.url);
      clearTimeout(connectionTimeout);
      
      // If this was a normal completion, ignore the error
      if (isNormalCompletion) {
        console.log('[SSE] Ignoring error - stream completed normally');
        return;
      }
      
      // CRITICAL: Close EventSource immediately to prevent automatic retry
      console.log('[SSE] Closing EventSource to prevent automatic browser retry');
      eventSource.close();
      esRef.current = null;
      
      // Check if this is a normal connection closure (readyState 2 = CLOSED)
      if (eventSource.readyState === EventSource.CLOSED) {
        console.log('[SSE] Connection closed by server');
        
        // Check if this might be a 409 (duplicate connection) by checking if we immediately got closed
        if (!hasReceivedData && attempt === 0) {
          console.log('[SSE] Likely duplicate connection rejected by server (409), not retrying');
          // setConnectionStatus('disconnected');
          // Don't retry for duplicate connections
          eventSource.close();
          esRef.current = null;
          activeTaskGroupId.current = null;
          isConnecting.current = false;
          return;
        }
        
        // setConnectionStatus('disconnected');
        
        // Only retry if we haven't received task completion and this is still the active connection
        if (attempt < maxRetries && esRef.current === eventSource) {
          console.log(`[SSE] Attempting retry ${attempt + 1}/${maxRetries}`);
          // setConnectionStatus('reconnecting');
          const delay = baseDelay * Math.pow(2, attempt);
          setTimeout(() => {
            // Check if we should still retry (component not unmounted, still the active connection)
            if (esRef.current === null || esRef.current === eventSource) {
              createSSEConnection(taskGroupId, runMap, attempt + 1);
            } else {
              console.log('[SSE] Skipping retry - connection replaced or component unmounted');
            }
          }, delay);
        } else {
          console.log('[SSE] No more retries - max attempts reached or connection replaced');
        }
      } else if (eventSource.readyState === EventSource.CONNECTING) {
        console.log('[SSE] Still connecting - this is normal during initial connection');
        // setConnectionStatus('connecting');
        // Don't close the connection here, let it continue trying
        return;
      } else {
        // Actual connection error (readyState 0 = CONNECTING with error)
        console.error('[SSE] Actual connection error, readyState:', eventSource.readyState);
        
        if (attempt < maxRetries && esRef.current === eventSource) {
          console.log(`[SSE] Retrying after connection error: ${attempt + 1}/${maxRetries}`);
          // setConnectionStatus('reconnecting');
          const delay = baseDelay * Math.pow(2, attempt);
          setTimeout(() => {
            // Check if we should still retry (component not unmounted, still the active connection)
            if (esRef.current === null || esRef.current === eventSource) {
              createSSEConnection(taskGroupId, runMap, attempt + 1);
            } else {
              console.log('[SSE] Skipping retry - connection replaced or component unmounted');
            }
          }, delay);
        } else {
          console.log('[SSE] Connection failed permanently after all retries');
          // setConnectionStatus('disconnected');
          setBusy(false);
          setCurrentTaskGroupId(null);
          toast.error('Connection failed after multiple retries');
        }
      }
      
      eventSource.close();
      esRef.current = null;
      activeTaskGroupId.current = null;
      isConnecting.current = false;
    };

    return eventSource;
  }, [applyRowResult, clearPending]);

  // Enrich function with full Parallel AI integration
  const handleEnrich = useCallback(async () => {
    if (!range) {
      toast.error('Please select cells to enrich');
      return;
    }

    if (busy || isEnrichmentInProgress.current) {
      toast.error('Enrichment already in progress');
      return;
    }
    
    isEnrichmentInProgress.current = true;

    setBusy(true);
    setSuccessCount(0);
    setErrorCount(0);
    setLastEnrichTime(Date.now());

    try {
      // Build rows for enrichment
      const rows: { row: number; context: Record<string, unknown>; targetHeaders: string[]; targetCols: number[] }[] = [];
      
      for (let r = Math.max(1, range.start.row); r <= range.end.row; r++) {
        const context: Record<string, unknown> = {};
        const targetHeaders: string[] = [];
        const targetCols: number[] = [];

        // Build context from non-empty cells in the row
        for (let c = 0; c < headers.length; c++) {
          const cellValue = data[r]?.[c]?.value;
          const header = headers[c];
          
          if (cellValue && cellValue !== '') {
            context[header] = cellValue;
          } else if (c >= range.start.column && c <= range.end.column) {
            targetHeaders.push(header);
            targetCols.push(c);
          }
        }

        if (targetHeaders.length > 0) {
          rows.push({ row: r, context, targetHeaders, targetCols });
        }
      }

      if (rows.length === 0) {
        toast.error('No empty cells found in selection to enrich');
        setBusy(false);
        return;
      }

      // Add pending cells
      const pendingCells: Point[] = [];
      rows.forEach(row => {
        row.targetCols.forEach(col => {
          pendingCells.push({ row: row.row, column: col });
        });
      });
      
      addPending(pendingCells);
      setInitialPendingCount(pendingCells.length);

      toast.info(`Starting enrichment for ${rows.length} rows with ${pendingCells.length} cells`);

      // Create task group

      const response = await fetch('/api/spreadsheet/parallel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows, processor }),
      });



      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to create enrichment task');
      }

      const { taskgroup_id, run_map } = await response.json();
      setCurrentTaskGroupId(taskgroup_id);
      currentTaskGroupIdRef.current = taskgroup_id;

      // Use fetch-based SSE streaming (EventSource replacement)
      try {
        const sseResponse = await fetch(`/api/spreadsheet/parallel?taskgroup_id=${encodeURIComponent(taskgroup_id)}`);
        
        if (!sseResponse.ok) {
          throw new Error(`HTTP ${sseResponse.status}`);
        }
        
        
        const reader = sseResponse.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }
        
        const decoder = new TextDecoder();
        let buffer = '';
        let successfulRuns = 0;
        let errorRuns = 0;
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;
            
            // Decode chunk and add to buffer
            buffer += decoder.decode(value, { stream: true });
            
            // Process complete events (separated by double newlines)
            const events = buffer.split('\n\n');
            buffer = events.pop() || ''; // Keep incomplete event in buffer
            
            // Process each complete event immediately as it arrives
            for (const eventStr of events) {
              if (!eventStr.trim()) continue;
              
              // Parse SSE format
              const lines = eventStr.split('\n');
              let eventType = '', eventData = null;
              
              for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                else if (line.startsWith('data: ')) {
                  try { eventData = JSON.parse(line.slice(6)); } 
                  catch (e) { /* Ignore parse errors */ }
                }
              }
              
              if (eventData) {
                if (eventData.type === 'task_run.state' && eventData.run?.status === 'completed' && eventData.output) {
                  const runId = eventData.run.run_id;
                  const runInfo = run_map[runId];
                  
                  if (runInfo) {
                    applyRowResult(runInfo.row, eventData.output, runInfo.targetHeaders, runInfo.targetCols);
                    
                    // Clear pending cells for this run immediately as data arrives
                    const completedCells = runInfo.targetCols.map((col: number) => ({ row: runInfo.row, column: col }));
                    clearPending(completedCells);
                    
                    successfulRuns++;
                    setSuccessCount(successfulRuns); // Update count in real-time
                    toast.success(`Row ${runInfo.row + 1} enriched successfully`);
                  }
                } else if (eventData.type === 'task_group_status' && eventData.status?.is_active === false) {
                  // Task group completed
                  break;
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        
        // Clean up
        setBusy(false);
        setCurrentTaskGroupId(null);
        currentTaskGroupIdRef.current = null;
        activeTaskGroupId.current = null;
        isEnrichmentInProgress.current = false;
        // setConnectionStatus('disconnected');
        
        // Update React state with final counts
        setSuccessCount(successfulRuns);
        setErrorCount(errorRuns);
        
        if (successfulRuns > 0) {
          toast.success(`Enrichment completed: ${successfulRuns} successful, ${errorRuns} errors`);
        }
        
      } catch (error) {
        setBusy(false);
        setCurrentTaskGroupId(null);
        currentTaskGroupIdRef.current = null;
        activeTaskGroupId.current = null;
        isEnrichmentInProgress.current = false;
        // setConnectionStatus('disconnected');
        toast.error(error instanceof Error ? error.message : 'Enrichment failed');
      }

    } catch (error) {
      console.error('Enrichment error:', error);
      setBusy(false);
      isEnrichmentInProgress.current = false;
      clearPending([]);
      toast.error(error instanceof Error ? error.message : 'Enrichment failed');
    }
  }, [range, busy, headers, data, processor, addPending, clearPending]);

  const progress = initialPendingCount > 0 
    ? Math.round(((initialPendingCount - pending.size) / initialPendingCount) * 100)
    : 0;

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">AI Spreadsheet</h1>
          <p className="text-muted-foreground">
            Enrich your data with AI-powered research
          </p>
        </div>
        <Badge variant="secondary" className="flex items-center gap-2">
          <Sparkles className="h-4 w-4" />
          Parallel AI Integration
        </Badge>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader>
              <CardTitle>Spreadsheet</CardTitle>
              <CardDescription>
                Select cells and enrich them with AI research
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="spreadsheet-container">
                <Spreadsheet
                  data={data}
                  onChange={setData}
                  onSelect={onSelect}
                  className="w-full"
                />
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Controls</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <label className="text-sm font-medium mb-2 block">
                  Processor
                </label>
                <Select value={processor} onValueChange={setProcessor}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROCESSORS.map((proc) => (
                      <SelectItem key={proc.value} value={proc.value}>
                        <div>
                          <div className="font-medium">{proc.label}</div>
                          <div className="text-xs text-muted-foreground">
                            {proc.description}
                          </div>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Button 
                  onClick={handleEnrich} 
                  disabled={!range || busy}
                  className="w-full"
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Enriching...
                    </>
                  ) : (
                    <>
                      <Sparkles className="mr-2 h-4 w-4" />
                      Enrich Selection
                    </>
                  )}
                </Button>
                
                {busy && (
                  <Button 
                    variant="outline" 
                    onClick={() => {
                      // Cancel current operation
                      if (esRef.current) {
                        esRef.current.close();
                        esRef.current = null;
                      }
                      setBusy(false);
                      setCurrentTaskGroupId(null);
                      currentTaskGroupIdRef.current = null;
                      activeTaskGroupId.current = null;
                      isConnecting.current = false;
                      isEnrichmentInProgress.current = false;
                      // setConnectionStatus('disconnected');
                      setPending(new Set());
                      
                      // Release global lock
                      if (currentTaskGroupId) {
                        atomicUnlock(currentTaskGroupId);
                        console.log(`[SSE] GLOBAL UNLOCK: ${currentTaskGroupId} - cancelled`);
                      }
                      
                      toast.info('Enrichment cancelled');
                    }}
                    className="w-full"
                  >
                    Cancel Enrichment
                  </Button>
                )}
              </div>

              {busy && (
                <div className="space-y-3">

                  {/* Progress */}
                  {pending.size > 0 && (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Progress</span>
                        <span>{progress}%</span>
                      </div>
                      <Progress value={progress} />
                      <div className="text-xs text-muted-foreground text-center">
                        {pending.size} cells remaining
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Button variant="outline" onClick={addRow} className="w-full">
                <Plus className="mr-2 h-4 w-4" />
                Add Row
              </Button>
              <Button variant="outline" onClick={addColumn} className="w-full">
                <Plus className="mr-2 h-4 w-4" />
                Add Column
              </Button>
              {range && (
                <>
                  <Button variant="outline" onClick={deleteRow} className="w-full">
                    <Minus className="mr-2 h-4 w-4" />
                    Delete Row
                  </Button>
                  <Button variant="outline" onClick={deleteColumn} className="w-full">
                    <Minus className="mr-2 h-4 w-4" />
                    Delete Column
                  </Button>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Keyboard className="h-4 w-4" />
                Shortcuts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>⌘K</span>
                <span>Add Column</span>
              </div>
              <div className="flex justify-between">
                <span>⌘J</span>
                <span>Add Row</span>
              </div>
              <div className="flex justify-between">
                <span>⌘↵</span>
                <span>Enrich Selection</span>
              </div>
              <div className="flex justify-between">
                <span>⌘⌫</span>
                <span>Delete Row/Column</span>
              </div>
              <div className="flex justify-between">
                <span>Esc</span>
                <span>Clear Selection</span>
              </div>
            </CardContent>
          </Card>

          {(successCount > 0 || errorCount > 0) && (
            <Card>
              <CardHeader>
                <CardTitle>Statistics</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between">
                  <span>Successful:</span>
                  <Badge variant="default">{successCount}</Badge>
                </div>
                <div className="flex justify-between">
                  <span>Errors:</span>
                  <Badge variant="destructive">{errorCount}</Badge>
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

