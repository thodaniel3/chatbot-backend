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

// 🔒 Multer (memory upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// 🔑 USE SERVICE ROLE KEY (THIS FIXES IT)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------- TOKENIZER ----------
const STOPWORDS = new Set([
  'the','is','and','a','an','of','to','in','for','on','by','with','that','this',
  'it','are','as','be','or','from','at','which','we','you','your','our','their'
]);

function tokenize(text) {
  if (!text) return [];
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  )].slice(0, 200);
}

// ---------- FILE PROCESSOR ----------
async function processFile({ file, lecturer = '', keywords = '' }) {

  const safeName = `${Date.now()}_${file.originalname.replace(/\s+/g, '_')}`;

  // 1️⃣ Upload to Storage
  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(safeName, file.buffer, {
      contentType: file.mimetype,
      upsert: true
    });

  if (uploadError) {
    console.error("STORAGE ERROR:", uploadError);
    throw new Error(uploadError.message);
  }

  // 2️⃣ Public URL
  const { data } = supabase.storage
    .from('documents')
    .getPublicUrl(safeName);

  const publicUrl = data.publicUrl;

  // 3️⃣ Extract text
  let extractedText = '';
  if (file.mimetype === 'application/pdf') {
    extractedText = (await pdfParse(file.buffer)).text;
  } else if (file.mimetype.includes('word')) {
    extractedText = (await mammoth.extractRawText({ buffer: file.buffer })).value;
  } else {
    extractedText = file.buffer.toString('utf8');
  }

  // 4️⃣ Keywords
  const keywordList = tokenize(
    extractedText + ' ' + file.originalname + ' ' + keywords
  ).join(',');

  // 5️⃣ Save DB
  const { error: dbError } = await supabase
    .from('knowledge_base')
    .insert([{
      question_keywords: keywordList,
      answer_text: extractedText.substring(0, 20000),
      file_url: publicUrl,
      lecturer_name: lecturer,
      source_document: file.originalname
    }]);

  if (dbError) throw new Error(dbError.message);
}

// ---------- UPLOAD ----------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    await processFile({
      file: req.file,
      lecturer: req.body.lecturer,
      keywords: req.body.keywords
    });

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- ASK ----------
app.post('/ask', async (req, res) => {
  const tokens = tokenize(req.body.question || '');
  const orQuery = tokens.map(t => `question_keywords.ilike.%${t}%`).join(',');

  const { data } = await supabase
    .from('knowledge_base')
    .select('*')
    .or(orQuery)
    .limit(5);

  res.json({
    matches: data.map(r => ({
      snippet: r.answer_text.slice(0, 800),
      lecturer: r.lecturer_name,
      source: r.source_document,
      file_url: r.file_url
    }))
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on ${PORT}`));
