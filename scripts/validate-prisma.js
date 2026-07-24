const { execSync } = require('child_process');

try {
  console.log('🔍 Validating Prisma Schema...');
  execSync('npx prisma validate', { stdio: 'inherit' });
  console.log('✅ Prisma Schema is valid!');
} catch {
  console.error('❌ Validation failed.');
  process.exit(1);
}
