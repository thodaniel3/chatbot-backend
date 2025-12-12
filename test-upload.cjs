const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
require('dotenv').config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY // Use service role key for test
);

async function testUpload() {
  const fileBuffer = fs.readFileSync('sample.pdf');

  const { data, error } = await supabase.storage
    .from('documents')
    .upload('test.pdf', fileBuffer, {
      upsert: true,
      contentType: 'application/pdf'
    });

  console.log("DATA:", data);
  console.log("ERROR:", error);
}

testUpload();
