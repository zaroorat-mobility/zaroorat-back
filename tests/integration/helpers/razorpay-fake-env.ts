/// Import FIRST in a test file that needs the Razorpay adapter: payment.config
/// reads these at module load. They are FAKE values for an in-process stub of
/// `fetch` (`stubRazorpayApi`); no request ever reaches Razorpay.
/// `.env.test` defines none of these keys, so its override does not undo them.
process.env.PAYMENT_DEFAULT_GATEWAY = 'razorpay';
process.env.RAZORPAY_ENVIRONMENT = 'sandbox';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fakeT040';
process.env.RAZORPAY_KEY_SECRET = 'fake-test-only-secret';
// payment.config refuses a Razorpay default without a webhook secret.
process.env.PAYMENT_WEBHOOK_SECRET = 'fake-test-only-webhook-secret';

export const FAKE_RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
export const FAKE_RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
