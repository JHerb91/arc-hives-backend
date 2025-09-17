
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
    const filePath = `articles/${Date.now()}_${file.originalname}`;
    const { data: storageData, error: storageError } = await supabase.storage
      .from('articles')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
      });

    if (storageError) throw storageError;

    // Get the public URL for the uploaded file
    const { data: publicUrlData } = supabase.storage
      .from('articles')
      .getPublicUrl(filePath);
    
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

    // Fix incomplete file URLs (for articles uploaded before the URL fix)
    if (data.file_url && !data.file_url.startsWith('http')) {
      const { data: publicUrlData } = supabase.storage
        .from('articles')
        .getPublicUrl(data.file_url);
      data.file_url = publicUrlData.publicUrl;
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
  const { article_id, commenter_name, comment, citations_count = 0, has_identifying_info = false, member_id, spend_points, spend_direction } = req.body;

  if (!article_id || !comment) {
    return res.status(400).json({ success: false, error: 'article_id and comment are required' });
  }

  const citations = Number(citations_count) || 0;
  const identifying = !!has_identifying_info;

  // Optional spend validation (anonymous allowed)
  let spendAmount = 0;
  let spendSign = 0; // +1 for up, -1 for down, 0 for none
  let memberRow = null;
  if (spend_points != null || spend_direction != null || member_id != null) {
    const parsedSpend = Number(spend_points);
    const dir = String(spend_direction || '').toLowerCase();
    if (!Number.isFinite(parsedSpend) || parsedSpend <= 0) {
      return res.status(400).json({ success: false, error: 'spend_points must be a positive number' });
    }
    if (dir !== 'up' && dir !== 'down') {
      return res.status(400).json({ success: false, error: "spend_direction must be 'up' or 'down'" });
    }
    spendAmount = parsedSpend;
    spendSign = dir === 'down' ? -1 : 1;

    // If a member_id is provided, validate and deduct; otherwise allow anonymous spend with no deduction
    if (member_id != null) {
      const { data: mData, error: memberErr } = await supabase
        .from('members')
        .select('id, points')
        .eq('id', member_id)
        .single();
      if (memberErr || !mData) {
        return res.status(400).json({ success: false, error: 'Member not found' });
      }
      if (!Number.isFinite(mData.points) || mData.points < spendAmount) {
        return res.status(400).json({ success: false, error: 'Insufficient member points' });
      }
      memberRow = mData;
    }
  }

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

    // Update article total points (include optional spend adjustment)
    try {
      const { data: artRow, error: artErr } = await supabase
        .from('articles')
        .select('points')
        .eq('id', article_id)
        .single();

      const currentPoints = artRow && typeof artRow.points === 'number' ? artRow.points : 0;
      const spendAdjustment = spendSign !== 0 ? spendSign * spendAmount : 0;
      const newPoints = Number((currentPoints + points + spendAdjustment).toFixed(2));

      const { error: updateErr } = await supabase
        .from('articles')
        .update({ points: newPoints })
        .eq('id', article_id);

      if (updateErr) console.error('Error updating article points:', updateErr);

      // Deduct spent points from member if applicable
      if (spendSign !== 0 && memberRow) {
        const newMemberPoints = Math.max(0, Number((memberRow.points - spendAmount).toFixed(2)));
        const { error: memberUpdateErr } = await supabase
          .from('members')
          .update({ points: newMemberPoints })
          .eq('id', memberRow.id);
        if (memberUpdateErr) {
          console.error('Error deducting member points:', memberUpdateErr);
        }
      }
    } catch (e) {
      console.error('Non-fatal error updating article points:', e);
    }

    return res.json({ success: true, points, spend_applied: spendSign !== 0 ? spendSign * spendAmount : 0, comment: inserted });
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
    
    // Fix incomplete file URLs for all articles
    const articlesWithFixedUrls = data.map(article => {
      if (article.file_url && !article.file_url.startsWith('http')) {
        const { data: publicUrlData } = supabase.storage
          .from('articles')
          .getPublicUrl(article.file_url);
        article.file_url = publicUrlData.publicUrl;
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
