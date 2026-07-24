const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '../prisma');
const sharedDir = path.join(outDir, 'shared');
const modulesDir = path.join(outDir, 'modules');

// Combine in order: generator -> datasource -> enums -> modules
let content = '';
content += fs.readFileSync(path.join(sharedDir, 'generator.prisma'), 'utf8') + '\n\n';
content += fs.readFileSync(path.join(sharedDir, 'datasource.prisma'), 'utf8') + '\n\n';
content += fs.readFileSync(path.join(sharedDir, 'enums.prisma'), 'utf8') + '\n\n';

const files = fs.readdirSync(modulesDir).filter((f) => f.endsWith('.prisma'));

for (const file of files) {
  content += fs.readFileSync(path.join(modulesDir, file), 'utf8') + '\n\n';
}

fs.writeFileSync(path.join(outDir, 'schema.prisma'), content);
console.log('Merged ' + files.length + ' modules into schema.prisma successfully!');
