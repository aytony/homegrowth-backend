// src/index.js — Home Growth OS AI Agent Backend
// Uses sql.js (no C++ required) + Google Gemini 2.0 Flash (free)

import express from 'express';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import { getDb, dbGet, dbAll, dbRun } from './db.js';
import { retrieveKnowledge, getAllDocs } from './knowledge.js';

const app = express();
const PORT = 3001;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse&key=${GEMINI_API_KEY}`;

// Multer — store uploads in memory (no disk needed)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
  fileFilter: (req, file, cb) => {
    if (file.originalname.match(/\.(pdf|doc|docx|txt|png|jpg|jpeg|gif|webp|mp4|mov|avi|mkv|webm|mp3|m4a|wav)$/i) ||
        file.mimetype.match(/^(application\/(pdf|msword)|application\/vnd\.openxmlformats|text\/plain|image\/|video\/|audio\/)/)
    ) {
      cb(null, true);
    } else {
      cb(new Error('Supported: PDF, Word, TXT, images (PNG/JPG/WebP/GIF), videos (MP4/MOV/AVI), audio (MP3/WAV)'));
    }
  }
});

// CORS — allow all origins so the widget works on any local or remote website
app.use(cors({
  origin: true,
  credentials: true,
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
app.options('*', cors());
app.use(express.json({ limit: '10mb' }));

// ─── HEALTH ────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  await getDb();
  res.json({ status: 'ok', model: 'gemini-1.5-flash (free)', apiKeySet: !!GEMINI_API_KEY });
});

// ─── CHAT ──────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, sessionId, clientId = 'demo', jurisdiction } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'paste-your-gemini-key-here') {
    return res.status(500).json({ error: 'Add GEMINI_API_KEY to backend/.env and restart.' });
  }

  await getDb();

  // Get or create session
  let session = sessionId ? dbGet('SELECT * FROM chat_sessions WHERE id = ?', [sessionId]) : null;
  if (!session) {
    const newId = uuidv4();
    dbRun('INSERT INTO chat_sessions (id, client_id) VALUES (?, ?)', [newId, clientId]);
    session = { id: newId };
  }

  dbRun('INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)',
    [uuidv4(), session.id, 'user', message]);

  // Run knowledge + history fetch
  const sources = await retrieveKnowledge(message, { clientId, jurisdiction, limit: 5 });
  const history = dbAll(
    'SELECT role, content FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC LIMIT 10',
    [session.id]
  );

  const knowledgeContext = sources.length > 0
    ? sources.map((s, i) =>
        `[SOURCE ${i+1} — ${s.tier.toUpperCase()}${s.jurisdiction ? ' · ' + s.jurisdiction.toUpperCase() : ''}]\nTitle: ${s.title}\n${s.content.slice(0, 3000)}`
      ).join('\n\n---\n\n')
    : null;

  const systemPrompt = knowledgeContext
    ? `You are the Home Growth OS AI Assistant. You MUST ONLY answer using the knowledge sources below. Never use your general training knowledge under any circumstances.

ACTIVE KNOWLEDGE SOURCES FOR THIS QUESTION:
${knowledgeContext}

STRICT RULES — YOU MUST FOLLOW ALL OF THESE:
1. ONLY use facts from the sources above. Zero exceptions.
2. Do NOT add any information not explicitly stated in the sources.
3. If the sources do not answer the question, respond with: "I don't have enough information in my knowledge base to answer this. Please ask your administrator to add relevant documents in the Admin CMS."
4. Always cite sources (e.g. "According to SOURCE 1...").
5. For regulations, always state the jurisdiction and effective date from the source.
6. End every regulation answer with: "Please consult a licensed attorney for legal advice."
7. If someone asks about a topic not covered in the sources, say so — do not answer from memory.`
    : `You are the Home Growth OS AI Assistant.

No relevant knowledge was found in the knowledge base for this question.

