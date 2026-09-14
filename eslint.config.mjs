/**
 * Deliberately narrow: this exists to catch one bug class, not to enforce style.
 *
 * Twice now a refactor has left a function using a variable it no longer had in
 * scope -- `log` in the CLI, `profile` in the pull path. Both parsed fine, both
 * passed the whole unit suite, and the second one shipped and broke every pull
 * until an emulator test hit it. `no-undef` catches exactly that, statically.
 */
export default [
  { ignores: ['tray/out/**', 'tray/node_modules/**'] },
  {
    // The tray app's Electron main process: CommonJS.
    files: ['tray/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        console: 'writable',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['src/**/*.mjs', 'bin/**/*.js', 'scripts/**/*.mjs', 'plugins/**/*.mjs', 'shims/**/*.mjs', 'installer/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      // A variable left behind by a refactor is the same smell from the other side.
      'no-unused-vars': ['error', { args: 'none', varsIgnorePattern: '^_' }],
    },
  },
]
