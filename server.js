
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const { sendOrderEmail } = require('./services/email');
const { getVerifiedOrderItems } = require('./services/products');

const app = express();

const requiredEnv = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY'
];

for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

const BUCKET = 'payment-screenshots';
const MAX_SCREENSHOT_SIZE = 5 * 1024 * 1024;

const allowedOrigins = (process.env.FRONTEND_URL || '')
  .split(',')
  .map(origin => origin.trim().replace(/\/+$/, ''))
  .filter(Boolean);

if (allowedOrigins.length === 0) {
  console.warn(
    'FRONTEND_URL is not set: browsers will be blocked by CORS.'
  );
}

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()'
  );
  next();
});

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin.replace(/\/+$/, ''))) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false
}));

app.use(express.json({
  limit: '8mb',
  strict: true
}));

// Support the existing frontend's text/plain JSON requests.
app.use(express.text({
  type: 'text/plain',
  limit: '8mb'
}));

app.use((req, res, next) => {
  if (typeof req.body === 'string') {
    try {
      req.body = JSON.parse(req.body);
    } catch {
      return res.status(400).json({
        ok: false,
        message: 'Invalid JSON request.'
      });
    }
  }

  next();
});

// Basic in-memory rate limiter.
// For multiple Render instances, use a shared rate limiter.
const requestCounts = new Map();

function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip || 'unknown'}:${req.path}`;
    const now = Date.now();

    let entry = requestCounts.get(key);

    if (!entry || now > entry.resetAt) {
      entry = {
        count: 0,
        resetAt: now + windowMs
      };
    }

    entry.count += 1;
    requestCounts.set(key, entry);

    if (entry.count > maxRequests) {
      return res.status(429).json({
        ok: false,
        message: 'Too many requests. Please try again later.'
      });
    }

    next();
  };
}

setInterval(() => {
  const now = Date.now();

  for (const [key, entry] of requestCounts) {
    if (now > entry.resetAt) {
      requestCounts.delete(key);
    }
  }
}, 60_000).unref();

app.get('/', (req, res) => {
  res.status(200).send('BASEIC Backend is awake!');
});

// Keep-alive target. Touches the database lightly so a free Supabase
// project is not paused for inactivity. Returns no data.
app.get('/health', rateLimit(30, 60 * 1000), async (req, res) => {
  const { error } = await supabase
    .from('products')
    .select('id', { head: true, count: 'exact' })
    .limit(1);

  if (error) {
    console.error('Health check failed:', error.message);
    return res.status(503).json({ ok: false });
  }

  return res.json({ ok: true });
});

function validateOrder(order) {
  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return 'Invalid order.';
  }

  if (
    typeof order.name !== 'string' ||
    order.name.trim().length < 2 ||
    order.name.length > 100
  ) {
    return 'Invalid customer name.';
  }

  if (
    typeof order.phone !== 'string' ||
    !/^9[78]\d{8}$/.test(order.phone)
  ) {
    return 'Invalid phone number.';
  }

  if (
    typeof order.city !== 'string' ||
    !order.city.trim() ||
    order.city.length > 100
  ) {
    return 'Invalid city.';
  }

  if (
    typeof order.address !== 'string' ||
    !order.address.trim() ||
    order.address.length < 6 ||
    order.address.length > 500
  ) {
    return 'Invalid delivery address.';
  }

  if (!['cod', 'bank'].includes(order.paymentMethod)) {
    return 'Invalid payment method.';
  }

  if (
    order.note !== undefined &&
    (typeof order.note !== 'string' || order.note.length > 300)
  ) {
    return 'Invalid order note.';
  }

  if (
    !Array.isArray(order.items) ||
    order.items.length === 0 ||
    order.items.length > 50
  ) {
    return 'Invalid order items.';
  }

  if (
    order.clientRef !== undefined &&
    (typeof order.clientRef !== 'string' || order.clientRef.length > 100)
  ) {
    return 'Invalid client reference.';
  }

  return null;
}

function parseScreenshot(dataUrl) {
  if (typeof dataUrl !== 'string') {
    throw new Error('Invalid screenshot.');
  }

  const match = dataUrl.match(
    /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/
  );

  if (!match) {
    throw new Error('Only JPEG, PNG and WebP screenshots are accepted.');
  }

  const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
  const buffer = Buffer.from(match[2], 'base64');

  if (!buffer.length || buffer.length > MAX_SCREENSHOT_SIZE) {
    throw new Error('Screenshot must be 5 MB or smaller.');
  }

  const signatures = {
    jpg:
      buffer.length >= 3 &&
      buffer[0] === 0xff &&
      buffer[1] === 0xd8 &&
      buffer[2] === 0xff,

    png:
      buffer.length >= 8 &&
      buffer.subarray(0, 8).equals(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
      ),

    webp:
      buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
  };

  if (!signatures[extension]) {
    throw new Error('Screenshot file type does not match its contents.');
  }

  return {
    buffer,
    extension,
    contentType: `image/${match[1]}`
  };
}

// Matches the design reference: BC-YYMMDD-NNNN (Kathmandu date).
// A rare same-day collision is handled by retrying the insert below.
function generateOrderId() {
  const yymmdd = kathmanduDate(new Date()).replace(/-/g, '').slice(2);
  const suffix = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  return `BC-${yymmdd}-${suffix}`;
}

function kathmanduDate(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(part => [part.type, part.value])
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function getKathmanduMidnight(dateString) {
  // Nepal uses UTC+05:45.
  return new Date(`${dateString}T00:00:00+05:45`);
}

function shiftDate(dateString, days) {
  const date = new Date(`${dateString}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getLastThirtyDates(today) {
  return Array.from({ length: 30 }, (_, index) =>
    shiftDate(today, index - 29)
  );
}

