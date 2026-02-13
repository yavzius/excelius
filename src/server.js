// HTTP server wrapping the pipeline.
// POST /api/process streams SSE events as the pipeline runs.

const { Hono } = require('hono');
const { serveStatic } = require('hono/bun');
const { runPipeline } = require('./pipeline');

const app = new Hono();

// Health check
app.get('/api/health', (c) => c.json({ status: 'ok' }));

// Pipeline endpoint — streams SSE events
app.post('/api/process', async (c) => {
  const formData = await c.req.formData();
  const apiKey = formData.get('apiKey');
  const prompt = formData.get('prompt');

  if (!apiKey || !prompt) {
    return c.json({ error: 'Missing apiKey or prompt' }, 400);
  }

  // Extract uploaded files
  const files = [];
  for (const [key, value] of formData.entries()) {
    if (key === 'files' && value instanceof File) {
      const arrayBuffer = await value.arrayBuffer();
      files.push({ name: value.name, buffer: Buffer.from(arrayBuffer) });
    }
  }

  if (files.length === 0) {
    return c.json({ error: 'No files uploaded' }, 400);
  }

  // Stream SSE response
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      function send(event, data) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }

      try {
        const result = await runPipeline({
          apiKey, files, prompt,
          onEvent: (e) => send('phase', e),
        });

        // Send final result with buffer as base64
        send('complete', {
          filename: result.output.filename,
          buffer: result.output.buffer.toString('base64'),
          code: result.code.code,
          explanation: result.code.explanation,
          report: result.report,
          logs: result.output.logs,
          meta: result.meta,
        });
      } catch (err) {
        send('error', { message: err.message });
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
});

// Static files — explicit routes so they don't intercept /api/*
app.get('/', serveStatic({ path: './index.html' }));
app.get('/index.html', serveStatic({ path: './index.html' }));
app.get('/app.js', serveStatic({ path: './app.js' }));

const port = process.env.PORT || 3000;
console.log(`Excelius server running on http://localhost:${port}`);
export default { port, fetch: app.fetch };
