const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Replace with your Supabase credentials
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Health check
app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// Upload article
app.post('/upload-article', async (req, res) => {
  const { title, content } = req.body;
  const hash = crypto.createHash('sha256').update(content).digest('hex');

  const { data, error } = await supabase
    .from('articles')
    .insert([{ title, content, sha256: hash }]);

  if (error) return res.status(500).json({ error: error.message });

  res.json({ hash });
});

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
