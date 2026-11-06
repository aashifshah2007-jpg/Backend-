
const { Resend } = require('resend');

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

async function sendOrderEmail(order) {
  if (!resend || !process.env.CLIENT_EMAIL) {
    console.warn(
      'Order email skipped: Resend or CLIENT_EMAIL is not configured.'
    );
    return;
  }

  const itemsHtml = order.items.map(item => `
    <li>
      ${escapeHtml(item.qty)} × ${escapeHtml(item.name)}
      ${item.size ? `(Size: ${escapeHtml(item.size)})` : ''}
      — NPR ${escapeHtml(
        (Number(item.price) * Number(item.qty)).toFixed(2)
      )}
    </li>
  `).join('');

  const { data, error } = await resend.emails.send({
    from: process.env.RESEND_FROM ||
      'BASEIC Store <onboarding@resend.dev>',
    to: [process.env.CLIENT_EMAIL],
    subject: `${order.id} - ${order.customer.name}`,
    html: `
      <h2>New BASEIC order</h2>

      <p><strong>Order ID:</strong> ${escapeHtml(order.id)}</p>

      <h3>Customer details</h3>
      <p><strong>Name:</strong> ${escapeHtml(order.customer.name)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(order.customer.phone)}</p>
      <p><strong>City:</strong> ${escapeHtml(order.customer.city)}</p>
      <p><strong>Address:</strong> ${escapeHtml(order.customer.address)}</p>

      <p>
        <strong>Payment method:</strong>
        ${escapeHtml(order.paymentMethod)}
      </p>

      <p><strong>Customer note:</strong> ${escapeHtml(order.note || 'None')}</p>

      <h3>Items</h3>
      <ul>${itemsHtml}</ul>

      <p>
        <strong>Total: NPR ${escapeHtml(
          Number(order.total).toFixed(2)
        )}</strong>
      </p>

      ${order.screenshotUrl
        ? `<p><strong>Payment screenshot:</strong>
            <a href="${escapeHtml(order.screenshotUrl)}">View screenshot</a>
            <br><small>Link expires in 7 days. Open the admin dashboard for later access.</small></p>`
        : ''}

      <p style="color:#666;font-size:12px">
        Please call the customer to confirm the order and total amount
        before shipping.
      </p>
    `
  });

  if (error) {
    throw new Error(error.message || 'Resend email failed.');
  }

  return data;
}

module.exports = { sendOrderEmail };
    
