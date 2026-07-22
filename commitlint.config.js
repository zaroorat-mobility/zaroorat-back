module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        // Business domains
        'auth',
        'driver',
        'ride',
        'payment',
        'notification',
        'admin',

        // Cross-cutting application layers
        'core',
        'shared',
        'config',
        'db',
        'api',
        'logger',

        // Tooling & infrastructure
        'ci',
        'deps',
        'docker',
        'infra',
        'tooling',
        'structure',
        'release',
        'docs',
      ],
    ],
    'header-max-length': [2, 'always', 100],
    'scope-case': [2, 'always', 'lower-case'],
    'subject-case': [2, 'always', 'lower-case'],
  },
};
