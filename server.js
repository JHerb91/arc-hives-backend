// server.js
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { v4: uuidv4 } = require('uuid');
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

// Get all articles
app.get('/articles', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .order('id', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ articles: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    if (error) return res.status(500).json({ error: error.message });
    res.json({ article: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get comments for a specific article
app.get('/comments/:article_id', async (req, res) => {
  const { article_id } = req.params;

  try {
    const { data, error } = await supabase
      .from('comments')
      .select('*')
      .eq('article_id', article_id)
      .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json({ comments: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upload article and generate SHA-256
app.post('/upload-article', async (req, res) => {
  const { title, content } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required.' });

  const hash = crypto.createHash('sha256').update(title + content + Date.now()).digest('hex');

  try {
    const { data, error } = await supabase
      .from('articles')
      .insert([{ title, content, sha256: hash }])
      .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, hash });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add a comment and calculate points
app.post('/add-comment', async (req, res) => {
  const { article_id, commenter_name, comment, citations_count, has_identifying_info } = req.body;

  if (!article_id || !comment) return res.status(400).json({ error: 'Article ID and comment are required.' });

  // Calculate points
  let points = 0;
  points += comment.length / 100; // 1 point per 100 chars
  points += (citations_count || 0) * 2; // 2 points per citation
  if (has_identifying_info) points += 5;
  points = Number(points.toFixed(2));

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

    if (commentError) return res.status(500).json({ error: commentError.message });

    // Update article points
    const { data: articleData, error: fetchError } = await supabase
      .from('articles')
      .select('points')
      .eq('id', article_id)
      .single();

    if (fetchError) return res.status(500).json({ error: fetchError.message });

    const newPoints = Number(articleData.points || 0) + points;

    const { error: updateError } = await supabase
      .from('articles')
      .update({ points: newPoints })
      .eq('id', article_id);

    if (updateError) return res.status(500).json({ error: updateError.message });

    res.json({ success: true, points, comment: commentData[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify article ownership by SHA-256 (JSON)
app.post('/verify-article', async (req, res) => {
  const { sha256 } = req.body;
  if (!sha256) return res.status(400).json({ error: 'SHA-256 hash is required.' });

  try {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('sha256', sha256)
      .single();

    if (error || !data) return res.status(404).json({ error: 'No article found with this SHA-256.' });

    const certificate = {
      title: data.title,
      article_id: data.id,
      certificate_id: data.certificate_id || null,
      verified_at: new Date().toISOString(),
      message: 'This certificate verifies that you are the original publisher of this article.'
    };

    res.json({ success: true, certificate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify article ownership and generate PDF certificate
app.post('/verify-article-pdf', async (req, res) => {
  const { sha256 } = req.body;
  if (!sha256) return res.status(400).json({ error: 'SHA-256 hash is required.' });

  try {
    // Fetch the article
    let { data: article, error } = await supabase
      .from('articles')
      .select('*')
      .eq('sha256', sha256)
      .single();

    if (error || !article) return res.status(404).json({ error: 'No article found with this SHA-256.' });

    // Generate a certificate ID if not exists
    if (!article.certificate_id) {
      const certId = uuidv4();
      await supabase
        .from('articles')
        .update({ certificate_id: certId })
        .eq('id', article.id);
      article.certificate_id = certId;
    }

    const certificate = {
      title: article.title,
      article_id: article.id,
      certificate_id: article.certificate_id,
      verified_at: new Date().toISOString(),
      message: 'This certificate verifies that you are the original publisher of this article.'
    };

    // Generate PDF
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=certificate_${article.id}.pdf`,
        'Content-Length': pdfData.length
      });
      res.send(pdfData);
    });

    doc.fontSize(24).text('Certificate of Authorship', { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(18).text(`Article Title: ${certificate.title}`, { align: 'center' });
    doc.moveDown(1);
    doc.fontSize(14).text(`Article ID: ${certificate.article_id}`, { align: 'center' });
    doc.moveDown(1);
    doc.text(`Certificate ID: ${certificate.certificate_id}`, { align: 'center' });
    doc.moveDown(1);
    doc.text(`Verified At: ${certificate.verified_at}`, { align: 'center' });
    doc.moveDown(2);
    doc.fontSize(16).text(certificate.message, { align: 'center' });
    doc.moveDown(3);
    doc.fontSize(12).text('--- End of Certificate ---', { align: 'center', opacity: 0.5 });

    doc.end();

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Start server
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
