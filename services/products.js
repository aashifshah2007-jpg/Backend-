
async function getVerifiedOrderItems(supabase, requestedItems) {
  if (
    !Array.isArray(requestedItems) ||
    requestedItems.length === 0 ||
    requestedItems.length > 50
  ) {
    throw new Error('Invalid order items.');
  }

  for (const item of requestedItems) {
    if (
      !item ||
      typeof item !== 'object' ||
      Array.isArray(item) ||
      typeof item.id !== 'string' ||
      !item.id.trim() ||
      item.id.length > 100 ||
      !Number.isInteger(Number(item.qty)) ||
      Number(item.qty) < 1 ||
      Number(item.qty) > 100
    ) {
      throw new Error('Invalid product or quantity.');
    }

    if (
      item.size !== undefined &&
      (typeof item.size !== 'string' || item.size.length > 30)
    ) {
      throw new Error('Invalid product size.');
    }
  }

  const ids = [...new Set(requestedItems.map(item => item.id))];

  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, price')
    .in('id', ids)
    .eq('active', true);

  if (error) {
    console.error('Product lookup failed:', error.message);
    throw new Error('Could not retrieve product catalogue.');
  }

  if (!products || products.length !== ids.length) {
    throw new Error('One or more products are unavailable.');
  }

  const productMap = new Map(
    products.map(product => [product.id, product])
  );

  const verifiedItems = requestedItems.map(item => {
    const product = productMap.get(item.id);

    if (
      !product ||
      typeof product.name !== 'string' ||
      !Number.isFinite(Number(product.price)) ||
      Number(product.price) < 0
    ) {
      throw new Error('Invalid product price.');
    }

    return {
      id: product.id,
      name: product.name,
      qty: Number(item.qty),
      size: item.size || '',
      price: Number(product.price)
    };
  });

  const total = verifiedItems.reduce(
    (sum, item) => sum + item.price * item.qty,
    0
  );

  if (
    !Number.isFinite(total) ||
    total < 0 ||
    total > 100000000
  ) {
    throw new Error('Invalid order total.');
  }

  return {
    items: verifiedItems,
    total
  };
}

module.exports = { getVerifiedOrderItems };