// Only orders that are BOTH verified and completed count toward revenue.
function isCountableOrder(order) {
  return (
    order.payment_status === 'Verified' &&
    order.order_status === 'Completed'
  );
}

// PUBLIC ORDER CREATION
app.post(
  '/api/orders',
  rateLimit(10, 10 * 60 * 1000),
  async (req, res) => {
    let screenshotPath = null;
    let orderSaved = false;

    try {
      const order = req.body;
      const validationError = validateOrder(order);

      if (validationError) {
        return res.status(400).json({
          ok: false,
          message: validationError
        });
      }

      if (order.paymentMethod === 'bank' && !order.screenshotBase64) {
        return res.status(400).json({
          ok: false,
          message: 'Please upload your payment screenshot.'
        });
      }

      if (
        order.screenshotBase64 !== undefined &&
        order.screenshotBase64 !== null &&
        typeof order.screenshotBase64 !== 'string'
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid screenshot.'
        });
      }

      // Retrieve trusted names and prices from Supabase.
      const verified = await getVerifiedOrderItems(
        supabase,
        order.items
      );

      const { items, total } = verified;

      if (
        !Number.isFinite(total) ||
        total < 0 ||
        total > 100_000_000
      ) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid order total.'
        });
      }

      // Upload screenshot to private storage.
      if (order.screenshotBase64) {
        const screenshot = parseScreenshot(order.screenshotBase64);

        screenshotPath =
          `${kathmanduDate(new Date())}/${crypto.randomUUID()}.${screenshot.extension}`;

        const { error: uploadError } = await supabase.storage
          .from(BUCKET)
          .upload(screenshotPath, screenshot.buffer, {
            contentType: screenshot.contentType,
            upsert: false
          });

        if (uploadError) throw uploadError;
      }

      let orderId;
      let insertError = null;

      for (let attempt = 0; attempt < 5; attempt += 1) {
        orderId = generateOrderId();

        ({ error: insertError } = await supabase
          .from('orders')
          .insert({
            id: orderId,
            customer_name: order.name.trim(),
            phone_number: order.phone,
            address: order.address.trim(),
            city: order.city.trim(),
            payment_method: order.paymentMethod,
            customer_note: (order.note || '').trim(),
            order_status: 'In process',
            payment_status: 'In process',
            items,
            total_amount: total,
            screenshot_url: null,
            screenshot_path: screenshotPath
          }));

        // 23505 = unique_violation (order id collision): try a new id.
        if (!insertError || insertError.code !== '23505') break;
      }

      if (insertError) throw insertError;

      orderSaved = true;

      // Email failure must not undo a saved order.
      Promise.resolve()
        .then(async () => {
          let screenshotUrl = null;

          if (screenshotPath) {
            // Private bucket: a 7-day signed link for the client's inbox.
            const { data: signed, error: signError } = await supabase.storage
              .from(BUCKET)
              .createSignedUrl(screenshotPath, 7 * 24 * 60 * 60);

            if (signError) {
              console.error('Email screenshot link failed:', signError.message);
            } else {
              screenshotUrl = signed?.signedUrl || null;
            }
          }

          return screenshotUrl;
        })
        .then(screenshotUrl => sendOrderEmail({
          id: orderId,
          customer: {
            name: order.name.trim(),
            phone: order.phone,
            city: order.city.trim(),
            address: order.address.trim()
          },
          paymentMethod: order.paymentMethod,
          note: (order.note || '').trim(),
          items,
          total,
          screenshotUrl
        }))
        .catch(error => {
          console.error('Order email failed:', error.message);
        });

      return res.status(201).json({
        ok: true,
        orderId
      });

    } catch (error) {
      if (screenshotPath && !orderSaved) {
        const { error: cleanupError } = await supabase.storage
          .from(BUCKET)
          .remove([screenshotPath]);

        if (cleanupError) {
          console.error('Screenshot cleanup failed:', cleanupError.message);
        }
      }

      console.error('Order processing failed:', error.message);

      const clientErrors = [
        'Invalid order items.',
        'Invalid product or quantity.',
        'Invalid product size.',
        'Duplicate product IDs are not allowed.',
        'One or more products are unavailable.',
        'Invalid product price.',
        'Invalid order total.'
      ];

      if (
        clientErrors.includes(error.message) ||
        error.message.startsWith('Only JPEG') ||
        error.message.startsWith('Screenshot') ||
        error.message.startsWith('Invalid screenshot')
      ) {
        return res.status(400).json({
          ok: false,
          message: error.message
        });
      }

      return res.status(500).json({
        ok: false,
        message: 'Could not process your order.'
      });
    }
  }
);

