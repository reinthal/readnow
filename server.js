import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import multer from 'multer';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.use(express.static('public'));
app.use(express.json());

// PDF text extraction
app.post('/api/parse-pdf', upload.single('pdf'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  if (req.file.mimetype !== 'application/pdf') {
    return res.status(400).json({ error: 'Only PDF files are supported' });
  }
  try {
    const data = await pdf(req.file.buffer);
    const text = data.text.trim();
    if (!text) {
      return res.status(400).json({ error: 'PDF contains no parseable text. Only text-based PDFs are supported (not scanned images).' });
    }
    res.json({ text });
  } catch (err) {
    console.error('PDF parse error:', err);
    res.status(400).json({ error: 'Failed to parse PDF. Ensure it contains selectable text.' });
  }
});

// Derive word-level timing from character-level alignment data
function extractWordTimings(alignment) {
  if (!alignment) return [];

  // Handle both API response formats
  const chars = alignment.characters || alignment.chars || [];
  let startTimes = alignment.character_start_times_seconds || alignment.charStartTimesMs || [];
  let endTimes = alignment.character_end_times_seconds || alignment.charEndTimesMs || [];

  // Convert ms to seconds if needed
  const isMs = Boolean(alignment.charStartTimesMs);
  if (isMs) {
    startTimes = startTimes.map(t => t / 1000);
    endTimes = endTimes.map(t => t / 1000);
  }

  if (chars.length === 0) return [];

  const words = [];
  let wordStart = 0;
  let wordChars = '';

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') {
      if (wordChars.length > 0) {
        words.push({
          word: wordChars,
          startTime: startTimes[wordStart],
          endTime: endTimes[i - 1],
        });
        wordChars = '';
      }
      wordStart = i + 1;
    } else {
      wordChars += ch;
    }
  }

  // Last word
  if (wordChars.length > 0) {
    words.push({
      word: wordChars,
      startTime: startTimes[wordStart],
      endTime: endTimes[chars.length - 1],
    });
  }

  return words;
}

// WebSocket handler for TTS streaming
wss.on('connection', (ws) => {
  let aborted = false;

  ws.on('close', () => { aborted = true; });
  ws.on('error', () => { aborted = true; });

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    if (msg.action === 'speak') {
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) {
        ws.send(JSON.stringify({ type: 'error', message: 'ELEVENLABS_API_KEY not configured on server' }));
        return;
      }

      const voiceId = msg.voiceId || 'JBFqnCBsd6RMkjVDRZzb';
      const modelId = msg.modelId || 'eleven_multilingual_v2';
      const text = msg.text;

      if (!text || text.trim().length === 0) {
        ws.send(JSON.stringify({ type: 'error', message: 'No text provided' }));
        return;
      }

      try {
        // Use ElevenLabs SDK to create client (validates API key)
        const client = new ElevenLabsClient({ apiKey });

        // Use the streaming-with-timestamps REST endpoint for alignment data.
        // The SDK handles basic streaming, but we need the timestamps variant
        // for word-level synchronization.
        const response = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-with-timestamps`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'xi-api-key': apiKey,
            },
            body: JSON.stringify({
              text,
              model_id: modelId,
              output_format: 'mp3_44100_128',
            }),
          }
        );

        if (!response.ok) {
          const errBody = await response.text();
          console.error('ElevenLabs API error:', response.status, errBody);
          ws.send(JSON.stringify({
            type: 'error',
            message: `ElevenLabs API error: ${response.status}`,
          }));
          return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim() || aborted) continue;
            try {
              const chunk = JSON.parse(line);

              // Forward audio chunk
              if (chunk.audio_base64) {
                ws.send(JSON.stringify({
                  type: 'audio',
                  audio: chunk.audio_base64,
                }));
              }

              // Forward word-level timing derived from alignment
              const alignment = chunk.alignment || chunk.normalizedAlignment;
              if (alignment) {
                const wordTimings = extractWordTimings(alignment);
                if (wordTimings.length > 0) {
                  ws.send(JSON.stringify({
                    type: 'timing',
                    words: wordTimings,
                  }));
                }
              }
            } catch {
              // skip malformed JSON lines
            }
          }
        }

        if (!aborted) {
          ws.send(JSON.stringify({ type: 'done' }));
        }
      } catch (err) {
        console.error('TTS streaming error:', err);
        if (!aborted) {
          ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`ReadNow server running at http://localhost:${PORT}`);
});
