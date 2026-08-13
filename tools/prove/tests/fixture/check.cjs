const { add } = require('./target.cjs');

if (add(2, 3) === 5) {
  process.exit(0);
} else {
  console.error('check failed: add(2, 3) !== 5');
  process.exit(1);
}
