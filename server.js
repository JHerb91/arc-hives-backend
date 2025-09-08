// server.js
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import { createClient } from '@supabase/supabase-js';
import PDFDocument from 'pdfkit';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const port = process.env.PORT || 10000;

app.use(cors());
app.use(bodyParser.json());

// ===== Supabase Client =====
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Supabase URL and Key must be set as environment variables!');
}

const supabase = createClient(supabaseUrl, supabaseKey);

// ===== Upload Article =====
app.post('/upload', async (req, res) => {
  const { title, sha256 } = req.body;
  console.log('Upload request body:', req.body); // Add this line
  try {
    const { data, error } = await supabase.from('articles').insert([{ title, sha256 }]);
    if (error) throw error;
    res.json({ success: true, article: data[0] });
  } catch (err) {
    console.error('Supabase insert error:', err);
    res.status(500).json({ error: 'Error uploading article.' });
  }
});

// ===== Verify Article =====
app.post('/verify-article', async (req, res) => {
  const { sha256 } = req.body;
  try {
    const { data, error } = await supabase
      .from('articles')
      .select('*')
      .eq('sha256', sha256)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Article not found.' });
    }

    res.json({
      success: true,
      certificate: {
        title: data.title,
        article_id: data.id,
        message: 'This certificate verifies that you are the original publisher of this article.',
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error verifying article.' });
  }
});

// ===== Submit Comment =====
app.post('/comment', async (req, res) => {
  const { article_id, comment, citations_count, has_identifying_info } = req.body;

  try {
    const points = citations_count * 2 + comment.length / 50 + (has_identifying_info ? 1 : 0);

    const { data, error } = await supabase.from('comments').insert([{
      article_id,
      comment,
      citations_count,
      points,
      commenter_name: 'Anonymous',
    }]);

    if (error) throw error;

    res.json({ success: true, points, comment: data[0] });
  } catch (err) {
    console.error('Supabase insert error:', err);
    res.status(500).json({ error: 'Error submitting comment.' });
  }
});

// ===== PDF Certificate Generation =====
app.post('/verify-article-pdf', async (req, res) => {
  const { sha256 } = req.body;

  try {
    const { data: articleData, error } = await supabase
      .from('articles')
      .select('*')
      .eq('sha256', sha256)
      .single();

    if (error || !articleData) {
      return res.status(404).json({ error: 'Article not found for this SHA-256.' });
    }

    // Generate certificate ID if not exists
    let certificateId = articleData.certificate_id;
    if (!certificateId) {
      certificateId = uuidv4();
      await supabase
        .from('articles')
        .update({ certificate_id: certificateId })
        .eq('id', articleData.id);
    }

    // Create PDF
    const doc = new PDFDocument();
    let buffers = [];
    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => {
      const pdfData = Buffer.concat(buffers);
      res
        .writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename=certificate_${articleData.id}.pdf`,
        })
        .end(pdfData);
    });

    doc.fontSize(20).text('Article Certificate', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Article Title: ${articleData.title}`);
    doc.text(`Article ID: ${articleData.id}`);
    doc.text(`Certificate ID: ${certificateId}`);
    doc.text(`Verified At: ${new Date().toISOString()}`);
    doc.moveDown();
    doc.text('This certificate verifies that you are the original publisher of this article.');
    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generating PDF certificate.' });
  }
});

// ===== Start Server =====
app.listen(port, () => {
  console.log(`Backend is running on port ${port}`);
});
