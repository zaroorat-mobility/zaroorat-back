const fs = require('fs');
const path = require('path');
const strip = require('strip-comments');

function walk(dir) {
  let results = [];
  try {
    const list = fs.readdirSync(dir);
    list.forEach(function (file) {
      file = path.join(dir, file);
      const stat = fs.statSync(file);
      if (stat && stat.isDirectory()) {
        results = results.concat(walk(file));
      } else {
        if (file.endsWith('.ts')) results.push(file);
      }
    });
  } catch (err) {
    console.error(`Error reading directory ${dir}:`, err);
  }
  return results;
}

const targetDirs = [path.join(__dirname, '../src'), path.join(__dirname, '../tests')];

let totalFiles = 0;
let modifiedFiles = 0;

targetDirs.forEach((dir) => {
  const files = walk(dir);
  files.forEach((file) => {
    totalFiles++;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const stripped = strip(content);
      if (content !== stripped) {
        fs.writeFileSync(file, stripped, 'utf8');
        modifiedFiles++;
      }
    } catch (err) {
      console.error(`Error processing ${file}:`, err);
    }
  });
});

console.log(`Successfully processed ${totalFiles} files.`);
console.log(`Modified ${modifiedFiles} files.`);
