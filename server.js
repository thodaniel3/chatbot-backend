// server.js (robust + auto-process existing bucket files)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// Multer in-memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);




// Stopwords
const STOPWORDS = new Set([
  'the','is','and','a','an','of','to','in','for','on','by','with','that','this','it','are','as','be','or',
  'from','at','which','we','you','your','our','their','has','have','was','were','but','not'
]);

function simpleTokenize(text) {
  if (!text) return [];
  const raw = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const words = raw.split(/\s+/).filter(Boolean);
  return Array.from(new Set(words.filter(w => !STOPWORDS.has(w) && w.length > 2))).slice(0, 2000);
}

// Helper: get public URL safely
function getPublicUrlSafe(bucket, path) {
  try {
    const maybe = supabase.storage.from(bucket).getPublicUrl(path);
    if (maybe && maybe.data && (maybe.data.publicUrl || maybe.data.publicURL)) return maybe.data.publicUrl || maybe.data.publicURL;
    if (maybe && (maybe.publicUrl || maybe.publicURL)) return maybe.publicUrl || maybe.publicURL;
  } catch (e) { console.warn('getPublicUrlSafe warning:', e?.message || e); }
  return '';
}

// Allowed types
const ALLOWED_TYPES = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  csv: 'text/csv',
  txt: 'text/plain'
};

// ===== FILE PROCESSOR (for new or existing files) =====
async function processFile({ buffer, filename, mimetype, uploaded_by = 'system', lecturer_name = '', source_document = '', customKeywords = '' }) {
  // 1) Upload file to storage (if buffer exists)
  let filePath = filename;
  if (buffer) {
    const safeFilename = `${Date.now()}_${filename.replace(/\s+/g, '_')}`;
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('documents')
      .upload(safeFilename, buffer, { contentType: mimetype, upsert: true });

    if (uploadError) {
  console.error("❌ STORAGE UPLOAD FAILED:", uploadError);
  throw uploadError; // stop processing
}

    else filePath = uploadData.path || uploadData.fullPath || safeFilename;
  }

  // 2) Get public URL
  const publicUrl = getPublicUrlSafe('documents', filePath) || '';

  // 3) Extract text
  let extractedText = '';
  try {
    const lower = filename.toLowerCase();
    if (mimetype === ALLOWED_TYPES.pdf || lower.endsWith('.pdf')) {
      const pdfResult = await pdfParse(buffer || Buffer.from(''));
      extractedText = pdfResult?.text || '';
    } else if (mimetype === ALLOWED_TYPES.docx || lower.endsWith('.docx')) {
      const docResult = await mammoth.extractRawText({ buffer: buffer || Buffer.from('') });
      extractedText = docResult?.value || '';
    } else if (mimetype === ALLOWED_TYPES.csv || lower.endsWith('.csv') || lower.endsWith('.txt') || mimetype === ALLOWED_TYPES.txt) {
      extractedText = buffer ? buffer.toString('utf8') : '';
    }
  } catch (err) {
    console.warn('File parsing failed (continuing):', err?.message || err);
    extractedText = '';
  }

  // 4) Generate keywords
  const keywordsArr = simpleTokenize(`${extractedText} ${filename} ${source_document} ${customKeywords}`);
  const keywordString = keywordsArr.join(',');

  // 5) Prepare DB payload
  const payload = {
    question_keywords: keywordString || '',
    answer_text: (extractedText || '').substring(0, 20000),
    file_url: publicUrl || '',
    uploaded_by: uploaded_by || '',
    lecturer_name: lecturer_name || '',
    source_document: source_document || ''
  };

  // 6) Insert into DB
  try {
    const { data, error } = await supabase.from('knowledge_base').insert([payload]).select();
    if (error) console.warn('DB insert failed (continuing):', error.message || error);
    return data?.[0] || null;
  } catch (err) {
    console.warn('DB insert exception (continuing):', err?.message || err);
    return null;
  }
}

// ===== UPLOAD ENDPOINT =====
app.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  const { originalname, buffer, mimetype } = req.file;
  let { uploaded_by = '', lecturer = '', source_document = '', keywords = '' } = req.body || {};

  const record = await processFile({
    buffer, filename: originalname, mimetype,
    uploaded_by, lecturer_name: lecturer, source_document, customKeywords: keywords
  });

  if (!record) return res.status(500).json({ ok: false, error: 'Processing failed' });
  res.json({ ok: true, record });
});

// ===== ASK ENDPOINT =====
app.post('/ask', async (req, res) => {
  try {
    const { question, top_k = 2 } = req.body;
    if (!question) return res.status(400).json({ error: 'Question required' });

    const qTokens = simpleTokenize(question).slice(0, 2000);
    if (qTokens.length === 0) return res.json({ matches: [] });

    const orParts = [];
    qTokens.forEach(tok => {
      const safe = tok.replace(/%/g, '');
      orParts.push(`question_keywords.ilike.%${safe}%`);
      orParts.push(`answer_text.ilike.%${safe}%`);
      orParts.push(`source_document.ilike.%${safe}%`);
    });
    const orQuery = orParts.join(',');

    const { data, error } = await supabase.from('knowledge_base').select('*').or(orQuery).limit(2000);
    if (error) return res.status(500).json({ error: 'Search failed', detail: error });

    const scored = data.map(r => {
      const hay = ((r.answer_text || '') + ' ' + (r.question_keywords || '') + ' ' + (r.source_document || '')).toLowerCase();
      let score = 0;
      qTokens.forEach(tok => {
        const re = new RegExp(`\\b${tok}\\b`, 'g');
        const m = hay.match(re);
        if (m) score += m.length;
      });
      return { row: r, score };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    const best = scored.slice(0, top_k).map(s => {
      const r = s.row;
      return {
        score: s.score,
        snippet: (r.answer_text || '').slice(0, 8000),
        lecturer: r.lecturer_name,
        source: r.source_document,
        file_url: r.file_url,
        id: r.id
      };
    });

    res.json({ matches: best });
  } catch (err) {
    console.error('[ask] error:', err?.message || err);
    res.status(500).json({ error: 'Server error', detail: err?.message || String(err) });
  }
});

// ===== PROCESS ALL EXISTING BUCKET FILES ON STARTUP =====
async function processExistingFiles() {
  try {
    const { data: files, error } = await supabase.storage.from('documents').list('');
    if (error) return console.warn('Error listing bucket files:', error.message || error);

    for (const f of files || []) {
      if (!f.name) continue;
      console.log('Processing existing file:', f.name);
      // Download file buffer
      const { data: fileData, error: downloadError } = await supabase.storage.from('documents').download(f.name);
      if (downloadError) {
        console.warn('Failed to download file:', f.name, downloadError.message || downloadError);
        continue;
      }
      await processFile({
        buffer: fileData,
        filename: f.name,
        mimetype: f.content_type || '',
        uploaded_by: 'system'
      });
    }
    console.log('Finished processing existing files.');
  } catch (err) {
    console.warn('Error in processExistingFiles:', err?.message || err);
  }
}

processExistingFiles(); // run on startup

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Chatbot backend running on port ${PORT}`));
