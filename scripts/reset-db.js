const { execSync } = require('child_process');

try {
  console.log('🗑️  Resetting Prisma Database...');
  execSync('npx prisma migrate reset --force', { stdio: 'inherit' });
  console.log('✅ Database reset successfully!');
} catch {
  console.error('❌ Database reset failed.');
  process.exit(1);
}
