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
  const startTimes = alignment.character_start_times_seconds || alignment.characterStartTimesSeconds || [];
  const endTimes = alignment.character_end_times_seconds || alignment.characterEndTimesSeconds || [];

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

// Split text into chunks under maxLen, breaking at sentence boundaries
const MAX_TTS_CHARS = 500;

function chunkText(text, maxLen = MAX_TTS_CHARS) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find last sentence-ending punctuation within the limit
    let cut = -1;
    for (let i = maxLen - 1; i >= 0; i--) {
      if (remaining[i] === '.' || remaining[i] === '!' || remaining[i] === '?') {
        cut = i + 1;
        break;
      }
    }
    // Fall back to last space if no sentence boundary found
    if (cut <= 0) {
      cut = remaining.lastIndexOf(' ', maxLen);
    }
    // Hard cut as last resort
    if (cut <= 0) {
      cut = maxLen;
    }
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
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
        const client = new ElevenLabsClient({ apiKey });
        const chunks = chunkText(text);
        let timeOffset = 0;

        for (const chunkText of chunks) {
          if (aborted) break;

          const stream = await client.textToSpeech.streamWithTimestamps(voiceId, {
            text: chunkText,
            modelId,
            outputFormat: 'mp3_44100_128',
          });

          let chunkMaxEnd = 0;

          for await (const item of stream) {
            if (aborted) break;

            if (item.audioBase64) {
              ws.send(JSON.stringify({
                type: 'audio',
                audio: item.audioBase64,
              }));
            }

            const alignment = item.alignment || item.normalizedAlignment;
            if (alignment) {
              const wordTimings = extractWordTimings(alignment);
              if (wordTimings.length > 0) {
                for (const wt of wordTimings) {
                  wt.startTime += timeOffset;
                  wt.endTime += timeOffset;
                  if (wt.endTime > chunkMaxEnd) chunkMaxEnd = wt.endTime;
                }
                ws.send(JSON.stringify({
                  type: 'timing',
                  words: wordTimings,
                }));
              }
            }
          }

          timeOffset = chunkMaxEnd;
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
