import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = 'https://api.parallel.ai';
const API_KEY = process.env.PARALLEL_API_KEY;

// Global lock to prevent multiple SSE connections for same task group
const activeLocks = new Set<string>();
const activeStreams = new Set<string>();
const executingFetches = new Set<string>(); // Track active fetches to Parallel API

// Small helper around fetch that handles JSON request/response + errors
async function apiFetchJson<T = unknown>(
  path: string,
  init: RequestInit & { json?: unknown } = {}
): Promise<T> {
  if (!API_KEY) throw new Error('Missing PARALLEL_API_KEY');
  const { json, headers, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      'x-api-key': API_KEY!,
      'Accept': 'application/json',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: json ? JSON.stringify(json) : init.body,
    cache: 'no-store',
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text)?.error?.message || JSON.parse(text)?.message || text; } catch { }
    throw new Error(`Parallel API ${res.status}: ${msg}`);
  }
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

function buildPrompt(rowCtx: Record<string, unknown>, targetHeaders: string[]): string {
  return [
    'You are completing unknown cells in a spreadsheet row using live web research.',
    'Return only a single flat JSON object whose keys are exactly the target column names. No markdown, no code fences, no extra keys.',
    'Rules:',
    '- Use the latest authoritative sources (official sites/filings/docs/news; LinkedIn for headcount as needed).',
    '- Provide a single concise value per target; if truly unavailable, set the value to null.',
    '- Prefer integers for counts, ISO dates for dates, and short strings otherwise; no units in numeric values.',
    '',
    'Row context (JSON):',
    JSON.stringify(rowCtx, null, 2),
    '',
    'Target columns to fill (exact key names):',
    targetHeaders.map(h => `- ${h}`).join('\n'),
    '',
    'Output: ONLY the JSON object for these keys.',
  ].join('\n');
}

// ---------- POST: create a Task Group, add runs, and return { taskgroup_id, run_map } ----------
export async function POST(req: NextRequest) {
  try {
    if (!API_KEY) return new Response(JSON.stringify({ error: 'Missing PARALLEL_API_KEY' }), { status: 500 });
    const body = await req.json();

    const rows: { row: number; context: Record<string, unknown>; targetHeaders: string[]; targetCols: number[] }[] = body?.rows || [];

    const group = await apiFetchJson<{ taskgroup_id: string }>('/v1beta/tasks/groups', { method: 'POST', json: {} });
    const taskgroup_id = group.taskgroup_id;
    console.log('[POST] Created task group with ID:', taskgroup_id);

    const processor = body?.processor || 'lite';
    console.log('[POST] Using processor:', processor);

    const buildExplicitSchema = (targetHeaders: string[]) => ({
      type: 'json',
      json_schema: {
        type: 'object',
        properties: Object.fromEntries(targetHeaders.map(h => [h, {
          type: 'string',
          description: `Value for ${h} column. Return null if not found.`
        }])),
        required: targetHeaders,
        additionalProperties: false
      }
    });

    const inputs = rows.map((r, index) => ({
      input: buildPrompt(r.context, r.targetHeaders),
      task_spec: { output_schema: buildExplicitSchema(r.targetHeaders) },
      processor,
      metadata: { row: r.row, index }
    }));

    const addRuns = await apiFetchJson<{ run_ids?: string[]; type?: string; error?: { message?: string } }>(
      `/v1beta/tasks/groups/${encodeURIComponent(taskgroup_id)}/runs`,
      { method: 'POST', json: { inputs } }
    );

    if (addRuns.type === 'error' || addRuns.error) {
      console.error('[POST] Error adding runs:', addRuns);
      throw new Error(addRuns.error?.message || 'Failed to add runs to task group');
    }

    const run_ids: string[] = addRuns.run_ids || [];
    console.log(`[POST] Added ${run_ids.length} runs with processor '${processor}'`);

    const run_map = Object.fromEntries(
      run_ids.map((rid, i) => rid && rows[i] ? [rid, {
        row: rows[i].row,
        targetCols: rows[i].targetCols,
        targetHeaders: rows[i].targetHeaders
      }] : []).filter(Boolean)
    );

    return new Response(JSON.stringify({ taskgroup_id, run_map }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: unknown) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'unknown error' }), { status: 500 });
  }
}

