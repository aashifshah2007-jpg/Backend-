const test = require('node:test');
const assert = require('node:assert/strict');
const { getVerifiedOrderItems } = require('../services/products');

// Minimal fake of supabase.from('products').select().in().eq()
const fake = (rows, error = null) => ({
  from: () => ({ select: () => ({ in: (_c, ids) => ({ eq: async () => ({
    data: rows.filter(r => ids.includes(r.id)), error }) }) }) })
});
const db = [{ id: 'h1', name: 'Hoodie', price: 2499 }, { id: 't1', name: 'Tee', price: 950 }];

test('uses database prices and ignores any price sent by the client', async () => {
  const r = await getVerifiedOrderItems(fake(db), [
    { id: 'h1', qty: 2, size: 'M', price: 1 }, { id: 't1', qty: 1, size: 'Free Size' }]);
  assert.equal(r.total, 2499 * 2 + 950);
  assert.equal(r.items[0].price, 2499);
});

test('rejects unknown/inactive products, bad qty, empty cart', async () => {
  await assert.rejects(getVerifiedOrderItems(fake(db), [{ id: 'zzz', qty: 1 }]), /unavailable/);
  await assert.rejects(getVerifiedOrderItems(fake(db), [{ id: 'h1', qty: 0 }]), /Invalid product or quantity/);
  await assert.rejects(getVerifiedOrderItems(fake(db), [{ id: 'h1', qty: 1.5 }]), /Invalid product or quantity/);
  await assert.rejects(getVerifiedOrderItems(fake(db), []), /Invalid order items/);
});
