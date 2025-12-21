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

const upload = multer({ storage: multer.memoryStorage() });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ---------- SIMPLE TOKENIZER ----------
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

  // 1️⃣ Upload to Supabase Storage
  const safeName = `${Date.now()}_${file.originalname.replace(/\s+/g,'_')}`;

  const { error: uploadError } = await supabase
    .storage
    .from('documents')
    .upload(safeName, file.buffer, {
      contentType: file.mimetype,
      upsert: true
    });

  if (uploadError) {
    console.error("❌ STORAGE UPLOAD FAILED:", uploadError.message);
    throw new Error("Storage upload failed");
  }

  // 2️⃣ Get public URL
  const { data: urlData } = supabase
    .storage
    .from('documents')
    .getPublicUrl(safeName);

  const publicUrl = urlData.publicUrl;

  // 3️⃣ Extract text
  let extractedText = '';

  if (file.mimetype === 'application/pdf') {
    const pdf = await pdfParse(file.buffer);
    extractedText = pdf.text;
  }
  else if (file.mimetype.includes('word')) {
    const doc = await mammoth.extractRawText({ buffer: file.buffer });
    extractedText = doc.value;
  }
  else {
    extractedText = file.buffer.toString('utf8');
  }

  // 4️⃣ Generate keywords
  const keywordList = tokenize(
    extractedText + ' ' + file.originalname + ' ' + keywords
  ).join(',');

  // 5️⃣ Save to database
  const { error: dbError } = await supabase
    .from('knowledge_base')
    .insert([{
      question_keywords: keywordList,
      answer_text: extractedText.substring(0, 20000),
      file_url: publicUrl,
      lecturer_name: lecturer,
      source_document: file.originalname
    }]);

  if (dbError) {
    console.error("❌ DATABASE ERROR:", dbError.message);
    throw new Error("Database insert failed");
  }

  return true;
}

// ---------- UPLOAD ENDPOINT ----------
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file" });

    await processFile({
      file: req.file,
      lecturer: req.body.lecturer,
      keywords: req.body.keywords
    });

    res.json({ ok: true });
  }
  catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- ASK ENDPOINT ----------
app.post('/ask', async (req, res) => {
  const tokens = tokenize(req.body.question);

  const orQuery = tokens
    .map(t => `question_keywords.ilike.%${t}%`)
    .join(',');

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
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
