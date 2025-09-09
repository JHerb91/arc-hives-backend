import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage() }); // keep files in memory


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
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { title, authors, original_link, bibliography } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: 'File is required' });
    }

    // Upload file buffer to Supabase storage (bucket = "articles")
    const filePath = `articles/${Date.now()}_${req.file.originalname}`;
    const { data: storageData, error: storageError } = await supabase.storage
      .from('articles')
      .upload(filePath, req.file.buffer, {
        contentType: req.file.mimetype,
      });

    if (storageError) throw storageError;

    // Save metadata in the table
    const { data, error } = await supabase.from('articles').insert([
      {
        title,
        authors,
        original_link,
        bibliography,
        file_url: storageData?.path || filePath,
      },
    ]);

    if (error) throw error;

    res.json({ success: true, article: data[0] });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Error uploading article.' });
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
// POST /add-comment
// Body expected: { article_id, commenter_name, comment, citations_count, has_identifying_info }
app.post('/add-comment', async (req, res) => {
  const {
    article_id,
    commenter_name,
    comment,
    citations_count = 0,
    has_identifying_info = false,
  } = req.body;

  if (!article_id || !comment) {
    return res.status(400).json({ success: false, error: 'article_id and comment are required' });
  }

  // normalize numbers/booleans
  const citations = Number(citations_count) || 0;
  const identifying = !!has_identifying_info;

  // Points formula (MVP): 1 point per 100 chars, 2 points per citation, +5 for identifying info
  let points = (comment.length || 0) / 100;
  points += citations * 2;
  if (identifying) points += 5;
  points = Number(points.toFixed(2));

  try {
    // Insert comment and return inserted row
    const { data: insertedRows, error: insertError } = await supabase
      .from('comments')
      .insert([{
        article_id,
        commenter_name: commenter_name || 'Anonymous',
        comment,
        citations_count: citations,
        has_identifying_info: identifying,
        points
      }])
      .select(); // return inserted row(s)

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ success: false, error: insertError.message || 'DB insert error' });
    }

    const inserted = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;

    // Update article total points (if articles table has 'points' column)
    try {
      const { data: artRow, error: artErr } = await supabase
        .from('articles')
        .select('points')
        .eq('id', article_id)
        .single();

      const currentPoints = artRow && typeof artRow.points === 'number' ? artRow.points : 0;
      const newPoints = Number((currentPoints + points).toFixed(2));

      const { error: updateErr } = await supabase
        .from('articles')
        .update({ points: newPoints })
        .eq('id', article_id);

      if (updateErr) console.error('Error updating article points:', updateErr);
    } catch (e) {
      console.error('Error fetching/updating article points (non-fatal):', e);
      // proceed — comment inserted successfully even if points update failed
    }

    return res.json({ success: true, points, comment: inserted });
  } catch (err) {
    console.error('Server error in /add-comment:', err);
    return res.status(500).json({ success: false, error: 'Server error adding comment' });
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
