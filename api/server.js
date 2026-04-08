// POWER ECO-DOUCHE — E-commerce API
// Fastify + SQLite + Nodemailer
// Endpoints: products, orders, cart, contact, heygen, social
import Fastify from 'fastify';
import cors from '@fastify/cors';
import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const fastify = Fastify({ logger: true });
await fastify.register(cors, { origin: true });

// ─── DATABASE ───
const db = new Database(path.join(__dirname, 'ecodouche.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    sku TEXT UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    currency TEXT DEFAULT 'EUR',
    category TEXT,
    image TEXT,
    stock INTEGER DEFAULT 100,
    featured INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL,
    customer_phone TEXT,
    customer_address TEXT,
    items TEXT NOT NULL,
    subtotal REAL NOT NULL,
    shipping REAL DEFAULT 0,
    total REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    message TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS newsletter (
    email TEXT PRIMARY KEY,
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS heygen_jobs (
    id TEXT PRIMARY KEY,
    script TEXT NOT NULL,
    voice TEXT,
    avatar TEXT,
    status TEXT DEFAULT 'queued',
    video_url TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS social_posts (
    id TEXT PRIMARY KEY,
    platform TEXT NOT NULL,
    caption TEXT,
    media_url TEXT,
    hashtags TEXT,
    scheduled_at TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ─── SEED PRODUCTS ───
const seedProducts = [
  {
    id: 1, sku: 'PED-MAIN-001',
    name: 'Douchette Power Eco-Douche',
    description: 'Douchette géothermale avec billes de tourmaline, germanium et argile grise. Économise 50% d\'eau. 3 positions de massage. Raccord universel.',
    price: 29.90, category: 'douchette', image: '/img/DOUCHETTE_DUO_POWER_ECO_DOUCHE.jpg',
    stock: 250, featured: 1
  },
  {
    id: 5, sku: 'PED-TOURMALINE',
    name: 'Billes de Tourmaline',
    description: 'Pierre naturelle purifiante — adoucit l\'eau et élimine le chlore. Lot de recharge compatible Power Eco-Douche.',
    price: 9.90, category: 'accessoire', image: '/img/POWER_ECO_DOUCHE_TOURMALINE.jpg',
    stock: 180, featured: 0
  },
  {
    id: 6, sku: 'PED-GERMANIUM',
    name: 'Billes de Germanium',
    description: 'Pierre naturelle revitalisante — apaise la peau et stimule la micro-circulation. Lot de recharge.',
    price: 9.90, category: 'accessoire', image: '/img/POWER_ECO_DOUCHE_GERMANIUM.jpg',
    stock: 150, featured: 0
  },
  {
    id: 7, sku: 'PED-ARGILE',
    name: 'Billes d\'Argile Grise',
    description: 'Pierre naturelle absorbante — capte impuretés et métaux lourds pour une eau plus saine.',
    price: 9.90, category: 'accessoire', image: '/img/POWER_ECO_DOUCHE_ARGILE_GRISE.jpg',
    stock: 160, featured: 0
  }
];
const insertProduct = db.prepare(`
  INSERT OR REPLACE INTO products (id, sku, name, description, price, category, image, stock, featured)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const seedTx = db.transaction(() => {
  // Clean out any legacy/fake products not in our seed list
  const validIds = seedProducts.map(p => p.id);
  db.prepare(`DELETE FROM products WHERE id NOT IN (${validIds.join(',')})`).run();
  for (const p of seedProducts) {
    insertProduct.run(p.id, p.sku, p.name, p.description, p.price, p.category, p.image, p.stock, p.featured);
  }
});
seedTx();

// ─── ROUTES ───

fastify.get('/api/health', async () => ({ status: 'ok', service: 'ecodouche', timestamp: new Date().toISOString() }));

// Products
fastify.get('/api/ecodouche/products', async (req) => {
  const { category, featured } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = [];
  if (category) { sql += ' AND category = ?'; params.push(category); }
  if (featured) { sql += ' AND featured = 1'; }
  sql += ' ORDER BY featured DESC, id ASC';
  const rows = db.prepare(sql).all(...params);
  return { products: rows };
});

fastify.get('/api/ecodouche/products/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'Product not found' });
  return row;
});

// Cart (server-side validation, but cart lives in localStorage client-side)
fastify.post('/api/ecodouche/cart/validate', async (req, reply) => {
  const { items } = req.body || {};
  if (!Array.isArray(items)) return reply.code(400).send({ error: 'items must be an array' });

  let subtotal = 0;
  const validated = [];
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
    if (!product) return reply.code(400).send({ error: `Product ${item.id} not found` });
    if (product.stock < item.qty) {
      return reply.code(400).send({ error: `Stock insuffisant pour ${product.name}` });
    }
    const lineTotal = product.price * item.qty;
    subtotal += lineTotal;
    validated.push({
      id: product.id, name: product.name, price: product.price,
      qty: item.qty, image: product.image, lineTotal
    });
  }
  const shipping = subtotal >= 50 ? 0 : 4.90;
  const total = subtotal + shipping;
  return { items: validated, subtotal, shipping, total, freeShippingThreshold: 50 };
});

// Orders
fastify.post('/api/ecodouche/order', async (req, reply) => {
  const { customer, items, shipping: shippingRequest } = req.body || {};
  if (!customer?.name || !customer?.email) {
    return reply.code(400).send({ error: 'Nom et email requis' });
  }
  if (!Array.isArray(items) || !items.length) {
    return reply.code(400).send({ error: 'Panier vide' });
  }

  // Validate items
  let subtotal = 0;
  const validatedItems = [];
  for (const item of items) {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(item.id);
    if (!product) return reply.code(400).send({ error: `Produit ${item.id} introuvable` });
    subtotal += product.price * item.qty;
    validatedItems.push({
      id: product.id, name: product.name, price: product.price,
      qty: item.qty, image: product.image
    });
  }

  const shipping = subtotal >= 50 ? 0 : 4.90;
  const total = subtotal + shipping;
  const orderId = 'PED-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();

  db.prepare(`
    INSERT INTO orders (id, customer_name, customer_email, customer_phone, customer_address, items, subtotal, shipping, total, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    orderId, customer.name, customer.email, customer.phone || null,
    customer.address || null, JSON.stringify(validatedItems),
    subtotal, shipping, total, 'pending'
  );

  return {
    ok: true,
    order: {
      id: orderId, customer, items: validatedItems,
      subtotal, shipping, total,
      status: 'pending',
      message: 'Merci ! Votre commande a bien été enregistrée. Vous recevrez un email de confirmation.'
    }
  };
});

fastify.get('/api/ecodouche/orders/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'Order not found' });
  return { ...row, items: JSON.parse(row.items) };
});

// Contact form
fastify.post('/api/ecodouche/contact', async (req, reply) => {
  const { name, email, phone, message } = req.body || {};
  if (!name || !email || !message) {
    return reply.code(400).send({ error: 'Nom, email et message requis' });
  }
  const id = 'MSG-' + crypto.randomBytes(6).toString('hex');
  db.prepare(`INSERT INTO contacts (id, name, email, phone, message) VALUES (?, ?, ?, ?, ?)`)
    .run(id, name, email, phone || null, message);
  return { ok: true, id, message: 'Merci ! Votre message a bien été envoyé.' };
});

// Newsletter
fastify.post('/api/ecodouche/newsletter', async (req, reply) => {
  const { email } = req.body || {};
  if (!email || !email.includes('@')) return reply.code(400).send({ error: 'Email invalide' });
  try {
    db.prepare('INSERT INTO newsletter (email) VALUES (?)').run(email);
  } catch (e) {
    // Already subscribed is fine
  }
  return { ok: true, message: 'Inscription enregistrée !' };
});

// HeyGen video generation (queues a job, returns id)
fastify.post('/api/ecodouche/heygen/generate', async (req, reply) => {
  const { script, voice, avatar } = req.body || {};
  if (!script || script.length < 10) {
    return reply.code(400).send({ error: 'Script trop court (min 10 caractères)' });
  }
  if (script.length > 2520) {
    return reply.code(400).send({ error: 'Script trop long (max 2520 caractères)' });
  }
  const id = 'HG-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  db.prepare(`
    INSERT INTO heygen_jobs (id, script, voice, avatar, status)
    VALUES (?, ?, ?, ?, 'queued')
  `).run(id, script, voice || 'f38a635bee7a4d1f9b0a654a31d050d2', avatar || '9dd33c5ff62f470fb7a7e678f09dddd2');

  return {
    ok: true,
    id,
    status: 'queued',
    message: 'Vidéo en cours de génération. Cela prend 2-3 minutes.',
    estimatedMs: 180000
  };
});

fastify.get('/api/ecodouche/heygen/job/:id', async (req, reply) => {
  const row = db.prepare('SELECT * FROM heygen_jobs WHERE id = ?').get(req.params.id);
  if (!row) return reply.code(404).send({ error: 'Job not found' });
  return row;
});

fastify.get('/api/ecodouche/heygen/jobs', async () => {
  const rows = db.prepare('SELECT * FROM heygen_jobs ORDER BY created_at DESC LIMIT 20').all();
  return { jobs: rows };
});

// Social media — serves real HeyGen video URLs when available
fastify.get('/api/ecodouche/social/videos', async () => {
  // Check if we have real video files downloaded
  const videoDir = '/var/www/spawnkit.ai/ecodouche/videos';
  const videos = [
    {
      id: 'eco-savings',
      title: 'Économie d\'eau — 50% de réduction',
      platform: 'TikTok',
      caption: '🚿 Économisez 50% d\'eau sans effort ! #ecologie #salledebain #economie',
      thumbnail: '/img/DOUCHETTE_DUO_POWER_ECO_DOUCHE.jpg',
      video_url: null,
      duration: null,
    },
    {
      id: 'stones-benefits',
      title: 'Pierres naturelles — 3 bienfaits',
      platform: 'Instagram',
      caption: '✨ Découvrez les 3 pierres naturelles qui transforment votre eau ! #naturel',
      thumbnail: '/img/POWER_ECO_DOUCHE_TOURMALINE.jpg',
      video_url: null,
      duration: null,
    },
    {
      id: 'challenge-30',
      title: 'Challenge 30 jours',
      platform: 'TikTok',
      caption: '🌿 Pourquoi les Français adoptent cette douchette révolutionnaire ? #viral',
      thumbnail: '/img/POWER_ECO_DOUCHE_GERMANIUM.jpg',
      video_url: null,
      duration: null,
    }
  ];
  // Auto-detect downloaded videos by id-based filename match
  try {
    if (fs.existsSync(videoDir)) {
      for (const v of videos) {
        const filepath = `${videoDir}/${v.id}.mp4`;
        if (fs.existsSync(filepath)) {
          v.video_url = `/videos/${v.id}.mp4`;
          const stat = fs.statSync(filepath);
          v.size_mb = (stat.size / 1024 / 1024).toFixed(1);
          v.duration = '~18s';
        }
      }
    }
  } catch(e) {}
  return { videos };
});

fastify.post('/api/ecodouche/social/post', async (req, reply) => {
  const { platform, caption, mediaUrl, hashtags, scheduledAt } = req.body || {};
  if (!platform || !caption) return reply.code(400).send({ error: 'Platform et caption requis' });
  const id = 'POST-' + crypto.randomBytes(6).toString('hex');
  db.prepare(`
    INSERT INTO social_posts (id, platform, caption, media_url, hashtags, scheduled_at, status)
    VALUES (?, ?, ?, ?, ?, ?, 'scheduled')
  `).run(id, platform, caption, mediaUrl || null, JSON.stringify(hashtags || []), scheduledAt || null);
  return { ok: true, id, platform, status: 'scheduled' };
});

// Analytics
fastify.get('/api/ecodouche/stats', async () => {
  const productCount = db.prepare('SELECT COUNT(*) as n FROM products').get().n;
  const orderCount = db.prepare('SELECT COUNT(*) as n FROM orders').get().n;
  const contactCount = db.prepare('SELECT COUNT(*) as n FROM contacts').get().n;
  const newsletterCount = db.prepare('SELECT COUNT(*) as n FROM newsletter').get().n;
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(total), 0) as sum FROM orders').get().sum;
  return {
    products: productCount,
    orders: orderCount,
    contacts: contactCount,
    newsletter: newsletterCount,
    revenue: totalRevenue,
    timestamp: new Date().toISOString()
  };
});

// ─── START ───
const PORT = 8872;
try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`✓ Power Eco-Douche API running on port ${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
