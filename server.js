const express = require('express');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
const payments = new Map(); // Demo storage only; replace with a database before production.


function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}${String(d.getHours()).padStart(2,'0')}${String(d.getMinutes()).padStart(2,'0')}${String(d.getSeconds()).padStart(2,'0')}`;
}
function normalizePhone(input) {
  let phone = String(input || '').replace(/[\s+()-]/g, '');
  if (phone.startsWith('0')) phone = '254' + phone.slice(1);
  if (phone.startsWith('7') || phone.startsWith('1')) phone = '254' + phone;
  if (!/^254[17]\d{8}$/.test(phone)) throw new Error('Enter a valid Kenyan M-Pesa number, e.g. 0712345678.');
  return phone;
}
async function getAccessToken() {
  const key = process.env.DARAJA_CONSUMER_KEY;
  const secret = process.env.DARAJA_CONSUMER_SECRET;
  if (!key || !secret) throw new Error('Daraja Consumer Key/Secret are not configured in .env');
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const response = await fetch('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
    headers: { Authorization: `Basic ${auth}` }
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(data.error_description || data.errorMessage || 'Could not get Daraja access token.');
  return data.access_token;
}

app.post('/api/stkpush', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const amount = Math.round(Number(req.body.amount));
    if (!Number.isFinite(amount) || amount < 1) return res.status(400).json({ error: 'Amount must be at least KSh 1.' });
    if (amount > 150000) return res.status(400).json({ error: 'Amount exceeds the demo limit.' });

    const shortcode = process.env.DARAJA_SHORTCODE || '174379';
    const passkey = process.env.DARAJA_STK_PASSKEY;
    const callbackUrl = process.env.DARAJA_CALLBACK_URL;
    if (!passkey || !callbackUrl || !/^https:\/\//.test(callbackUrl)) {
      return res.status(500).json({ error: 'Configure the STK Passkey and public HTTPS callback URL in .env first.' });
    }
    const time = timestamp();
    const password = Buffer.from(`${shortcode}${passkey}${time}`).toString('base64');
    const token = await getAccessToken();
    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: time,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: phone,
      PartyB: shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: 'BrishaBoost',
      TransactionDesc: 'Social media service order'
    };
    const response = await fetch('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.CheckoutRequestID) {
      return res.status(502).json({ error: result.errorMessage || result.ResponseDescription || 'Safaricom STK Push request failed.' });
    }
    payments.set(result.CheckoutRequestID, { status: 'pending', amount, phone, createdAt: Date.now() });
    return res.json({ success: true, message: result.CustomerMessage || 'STK Push sent. Check your phone and enter your M-Pesa PIN.', checkoutRequestId: result.CheckoutRequestID });
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Unable to initiate payment.' });
  }
});


app.post('/api/callback', (req, res) => {
  // Safaricom expects an acknowledgement. In production, validate and persist callback data.
  const stk = req.body?.Body?.stkCallback;
  if (stk?.CheckoutRequestID) {
    const previous = payments.get(stk.CheckoutRequestID) || {};
    const successful = Number(stk.ResultCode) === 0;
    const metadata = stk.CallbackMetadata?.Item || [];
    const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
    payments.set(stk.CheckoutRequestID, {
      ...previous,
      status: successful ? 'paid' : 'failed',
      resultCode: stk.ResultCode,
      resultDescription: stk.ResultDesc,
      receipt: receipt || null,
      completedAt: Date.now()
    });
  }
  res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
});

app.get('/api/payment-status/:checkoutRequestId', (req, res) => {
  const payment = payments.get(req.params.checkoutRequestId);
  if (!payment) return res.status(404).json({ status: 'unknown' });
  res.json({ status: payment.status, receipt: payment.receipt || null, resultDescription: payment.resultDescription || null });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, mode: process.env.DARAJA_ENV || 'sandbox' }));
app.listen(PORT, () => console.log(`Brisha Social Boost payment server running on port ${PORT}`));
