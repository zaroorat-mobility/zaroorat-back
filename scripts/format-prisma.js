const { execSync } = require('child_process');

try {
  console.log('✨ Formatting Prisma Schema...');
  execSync('npx prisma format', { stdio: 'inherit' });
  console.log('✅ Formatting complete!');
} catch {
  console.error('❌ Formatting failed.');
  process.exit(1);
}
