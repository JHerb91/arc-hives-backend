// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Supabase setup
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Root route
app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// Get single article by id
app.get('/article/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching article:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ article: data });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Upload article and generate SHA-256
app.post('/upload-article', async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ error: 'Title and content are required.' });
  }

  const hash = crypto.createHash('sha256').update(title + content + Date.now()).digest('hex');

  try {
    const { data, error } = await supabase
      .from('articles')
      .insert([{ title, content, sha256: hash }])
      .select();

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).json({ error: error.message });
    }

    res.json({ success: true, hash });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Add a comment and calculate points
app.post('/add-comment', async (req, res) => {
  const { article_id, commenter_name, comment, citations_count, has_identifying_info } = req.body;

  console.log('Request body:', req.body);

  if (!article_id || !comment) {
    console.log('Missing article_id or comment');
    return res.status(400).json({ error: 'Article ID and comment are required.' });
  }

  // Calculate points
  let points = 0;
  points += comment.length / 100; // 1 point per 100 characters
  points += (citations_count || 0) * 2; // 2 points per citation
  if (has_identifying_info) points += 5;
  points = Number(points.toFixed(2));

  console.log('Calculated points:', points);

  try {
    // Insert comment
    const { data: commentData, error: commentError } = await supabase
      .from('comments')
      .insert([{
        article_id,
        commenter_name: commenter_name || 'Anonymous',
        comment,
        citations_count: citations_count || 0,
        points
      }])
      .select();

    if (commentError) {
      console.error('Supabase insert error:', commentError);
      return res.status(500).json({ error: commentError.message });
    }

    // Update article points safely
    const { data: articleData, error: fetchError } = await supabase
      .from('articles')
      .select('points')
      .eq('id', article_id)
      .single();

    if (fetchError) {
      console.error('Error fetching article:', fetchError);
      return res.status(500).json({ error: fetchError.message });
    }

    const newPoints = Number(articleData.points || 0) + points;

    const { error: updateError } = await supabase
      .from('articles')
      .update({ points: newPoints })
      .eq('id', article_id);

    if (updateError) {
      console.error('Error updating article points:', updateError);
      return res.status(500).json({ error: updateError.message });
    }

    res.json({ success: true, points, comment: commentData[0] });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