// ADMIN AUTHENTICATION
async function requireAdmin(req, res, next) {
  try {
    const authorization = req.headers.authorization || '';
    const match = authorization.match(/^Bearer\s+(.+)$/i);

    if (!match) {
      return res.status(401).json({
        ok: false,
        message: 'Authentication required.'
      });
    }

    const { data, error } = await supabase.auth.getUser(match[1]);

    if (
      error ||
      !data.user ||
      data.user.app_metadata?.role !== 'admin'
    ) {
      return res.status(403).json({
        ok: false,
        message: 'Admin access denied.'
      });
    }

    req.admin = data.user;
    next();

  } catch (error) {
    return res.status(401).json({
      ok: false,
      message: 'Authentication failed.'
    });
  }
}

// ADMIN DASHBOARD
app.get(
  '/api/admin/dashboard',
  rateLimit(60, 60 * 1000),
  requireAdmin,
  async (req, res) => {
    try {
      const today = kathmanduDate(new Date());
      const dates = getLastThirtyDates(today);
      const startDate = getKathmanduMidnight(dates[0]).toISOString();

      const [
        orderResult,
        countResult
      ] = await Promise.all([
        supabase
          .from('orders')
          .select(`
            id,
            customer_name,
            phone_number,
            address,
            city,
            payment_method,
            customer_note,
            order_status,
            payment_status,
            items,
            total_amount,
            screenshot_path,
            created_at
          `)
          .gte('created_at', startDate)
          .order('created_at', { ascending: false })
          .limit(5000),

        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
      ]);

      if (orderResult.error) throw orderResult.error;
      if (countResult.error) throw countResult.error;

      const recentOrders = orderResult.data || [];
      const dailyRevenueMap = Object.fromEntries(
        dates.map(date => [date, 0])
      );

      const itemCounts = {};
      let todayRevenue = 0;
      let weeklyRevenue = 0;
      let monthlyRevenue = 0;

      for (const order of recentOrders) {
        // Both statuses must match before counting anything.
        if (!isCountableOrder(order)) continue;

        const date = kathmanduDate(new Date(order.created_at));
        const amount = Number(order.total_amount) || 0;

        if (Object.prototype.hasOwnProperty.call(dailyRevenueMap, date)) {
          dailyRevenueMap[date] += amount;
        }

        monthlyRevenue += amount;

        if (date === today) {
          todayRevenue += amount;
        }

        if (date >= shiftDate(today, -6) && date <= today) {
          weeklyRevenue += amount;
        }

        // Top-selling items also count only verified and completed orders.
        for (const item of order.items || []) {
          const name = item.name || item.id || 'Unknown item';

          itemCounts[name] =
            (itemCounts[name] || 0) + (Number(item.qty) || 0);
        }
      }

      // Return the latest 1000 orders for the dashboard table.
      const { data: tableOrders, error: tableError } = await supabase
        .from('orders')
        .select(`
          id,
          customer_name,
          phone_number,
          address,
          city,
          payment_method,
          customer_note,
          order_status,
          payment_status,
          items,
          total_amount,
          screenshot_path,
          created_at
        `)
        .order('created_at', { ascending: false })
        .limit(1000);

      if (tableError) throw tableError;

      // One batched call instead of one request per order.
      const paths = (tableOrders || [])
        .map(order => order.screenshot_path)
        .filter(Boolean);

      const signedByPath = new Map();

      if (paths.length) {
        const { data: signedList, error: signedError } = await supabase.storage
          .from(BUCKET)
          .createSignedUrls(paths, 300);

        if (signedError) {
          console.error('Screenshot URL error:', signedError.message);
        } else {
          for (const entry of signedList || []) {
            if (entry.signedUrl) signedByPath.set(entry.path, entry.signedUrl);
          }
        }
      }

      const dashboardOrders = (tableOrders || []).map(order => ({
        ...order,
        screenshot_signed_url:
          signedByPath.get(order.screenshot_path) || null
      }));

      const topItems = Object.entries(itemCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);

      return res.json({
        todayRevenue,
        weeklyRevenue,
        monthlyRevenue,
        totalOrders: countResult.count || 0,
        dates,
        dailyRevenue: dates.map(date => dailyRevenueMap[date]),
        topItemsLabels: topItems.map(item => item[0]),
        topItemsData: topItems.map(item => item[1]),
        orders: dashboardOrders
      });

    } catch (error) {
      console.error('Dashboard error:', error.message);

      return res.status(500).json({
        ok: false,
        message: 'Could not load dashboard.'
      });
    }
  }
);

