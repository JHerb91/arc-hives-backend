
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import multer from 'multer';

const upload = multer({ storage: multer.memoryStorage() }); // keep files in memory

const app = express();
app.use(cors({
  origin: [
    'https://arc-hives-frontend.vercel.app',
    'http://localhost:3000' // for local testing
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

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
    const file = req.file;

    if (!title || !file) {
      return res.status(400).json({ error: 'Title and file are required' });
    }

    // Parse bibliography if sent as JSON string
    let parsedBibliography;
    try {
      parsedBibliography =
        typeof bibliography === 'string'
          ? JSON.parse(bibliography)
          : bibliography;
    } catch (err) {
      console.error('Error parsing bibliography JSON:', err);
      parsedBibliography = [];
    }

    // Generate SHA-256 hash of file buffer
    const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

    // Upload file buffer to Supabase storage bucket 'articles'
    // IMPORTANT: Do not prefix the key with the bucket name
    const fileKey = `${Date.now()}_${file.originalname}`;
    const { data: storageData, error: storageError } = await supabase.storage
      .from('articles')
      .upload(fileKey, file.buffer, {
        contentType: file.mimetype,
      });

    if (storageError) throw storageError;

    // Get the public URL for the uploaded file
    const { data: publicUrlData } = supabase.storage
      .from('articles')
      .getPublicUrl(fileKey);
    
    const filePublicUrl = publicUrlData.publicUrl;

    // Save metadata in the articles table
    const { data, error } = await supabase.from('articles').insert([
      {
        title,
        authors,
        original_link,
        bibliography: Array.isArray(parsedBibliography) ? parsedBibliography : [parsedBibliography],
        file_url: filePublicUrl, // <-- store full URL here
        sha256,
      },
    ]);

    if (error) throw error;

    // Return only safe fields to frontend (exclude sensitive data like sha256)
    const safeArticle = {
      id: data[0].id,
      title: data[0].title,
      authors: data[0].authors,
      original_link: data[0].original_link,
      bibliography: data[0].bibliography,
      file_url: data[0].file_url,
      points: data[0].points,
      created_at: data[0].created_at,
      content: data[0].content
    };

    res.json({ success: true, article: safeArticle });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Error uploading article.' });
  }
});

// ===== Fetch Single Article =====
app.get('/article', async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) return res.status(400).json({ error: 'Missing id parameter' });

    const { data, error } = await supabase
      .from('articles')
      .select('id, title, authors, original_link, bibliography, file_url, points, created_at, content')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Supabase fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch article' });
    }

    if (!data) return res.status(404).json({ error: 'Article not found' });

    // Fix file URLs
    if (data.file_url) {
      // For legacy rows that stored only the object key
      if (!data.file_url.startsWith('http')) {
        const { data: publicUrlData } = supabase.storage
          .from('articles')
          .getPublicUrl(data.file_url.replace(/^articles\//, ''));
        data.file_url = publicUrlData.publicUrl;
      }
      // Normalize accidental double bucket segment
      data.file_url = data.file_url.replace('/public/articles/articles/', '/public/articles/');
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

// ===== Add Comment =====
app.post('/add-comment', async (req, res) => {
  const { article_id, commenter_name, comment, citations_count = 0, has_identifying_info = false } = req.body;

  if (!article_id || !comment) {
    return res.status(400).json({ success: false, error: 'article_id and comment are required' });
  }

  const citations = Number(citations_count) || 0;
  const identifying = !!has_identifying_info;

  let points = (comment.length || 0) / 100 + citations * 2 + (identifying ? 5 : 0);
  points = Number(points.toFixed(2));

  try {
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
      .select();

    if (insertError) {
      console.error('Supabase insert error:', insertError);
      return res.status(500).json({ success: false, error: insertError.message || 'DB insert error' });
    }

    const inserted = Array.isArray(insertedRows) ? insertedRows[0] : insertedRows;

    // Update article total points
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
      console.error('Non-fatal error updating article points:', e);
    }

    return res.json({ success: true, points, comment: inserted });
  } catch (err) {
    console.error('Server error in /add-comment:', err);
    return res.status(500).json({ success: false, error: 'Server error adding comment' });
  }
});

// ===== Get Articles List =====
app.get('/articles', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('articles')
      .select('id, title, authors, original_link, bibliography, file_url, points, created_at, content');
    
    if (error) throw error;
    
    // Fix file URLs for all articles
    const articlesWithFixedUrls = data.map(article => {
      if (article.file_url) {
        if (!article.file_url.startsWith('http')) {
          const { data: publicUrlData } = supabase.storage
            .from('articles')
            .getPublicUrl(article.file_url.replace(/^articles\//, ''));
          article.file_url = publicUrlData.publicUrl;
        }
        article.file_url = article.file_url.replace('/public/articles/articles/', '/public/articles/');
      }
      return article;
    });
    
    res.json({ success: true, articles: articlesWithFixedUrls });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: 'Error fetching articles.' });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