You MUST respond with exactly this message and nothing else:
"I don't have information about this topic in my knowledge base yet. Please ask your administrator to add relevant documents using the KB Builder tab, or try rephrasing your question with different keywords."`;

  // IMPORTANT: Include system prompt on EVERY message, not just the first.
  // This ensures Gemini always knows it must stay within the knowledge base.
  const contents = [];

  // Add conversation history (excluding the current message)
  for (const msg of history.slice(-7, -1)) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    });
  }

  // Always prepend system prompt to the current user message
  contents.push({
    role: 'user',
    parts: [{ text: `${systemPrompt}\n\n---\n\nUser question: ${message}` }]
  });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.write(`data: ${JSON.stringify({ type: 'meta', sessionId: session.id, sources: sources.map(s => ({ id: s.id, title: s.title, tier: s.tier, jurisdiction: s.jurisdiction })) })}\n\n`);

  let fullResponse = '';
  try {
    const geminiRes = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: 2048, temperature: 0.3 } })
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`Gemini API error ${geminiRes.status}:`, errText);
      throw new Error(`Gemini ${geminiRes.status}: ${errText.slice(0, 200)}`);
    }

    const reader = geminiRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const jsonStr = line.slice(6).trim();
        if (!jsonStr || jsonStr === '[DONE]') continue;
        try {
          const text = JSON.parse(jsonStr)?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (text) { fullResponse += text; res.write(`data: ${JSON.stringify({ type: 'text', text })}\n\n`); }
        } catch {}
      }
    }

    dbRun('INSERT INTO chat_messages (id, session_id, role, content, sources) VALUES (?, ?, ?, ?, ?)',
      [uuidv4(), session.id, 'assistant', fullResponse, JSON.stringify(sources.map(s => s.id))]);
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
    res.end();
  } catch (err) {
    console.error('Gemini error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
    res.end();
  }
});

// ─── KNOWLEDGE — GET ALL ───────────────────────────────────────────
app.get('/api/knowledge', async (req, res) => {
  await getDb();
  try {
    const docs = await getAllDocs({ tier: req.query.tier, status: req.query.status });
    res.json(docs);
  } catch (err) {
    console.error('GET knowledge error:', err.message);
    res.json([]);
  }
});

// ─── KNOWLEDGE — CREATE ────────────────────────────────────────────
app.post('/api/knowledge', async (req, res) => {
  await getDb();
  const doc = req.body;
  const id = uuidv4();

  // Convert empty strings to null for optional fields
  const clean = (v) => (v && String(v).trim() !== '') ? String(v).trim() : null;
  const validStatuses = ['active', 'retired', 'draft'];
  const status = validStatuses.includes(doc.status) ? doc.status : 'active';

  if (!doc.title || !doc.content || !doc.tier) {
    return res.status(400).json({ error: 'title, content and tier are required' });
  }

  try {
    dbRun(
      `INSERT INTO knowledge_docs
        (id, title, content, tier, category, jurisdiction, client_id, status, effective_date, expiry_date, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, doc.title.trim(), doc.content.trim(), doc.tier,
       clean(doc.category), clean(doc.jurisdiction), clean(doc.client_id),
       status, clean(doc.effective_date), clean(doc.expiry_date), 1]
    );
    console.log(`✓ Saved: "${doc.title}" [${doc.tier}/${status}]`);
    res.json({ id, success: true });
  } catch (err) {
    console.error('POST knowledge error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── KNOWLEDGE — UPDATE ────────────────────────────────────────────
app.patch('/api/knowledge/:id', async (req, res) => {
  await getDb();
  const clean = (v) => (v && String(v).trim() !== '') ? String(v).trim() : null;
  const fieldMap = {
    status: (v) => ['active','retired','draft'].includes(v) ? v : null,
    title: (v) => v || null,
    content: (v) => v || null,
    category: clean,
    jurisdiction: clean,
    effective_date: clean,
    expiry_date: clean,
  };

  const sets = [`updated_at = datetime('now')`];
  const params = [];

  for (const [field, transform] of Object.entries(fieldMap)) {
    if (req.body[field] !== undefined) {
      sets.push(`${field} = ?`);
      params.push(transform(req.body[field]));
    }
  }

  params.push(req.params.id);
  try {
    dbRun(`UPDATE knowledge_docs SET ${sets.join(', ')} WHERE id = ?`, params);
    console.log(`✓ Updated doc ${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('PATCH knowledge error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ─── KNOWLEDGE — RETIRE (soft delete) ─────────────────────────────
app.delete('/api/knowledge/:id', async (req, res) => {
  await getDb();
  try {
    dbRun(`UPDATE knowledge_docs SET status = 'retired', updated_at = datetime('now') WHERE id = ?`,
      [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── URL SCRAPER — single page ─────────────────────────────────────
app.post('/api/scrape', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { scrapeUrl } = await import('./scraper.js');
    const result = await scrapeUrl(url);
    console.log(`✓ Scraped: "${result.title}" (${result.wordCount} words)`);
    res.json(result);
  } catch (err) {
    console.error('Scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── URL SCRAPER — index page (get all links) ──────────────────────
app.post('/api/scrape/links', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { scrapeLinks } = await import('./scraper.js');
    const links = await scrapeLinks(url);
    console.log(`✓ Found ${links.length} links on ${url}`);
    res.json({ links });
  } catch (err) {
    console.error('Scrape links error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── URL SCRAPER — deep: follow all links and fetch full content ────
app.post('/api/scrape/deep', async (req, res) => {
  const { url, maxPages = 10 } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { scrapeDeep } = await import('./scraper.js');
    console.log(`Starting deep scrape of ${url} (max ${maxPages} pages)...`);
    const result = await scrapeDeep(url, maxPages);
    console.log(`✓ Deep scrape complete: ${result.results.length} pages, ${result.errors.length} errors`);
    res.json(result);
  } catch (err) {
    console.error('Deep scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── AI KNOWLEDGE BUILDER — single URL ────────────────────────────
// Uses Gemini to intelligently extract regulation content from any URL
app.post('/api/build/url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { buildDocFromUrl } = await import('./builder.js');
    console.log(`Building knowledge from: ${url}`);
    const doc = await buildDocFromUrl(url, GEMINI_API_KEY, GEMINI_MODEL);
    console.log(`✓ Built: "${doc.title}" (${doc.wordCount} words)`);
    res.json(doc);
  } catch (err) {
    console.error('Builder error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── AI KNOWLEDGE BUILDER — get links from index page ─────────────
app.post('/api/build/links', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const { getLinksFromPage } = await import('./builder.js');
    const links = await getLinksFromPage(url);
    console.log(`✓ Found ${links.length} links on ${url}`);
    res.json({ links });
  } catch (err) {
    console.error('Builder links error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── AI KNOWLEDGE BUILDER — bulk build from index page ────────────
app.post('/api/build/index', async (req, res) => {
  const { url, maxPages = 10 } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });
  try {
    const { buildDocsFromIndex } = await import('./builder.js');
    console.log(`Building knowledge from index: ${url} (max ${maxPages} pages)`);
    const result = await buildDocsFromIndex(url, GEMINI_API_KEY, GEMINI_MODEL, maxPages);
    console.log(`✓ Built ${result.results.length} docs, ${result.errors.length} errors`);
    res.json(result);
  } catch (err) {
    console.error('Builder index error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── FILE UPLOAD — PDF / Word / TXT / Image / Video ───────────────
app.post('/api/upload', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      // Multer-specific errors (file too large, wrong type, etc.)
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: `File too large. Maximum size is 10MB per file.` });
      }
      return res.status(400).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY not set' });

  const { originalname, mimetype, buffer } = req.file;
  const ext = (originalname.match(/\.([^.]+)$/)?.[1] || '').toLowerCase();

  const isImage = mimetype.startsWith('image/') || /^(png|jpg|jpeg|gif|webp)$/.test(ext);
  const isVideo = mimetype.startsWith('video/') || /^(mp4|mov|avi|mkv|webm)$/.test(ext);
  const isAudio = mimetype.startsWith('audio/') || /^(mp3|m4a|wav|ogg)$/.test(ext);
  const isPdf   = mimetype === 'application/pdf' || ext === 'pdf';
  const isDocx  = mimetype.includes('wordprocessingml') || /^docx?$/.test(ext);
  const isTxt   = mimetype === 'text/plain' || ext === 'txt';

  const fileSizeKB = Math.round(buffer.length / 1024);
  const fileSizeMB = (buffer.length / (1024 * 1024)).toFixed(1);
  console.log(`Upload: ${originalname} (${fileSizeMB}MB, ${mimetype})`);

  const geminiGenUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  let extractTitle = originalname.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');

  try {

    // ── IMAGE — send to Gemini Vision ──────────────────────────────
    if (isImage) {
      const base64 = buffer.toString('base64');
      const imageMediaType = mimetype.startsWith('image/') ? mimetype : `image/${ext}`;

      const aiRes = await fetch(geminiGenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [
              {
                inline_data: { mime_type: imageMediaType, data: base64 }
              },
              {
                text: `Analyze this image for a property management knowledge base.

Describe in detail:
1. What type of document/image this is (garden spec, memorial spec, floor plan, photo, chart, etc.)
2. All text visible in the image — transcribe it completely if it contains text
3. Key details: measurements, specifications, names, dates, codes, prices
4. Visual layout and what it depicts

Then provide:
- A concise title for this image
- A full knowledge base entry describing everything in this image

Respond in this exact JSON format:
{"title": "...", "content": "..."}`
              }
            ]
          }],
          generationConfig: { maxOutputTokens: 3000, temperature: 0.1 }
        })
      });

      if (!aiRes.ok) throw new Error(`AI Vision failed (${aiRes.status})`);
      const aiData = await aiRes.json();
      const aiText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

      let title = extractTitle;
      let content = `[Image: ${originalname}]\n\nThis entry contains an image uploaded to the knowledge base.`;

      try {
        const jsonMatch = aiText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.title) title = parsed.title;
          if (parsed.content) content = parsed.content;
        }
      } catch {
        if (aiText.length > 50) content = aiText;
      }

      // Store image as base64 data URI so it can be viewed later
      const dataUri = `data:${imageMediaType};base64,${base64}`;
      const fullContent = `${content}\n\n---\n[Image Data]\n${dataUri}`;

      return res.json({
        title,
        content: fullContent,
        jurisdiction: '',
        effectiveDate: '',
        wordCount: content.split(/\s+/).filter(Boolean).length,
        filename: originalname,
        fileType: 'Image',
        previewUrl: dataUri,
        isImage: true,
      });
    }

    // ── VIDEO — extract metadata + generate description ────────────
    if (isVideo || isAudio) {
      const fileType = isVideo ? 'Video' : 'Audio';

      // For videos/audio we can't send the raw binary to Gemini free tier
      // Instead create a rich metadata entry
      const durationNote = fileSizeMB > 10
        ? `File size: ${fileSizeMB}MB`
        : `File size: ${fileSizeMB}MB (short clip)`;

      const content = `# ${extractTitle}

## File Information
- **Type:** ${fileType} file
- **Filename:** ${originalname}
- **Format:** ${ext.toUpperCase()}
- **Size:** ${fileSizeMB}MB

## Description
This ${fileType.toLowerCase()} has been added to the knowledge base. 

To make this ${fileType.toLowerCase()} fully searchable by the AI agent, please edit this document and add:
- A description of what this ${fileType.toLowerCase()} covers
- Key topics, sections, or timestamps
- Any relevant transcription or summary
- Related policies, specifications, or procedures discussed

## Notes
${req.body.notes || `Add notes about this ${fileType.toLowerCase()} here.`}`;

      return res.json({
        title: extractTitle,
        content,
        jurisdiction: '',
        effectiveDate: '',
        wordCount: content.split(/\s+/).filter(Boolean).length,
        filename: originalname,
        fileType,
        isMedia: true,
        note: `${fileType} uploaded. Add a description so the AI agent can find and use this content.`,
      });
    }

    // ── TEXT / DOCUMENT — existing flow ───────────────────────────
    let rawText = '';

    if (isTxt) {
      rawText = buffer.toString('utf8');

    } else if (isDocx) {
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      rawText = result.value;

    } else if (isPdf) {
      try {
        const pdfParse = await import('pdf-parse/lib/pdf-parse.js');
        const data = await pdfParse.default(buffer);
        rawText = data.text;
        if (data.info?.Title) extractTitle = data.info.Title;
      } catch {
        rawText = buffer.toString('utf8').replace(/[^\x20-\x7E\n\r\t]/g, ' ');
        if (rawText.trim().length < 100) {
          return res.status(400).json({
            error: 'Could not extract text from this PDF — it may be a scanned image. Try the Paste Text option instead.'
          });
        }
      }
    }

    if (!rawText || rawText.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract enough text from this file.' });
    }

    // AI clean & structure
    const aiRes = await fetch(geminiGenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text:
`Extract and clean the content from this uploaded document for a property management knowledge base.

Document name: ${originalname}
Extracted text:
---
${rawText.slice(0, 15000)}
---

1. Extract ONLY actual content — remove page numbers, headers/footers, table of contents
2. Format with markdown headings (# ## ###)
3. Keep ALL text, numbers, codes, specifications intact
4. Provide a clean short title

Respond in this exact JSON format:
{"title": "...", "content": "..."}`
        }] }],
        generationConfig: { maxOutputTokens: 4096, temperature: 0.1 }
      })
    });

    if (!aiRes.ok) throw new Error(`AI processing failed (${aiRes.status})`);

    const aiData = await aiRes.json();
    const aiText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';

    let title = extractTitle;
    let content = rawText;

    try {
      const jsonMatch = aiText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.title) title = parsed.title;
        if (parsed.content) content = parsed.content;
      }
    } catch {
      if (aiText.length > 100) content = aiText;
    }

    const jurisdiction = detectJurisdictionFromText(content, originalname);
    const effectiveDate = detectEffectiveDateFromText(content);

    console.log(`✓ Processed: "${title}" (${content.split(/\s+/).length} words)`);

    res.json({
      title,
      content: content,
      jurisdiction,
      effectiveDate,
      wordCount: content.split(/\s+/).filter(Boolean).length,
      filename: originalname,
      fileType: isPdf ? 'PDF' : isDocx ? 'Word' : 'Text',
    });

  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function detectJurisdictionFromText(text, filename) {
  const c = (text + filename).slice(0, 1000).toLowerCase();
  if (/california|\.ca\b/i.test(c)) return 'CA';
  if (/new york|\.ny\b/i.test(c))   return 'NY';
  if (/texas|\.tx\b/i.test(c))      return 'TX';
  if (/florida|\.fl\b/i.test(c))    return 'FL';
  if (/federal|usc|cfr\b/i.test(c)) return 'federal';
  return 'CA';
}

function detectEffectiveDateFromText(text) {
  const patterns = [
    /effective\s+(?:date\s*:?\s*)?([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /operative\s+([A-Z][a-z]+\.?\s+\d{1,2},?\s+\d{4})/i,
    /amended\s+(?:in\s+)?(\d{4})/i,
  ];
  for (const p of patterns) {
    const m = text.slice(0, 3000).match(p);
    if (m) {
      if (/^\d{4}$/.test(m[1])) return `${m[1]}-01-01`;
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    }
  }
  return '';
}

// ─── START ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  await getDb();
  console.log('\n🏡 Home Growth OS Agent API');
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Model: ${GEMINI_MODEL}`);
  console.log(`   File upload: ✓ PDF, Word, TXT supported\n`);

});