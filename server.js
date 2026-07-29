const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const admin      = require('firebase-admin');
const path       = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

/* ── serve your HTML files from the parent folder ── */
app.use(express.static(path.join(__dirname, '..')));

/* ── Firebase Admin init ── */
const serviceAccount =  require('/etc/secrets/serviceAccountKey.json');;
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

const FLW_SECRET_KEY   = process.env.FLW_SECRET_KEY;
const FLW_WEBHOOK_HASH = process.env.FLW_WEBHOOK_HASH;

/* ══════════════════════════════════════════
   POST /api/create-virtual-account
   Called by frontend when user clicks
   "Generate Account"
══════════════════════════════════════════ */
app.post('/api/create-virtual-account', async (req, res) => {
  const { uid, email, parentName, credits, amount } = req.body;

  if (!uid || !email || !credits || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (credits < 500 || amount < 500) {
    return res.status(400).json({ error: 'Minimum is 500 credits / ₦500' });
  }
 /* Validate allowed packages (including bonus credits) */
const validPackages = {
  500: 500,
  1000: 1000,
  2500: 2550,
  5000: 5100,
};

if (!validPackages[amount]) {
  return res.status(400).json({ error: 'Invalid package' });
}

if (credits !== validPackages[amount]) {
  return res.status(400).json({ error: 'Invalid price' });
}

  const txRef     = `cgbaby_${uid.slice(0,8)}_${Date.now()}`;
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  try {
    const flwRes = await axios.post(
      'https://api.flutterwave.com/v3/virtual-account-numbers',
      {
        email,
        amount,
        tx_ref:       txRef,
        currency:     'NGN',
        narration:    `CG Baby Credits - ${parentName || email}`,
        is_permanent: false,
      },
      {
        headers: {
          Authorization:  `Bearer ${FLW_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = flwRes.data?.data;
    if (!data?.account_number) {
      console.error('FLW response:', flwRes.data);
      return res.status(502).json({ error: 'Flutterwave did not return account details' });
    }

    /* save pending payment to Firestore */
    await db.collection('payments').doc(txRef).set({
      txRef,
      uid,
      email,
      parentName:    parentName || '',
      credits,
      amount,
      status:        'pending',
      accountNumber: data.account_number,
      bankName:      data.bank_name,
      accountName:   data.account_name || 'CG PIXELS',
      flwRef:        data.flw_ref || '',
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      expiresAt:     new Date(expiresAt),
    });

    return res.json({
      success:       true,
      txRef,
      accountNumber: data.account_number,
      bankName:      data.bank_name,
      accountName:   data.account_name || 'CG PIXELS',
      expiresAt,
      amount,
      credits,
    });

  } catch (err) {
    console.error('create-virtual-account error:', err.response?.data || err.message);
    return res.status(500).json({
      error:  'Could not create virtual account. Please try again.',
      detail: err.response?.data?.message || err.message,
    });
  }
});

/* ══════════════════════════════════════════
   POST /api/flutterwave-webhook
   Flutterwave calls this when payment lands
   Set this URL in FLW Dashboard → Webhooks
══════════════════════════════════════════ */
app.post('/api/flutterwave-webhook', async (req, res) => {
  /* verify signature */
  const signature = req.headers['verif-hash'];
  if (!signature || signature !== FLW_WEBHOOK_HASH) {
    console.warn('Invalid webhook signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const event = req.body;
  console.log('FLW Webhook received:', JSON.stringify(event));

  if (event.event !== 'charge.completed' || event.data?.status !== 'successful') {
    return res.status(200).json({ received: true });
  }

  const txRef = event.data?.tx_ref;
  if (!txRef) return res.status(200).json({ received: true });

  try {
    /* verify with Flutterwave (anti-fraud) */
    const verify = await axios.get(
      `https://api.flutterwave.com/v3/transactions/${event.data.id}/verify`,
      { headers: { Authorization: `Bearer ${FLW_SECRET_KEY}` } }
    );

    const vData = verify.data?.data;
    if (!vData || vData.status !== 'successful') {
      console.warn('Transaction not verified:', txRef);
      return res.status(200).json({ received: true });
    }

    /* load payment doc */
    const payRef  = db.collection('payments').doc(txRef);
    const paySnap = await payRef.get();
    if (!paySnap.exists) {
      console.warn('Payment doc not found:', txRef);
      return res.status(200).json({ received: true });
    }

    const payData = paySnap.data();

    /* idempotency — don't double credit */
    if (payData.status === 'paid') {
      console.log('Already processed:', txRef);
      return res.status(200).json({ received: true });
    }

    /* amount check */
    if (Math.floor(vData.amount) < payData.amount) {
      console.warn(`Amount mismatch: expected ${payData.amount}, got ${vData.amount}`);
      await payRef.update({ status: 'amount_mismatch', paidAmount: vData.amount });
      return res.status(200).json({ received: true });
    }

    /* credit user + mark paid — atomic batch */
    const batch   = db.batch();
    const userRef = db.collection('users').doc(payData.uid);

    batch.update(userRef, {
      credits:            admin.firestore.FieldValue.increment(payData.credits),
      totalCreditsBought: admin.firestore.FieldValue.increment(payData.credits),
      updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(payRef, {
      status:           'paid',
      flwTransactionId: vData.id,
      flwRef:           vData.flw_ref,
      paidAt:           admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();
    console.log(`✅ Credited ${payData.credits} credits to user ${payData.uid}`);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
});

/* health check */
app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ CG Baby server running on port ${PORT}`));
