module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      ['auth', 'driver', 'ride', 'payment', 'notification', 'admin'],
    ],
    'header-max-length': [2, 'always', 100],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-case': [2, 'always', 'lower-case'],
  },
};
