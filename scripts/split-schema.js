const fs = require('fs');
const path = require('path');

const schemaStr = fs.readFileSync('prisma/schema.prisma', 'utf8');
const lines = schemaStr.split('\n');

const outDir = path.join(__dirname, '../prisma/modules');
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir, { recursive: true });
}

// Write the base config (datasource, generator) to base.prisma
const baseLines = [];
let i = 0;
while (i < lines.length && !lines[i].startsWith('// ============================ ENUMS')) {
  baseLines.push(lines[i]);
  i++;
}
fs.writeFileSync(path.join(outDir, 'base.prisma'), baseLines.join('\n').trim() + '\n\n');

const mappings = [
  { name: 'ENUMS', file: 'enums.prisma' },
  { name: 'IDENTITY', file: 'user.prisma' },
  { name: 'DRIVER', file: 'driver.prisma' },
  { name: 'VEHICLE', file: 'vehicle.prisma' },
  { name: 'RIDE', file: 'ride.prisma' },
  { name: 'PRICING', file: 'pricing.prisma' },
  { name: 'PAYMENT', file: 'payment.prisma' },
  { name: 'WALLET', file: 'wallet.prisma' },
  { name: 'NOTIFICATION', file: 'notification.prisma' },
  { name: 'CHAT', file: 'support.prisma' },
  { name: 'REVIEW', file: 'support.prisma' },
  { name: 'SUPPORT', file: 'support.prisma' },
  { name: 'REFERRAL', file: 'referral.prisma' },
  { name: 'PROMOTIONS', file: 'pricing.prisma' },
  { name: 'ADMIN', file: 'admin.prisma' },
  { name: 'ANALYTICS', file: 'analytics.prisma' },
  { name: 'SYSTEM', file: 'admin.prisma' },
];

let currentFile = null;
let currentContent = [];

for (; i < lines.length; i++) {
  const line = lines[i];
  const headerMatch = line.match(
    /^\/\/ ============================ (.*) ============================/,
  );

  if (headerMatch) {
    const sectionName = headerMatch[1].split(' ')[0]; // Handle "WALLET (operations)"

    // Save previous
    if (currentFile && currentContent.length > 0) {
      fs.appendFileSync(path.join(outDir, currentFile), currentContent.join('\n') + '\n\n');
      currentContent = [];
    }

    // Find new mapping
    const mapping = mappings.find((m) => m.name === sectionName);
    currentFile = mapping ? mapping.file : 'misc.prisma';
    currentContent.push(line);
  } else {
    if (currentFile) {
      currentContent.push(line);
    }
  }
}

// Save last
if (currentFile && currentContent.length > 0) {
  fs.appendFileSync(path.join(outDir, currentFile), currentContent.join('\n') + '\n');
}

console.log('Schema split into modules successfully!');
