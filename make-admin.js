
require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error('Missing Supabase environment variables.');
}

const supabaseAdmin = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
);

async function makeAdmin() {
  // Usage: node make-admin.js <auth-user-uuid>
  const userId = process.argv[2] || '';

  if (!/^[0-9a-f-]{36}$/i.test(userId)) {
    throw new Error('Usage: node make-admin.js <auth-user-uuid>');
  }

  const { data: userData, error: fetchError } =
    await supabaseAdmin.auth.admin.getUserById(userId);

  if (fetchError) throw fetchError;

  const { data, error } =
    await supabaseAdmin.auth.admin.updateUserById(userId, {
      app_metadata: {
        ...userData.user.app_metadata,
        role: 'admin'
      }
    });

  if (error) throw error;

  console.log('Admin role assigned successfully.');
  console.log('User ID:', data.user.id);
  console.log('App metadata:', data.user.app_metadata);
}

makeAdmin().catch(error => {
  console.error('Admin setup failed:', error.message);
  process.exitCode = 1;
});
