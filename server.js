import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --- Supabase setup ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL and Key must be set as environment variables!');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ===== Upload Article =====
app.post('/upload', async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) {
    return res.status(400).json({ success: false, message: 'Title and content required.' });
  }

  // Generate SHA-256 hash of content
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');

  console.log('Upload request body:', { title, content, sha256 });

  try {
    const { data, error } = await supabase
      .from('articles')
      .insert([{ title, content, sha256 }])
      .select(); // ensures data is returned

    if (error) {
      // handle duplicate
      if (error.code === '23505') {
        return res.json({ success: false, duplicate: true });
      }
      throw error;
    }

    if (!data || !data[0]) {
      return res.json({ success: false, message: 'No data returned from Supabase.' });
    }

    res.json({ success: true, hash: sha256, article: data[0] });
  } catch (err) {
    console.error('Supabase insert error:', err);
    res.status(500).json({ success: false, error: 'Error uploading article.' });
  }
});
// ===== Fetch Single Article =====
app.get('/article', async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ error: 'Missing id parameter' });
    }

    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Supabase fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch article' });
    }

    if (!data) {
      return res.status(404).json({ error: 'Article not found' });
    }

    res.json(data);
  } catch (err) {
    console.error('Server error fetching article:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Fetch Article Comments =====
app.get('/articles/:id/comments', async (req, res) => {
  try {
    const { id } = req.params;

    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('article_id', id)
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Supabase fetch comments error:', error);
      return res.status(500).json({ error: 'Failed to fetch comments' });
    }

    res.json(data || []);
  } catch (err) {
    console.error('Server error fetching comments:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ===== Comments =====
app.post('/comment', async (req, res) => {
  const { article_id, comment, citations_count = 0, has_identifying_info = false } = req.body;

  if (!article_id || !comment) {
    return res.status(400).json({ success: false, message: 'Article ID and comment required.' });
  }

  const points = comment.length / 10 + citations_count + (has_identifying_info ? 2 : 0);

  try {
    const { data, error } = await supabase
      .from('comments')
      .insert([{ article_id, comment, citations_count, has_identifying_info, points }])
      .select();

    if (error) throw error;
    res.json({ success: true, points, comment: data[0] });
  } catch (err) {
    console.error('Supabase insert error:', err);
    res.status(500).json({ success: false, error: 'Error saving comment.' });
  }
});

// ===== Get Articles =====
app.get('/articles', async (req, res) => {
  try {
    const { data, error } = await supabase.from('articles').select('*');
    if (error) throw error;
    res.json({ success: true, articles: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error fetching articles.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