// UPDATE PAYMENT STATUS
app.patch(
  '/api/admin/orders/:id/payment',
  rateLimit(60, 60 * 1000),
  requireAdmin,
  async (req, res) => {
    try {
      const allowedStatuses = [
        'In process',
        'Verified',
        'Rejected'
      ];

      const paymentStatus = req.body?.paymentStatus;

      if (!allowedStatuses.includes(paymentStatus)) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid payment status.'
        });
      }

      const { data, error } = await supabase
        .from('orders')
        .update({ payment_status: paymentStatus })
        .eq('id', req.params.id)
        .select('id, payment_status')
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({
          ok: false,
          message: 'Order not found.'
        });
      }

      return res.json({
        ok: true,
        order: data
      });

    } catch (error) {
      console.error('Payment status update failed:', error.message);

      return res.status(500).json({
        ok: false,
        message: 'Could not update payment status.'
      });
    }
  }
);

// UPDATE ORDER STATUS
app.patch(
  '/api/admin/orders/:id/status',
  rateLimit(60, 60 * 1000),
  requireAdmin,
  async (req, res) => {
    try {
      const allowedStatuses = [
        'In process',
        'Completed',
        'Returned'
      ];

      const orderStatus = req.body?.orderStatus;

      if (!allowedStatuses.includes(orderStatus)) {
        return res.status(400).json({
          ok: false,
          message: 'Invalid order status.'
        });
      }

      const { data, error } = await supabase
        .from('orders')
        .update({ order_status: orderStatus })
        .eq('id', req.params.id)
        .select('id, order_status')
        .maybeSingle();

      if (error) throw error;

      if (!data) {
        return res.status(404).json({
          ok: false,
          message: 'Order not found.'
        });
      }

      return res.json({
        ok: true,
        order: data
      });

    } catch (error) {
      console.error('Order status update failed:', error.message);

      return res.status(500).json({
        ok: false,
        message: 'Could not update order status.'
      });
    }
  }
);

// REQUEST ERROR HANDLER
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && error.status === 400) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid JSON request.'
    });
  }

  if (error.message === 'Origin not allowed') {
    return res.status(403).json({
      ok: false,
      message: 'Origin not allowed.'
    });
  }

  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      ok: false,
      message: 'Request is too large.'
    });
  }

  console.error('Request error:', error.message);

  return res.status(500).json({
    ok: false,
    message: 'Internal server error.'
  });
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`BASEIC backend listening on port ${PORT}`);
});
          
