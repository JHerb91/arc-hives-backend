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

// Add a comment to an article
app.post('/add-comment', async (req, res) => {
  const { article_id, commenter_name, comment, citations_count, has_identifying_info } = req.body;

  if (!article_id || !comment) {
    return res.status(400).json({ error: 'Article ID and comment are required.' });
  }

  // Calculate points
  let points = 0;
  points += comment.length / 100; // 1 point per 100 characters
  points += (citations_count || 0) * 2; // 2 points per citation
  if (has_identifying_info) points += 5; // bonus for identifying info

  try {
    // Insert comment
    const { data, error } = await supabase
      .from('comments')
      .insert([{
        article_id,
        commenter_name: commenter_name || 'Anonymous',
        comment,
        citations_count: citations_count || 0,
        points
      }]);

    if (error) return res.status(500).json({ error: error.message });

    // Update article points (sum of all comment points)
    const { data: articleData, error: articleError } = await supabase
      .from('articles')
      .update({
        points: supabase.raw('points + ?', [points])
      })
      .eq('id', article_id);

    if (articleError) return res.status(500).json({ error: articleError.message });

    res.json({ success: true, points, comment: data[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