async function fetchRunResult(taskgroup_id: string, run_id: string): Promise<unknown> {
  try { return await apiFetchJson(`/v1/tasks/runs/${run_id}/result`, { method: 'GET' }); } 
  catch (err) { console.error(`[fetchRunResult] Error fetching result for ${run_id}:`, err); return null; }
}

// ---------- DELETE: cancel a Task Group ----------
export async function DELETE(req: NextRequest) {
  try {
    if (!API_KEY) return new Response(JSON.stringify({ error: 'Missing PARALLEL_API_KEY' }), { status: 500 });
    const { taskgroup_id } = await req.json();
    if (!taskgroup_id) return new Response(JSON.stringify({ error: 'Missing taskgroup_id' }), { status: 400 });

    console.log('[DELETE] Client-side cancellation acknowledged for task group:', taskgroup_id);
    return new Response(JSON.stringify({ 
      success: true, 
      message: 'Client-side cancellation initiated',
      note: 'Tasks will continue on server but results will not be processed'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err: unknown) {
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : 'Invalid request' }), { status: 400 });
  }
}

// ---------- GET (SSE proxy): stream Task Group events (pass-through) ----------
export async function GET(req: NextRequest) {
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;

  
  if (!API_KEY) return new Response('Missing PARALLEL_API_KEY', { status: 500 });
  
  const taskgroup_id = new URL(req.url).searchParams.get('taskgroup_id');

  if (!taskgroup_id) return new Response('Missing taskgroup_id', { status: 400 });

  const streamUrl = `${API_BASE}/v1beta/tasks/groups/${encodeURIComponent(taskgroup_id)}/events`;


  return new Response(
    new ReadableStream({
      async start(controller) {
        const streamId = `${requestId}-${Math.random().toString(36).substr(2, 4)}`;

        
        // CRITICAL: Lock check INSIDE the ReadableStream to prevent race conditions
        if (activeLocks.has(taskgroup_id)) {
          console.log(`[STREAM ${streamId}] ABORTING - ${taskgroup_id} already locked inside stream`);
          controller.error(new Error('Connection already active'));
          return;
        }
        
        // Lock this task group IMMEDIATELY 
        activeLocks.add(taskgroup_id);

        
        // Execution guard to prevent multiple executions within same stream
        if (activeStreams.has(streamId)) {
          console.log(`[STREAM ${streamId}] DUPLICATE EXECUTION DETECTED - aborting`);
          return;
        }
        activeStreams.add(streamId);
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();

        let isControllerClosed = false, shouldExit = false;
        let isProcessingEvents = false; // Guard against re-entrant event processing
        const processedRunIds = new Set<string>(); // Deduplicate run result fetches
        
        const safeEnqueue = (data: string): boolean => {
          if (isControllerClosed) return false;
          try { 
            controller.enqueue(encoder.encode(data));
            return true;
          }
          catch { isControllerClosed = true; return false; }
        };

        // Send initial connection confirmation and wait for EventSource to be ready
        const connectionEvent = `event: connection\ndata: {"type":"connection","status":"established","taskgroup_id":"${taskgroup_id}"}\n\n`;
        if (!safeEnqueue(connectionEvent)) return;
        
        // Wait for EventSource to be ready
        await new Promise(resolve => setTimeout(resolve, 1000));

        try {
          // Critical: Prevent duplicate fetch to Parallel API
          if (executingFetches.has(taskgroup_id)) {
            console.log(`[STREAM ${streamId}] ABORTING - fetch already in progress for ${taskgroup_id}`);
            controller.error(new Error('Fetch already in progress'));
            return;
          }
          executingFetches.add(taskgroup_id);
          
          // Fetch events from Parallel API
          const response = await fetch(streamUrl, {
            headers: {
              'x-api-key': API_KEY,
              'Accept': 'text/event-stream',
            },
          });

          if (!response.ok) {
            const errorText = await response.text();
            console.error('[SSE] Parallel API error response:', errorText);
            throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
          }

          const reader = response.body?.getReader();
          if (!reader) {
            throw new Error('No response body');
          }

          let buffer = '';
          let chunkCount = 0;
          const processedChunks = new Set<string>(); // Deduplicate chunks

          while (true) {
            const { done, value } = await reader.read();
            chunkCount++;

            if (done) {
              break;
            }

            // Decode and add to buffer
            const decoded = decoder.decode(value, { stream: true });
            const chunkHash = `${decoded.length}-${decoded.substring(0, 50)}`;
            
            if (processedChunks.has(chunkHash)) {
              continue;
            }
            processedChunks.add(chunkHash);
            
            buffer += decoded;

            // Process complete events (separated by double newlines)
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';

            // Prevent re-entrant event processing
            if (isProcessingEvents) {
              console.log(`[STREAM ${streamId}] SKIPPING event processing - already in progress`);
              continue;
            }
            isProcessingEvents = true;

            for (const eventStr of events) {
              if (!eventStr.trim()) continue;

              // Parse the event
              const lines = eventStr.split('\n');
              let eventType = '', eventId = '', eventData: unknown = null;
              for (const line of lines) {
                if (line.startsWith('event: ')) eventType = line.slice(7);
                else if (line.startsWith('id: ')) eventId = line.slice(4);
                else if (line.startsWith('data: ')) {
                  try { eventData = JSON.parse(line.slice(6)); } 
                  catch { eventData = line.slice(6); }
                }
              }

              const data = eventData as Record<string, unknown>;

              // Check if this is a completed task run that needs enrichment
              if (eventType === 'task_run.state' &&
                data?.type === 'task_run.state' &&
                (data?.run as Record<string, unknown>)?.status === 'completed' &&
                (data?.run as Record<string, unknown>)?.run_id &&
                !data?.output) {

                const runId = (data.run as Record<string, unknown>).run_id as string;
                
                // Prevent duplicate processing of the same run
                if (processedRunIds.has(runId)) {
                  continue;
                }
                processedRunIds.add(runId);

                // Fetch result synchronously and send immediately
                try {
                  const result = await fetchRunResult(taskgroup_id, runId) as Record<string, unknown>;
                  if (result?.output) {
                    const enrichedData = { ...data, output: result.output };
                    let enrichedEvent = `event: ${eventType}\n`;
                    if (eventId) enrichedEvent += `id: ${eventId}\n`;
                    enrichedEvent += `data: ${JSON.stringify(enrichedData)}\n\n`;
                    
                    if (!safeEnqueue(enrichedEvent)) return;
                  } else {
                    // Ensure proper SSE formatting with double newline
                    const formattedEvent = eventStr.endsWith('\n\n') ? eventStr : eventStr + '\n\n';
                    if (!safeEnqueue(formattedEvent)) return;
                  }
                } catch (err) {
                  console.error(`[SSE] Error fetching result for ${runId}:`, err);
                  const formattedEvent = eventStr.endsWith('\n\n') ? eventStr : eventStr + '\n\n';
                  if (!safeEnqueue(formattedEvent)) return;
                }
              } else if (eventType === 'task_group_status' &&
                (data?.status as Record<string, unknown>)?.is_active === false) {
                // Task group is complete
                if (!isControllerClosed) {
                  try {
                    controller.enqueue(encoder.encode(eventStr + '\n\n'));
                  } catch (err){
                    console.log('[SSE] Controller closed, stopping stream with error', err);
                    isControllerClosed = true;
                    return;
                  }
                }
                // Mark that we should exit after processing remaining events
                shouldExit = true;
              } else {
                // Ensure proper SSE formatting with double newline
                const formattedEvent = eventStr.endsWith('\n\n') ? eventStr : eventStr + '\n\n';
                if (!safeEnqueue(formattedEvent)) return;
              }
            }

            // Reset processing flag after completing event batch
            isProcessingEvents = false;

            // Check if we should exit after processing this batch
            if (shouldExit && !isControllerClosed) {
              console.log('[SSE] Exiting after task group complete');
              break;
            }
          }

          // Close the controller if not already closed
          if (!isControllerClosed) {
            isControllerClosed = true;
            try {
              controller.close();
            } catch {
              // This is expected if the controller was already closed by the stream
              // Don't log as error since it's a normal condition
              console.log('[SSE] Controller already closed (expected)');
            }
          }
        } catch (error) {
          console.error('[SSE] Stream error:', error);
          if (!isControllerClosed) {
            isControllerClosed = true;
            try {
              controller.error(error);
            } catch {
              // Controller might already be closed, which is fine
              console.log('[SSE] Could not send error to closed controller');
            }
          }
        } finally {
          // Release all locks when stream ends
          activeLocks.delete(taskgroup_id);
          activeStreams.delete(streamId);
          executingFetches.delete(taskgroup_id);
        }
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    }
  );
}